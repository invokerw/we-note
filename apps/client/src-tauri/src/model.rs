use reqwest::{redirect::Policy, Client, Url};
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{ipc::Channel, State};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct Requests(Mutex<HashMap<String, oneshot::Sender<()>>>);
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Event {
    Headers { status: u16, content: String },
    Data { bytes: Vec<u8> },
    End,
}

#[tauri::command]
pub async fn model_stream(
    id: String,
    url: String,
    key: String,
    body: String,
    channel: Channel<Event>,
    requests: State<'_, Requests>,
) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path().ends_with("/chat/completions") || url.path().ends_with("/responses"))
    {
        return Err("模型地址无效".into());
    }
    let (tx, rx) = oneshot::channel();
    {
        let mut active = requests.0.lock().map_err(|_| "请求锁不可用")?;
        if active.contains_key(&id) {
            return Err("重复请求".into());
        }
        active.insert(id.clone(), tx);
    }
    let transfer = forward(url, key, body, channel);
    let result =
        tokio::select! { r=transfer=>r.map_err(|e|e.to_string()), _=rx=>Err("请求已停止".into()) };
    requests.0.lock().map_err(|_| "请求锁不可用")?.remove(&id);
    result
}
#[tauri::command]
pub fn model_cancel(id: String, requests: State<'_, Requests>) {
    if let Ok(mut active) = requests.0.lock() {
        if let Some(tx) = active.remove(&id) {
            let _ = tx.send(());
        }
    }
}

async fn forward(
    url: Url,
    key: String,
    body: String,
    channel: Channel<Event>,
) -> anyhow::Result<()> {
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .build()?;
    let mut request = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .body(body);
    if !key.is_empty() {
        request = request.bearer_auth(key)
    }
    let mut res = request.send().await?;
    channel.send(Event::Headers {
        status: res.status().as_u16(),
        content: res
            .headers()
            .get("content-type")
            .and_then(|x| x.to_str().ok())
            .unwrap_or("")
            .into(),
    })?;
    while let Some(chunk) = res.chunk().await? {
        channel.send(Event::Data {
            bytes: chunk.to_vec(),
        })?;
    }
    channel.send(Event::End)?;
    Ok::<(), anyhow::Error>(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, routing::post, Router};
    use serde_json::Value;
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;
    #[tokio::test]
    async fn native_model_streams_headers_utf8_and_end_in_order() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = Url::parse(&format!(
            "http://{}/v1/responses",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let app = Router::new().route(
            "/v1/responses",
            post(|headers: HeaderMap, body: String| async move {
                assert_eq!(headers["authorization"], "Bearer test-only");
                assert_eq!(body, "{}");
                ([("content-type", "text/event-stream")], "data: 周报\n\n")
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let channel = Channel::new(move |packet| {
            let InvokeResponseBody::Json(json) = packet else {
                panic!("expected JSON")
            };
            received
                .lock()
                .unwrap()
                .push(serde_json::from_str::<Value>(&json).unwrap());
            Ok(())
        });
        forward(url, "test-only".into(), "{}".into(), channel)
            .await
            .unwrap();
        server.abort();
        let events = events.lock().unwrap();
        assert_eq!(events.first().unwrap()["status"], 200);
        assert_eq!(events.last().unwrap()["type"], "end");
        let bytes: Vec<u8> = events
            .iter()
            .filter_map(|e| e["bytes"].as_array())
            .flatten()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(String::from_utf8(bytes).unwrap(), "data: 周报\n\n");
    }
}
