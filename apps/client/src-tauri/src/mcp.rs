//! A loopback transport for the currently open notebook. Editing and scope checks live in the client host.
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::{oneshot, Semaphore};

#[derive(Default)]
pub struct Transport(Mutex<HashMap<String, Connection>>);
struct Connection {
    stop: oneshot::Sender<()>,
    state: Arc<Endpoint>,
}
struct Endpoint {
    authority: String,
    generation: String,
    token_hash: String,
    channel: Channel<Packet>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    counter: AtomicU64,
    slots: Semaphore,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Packet {
    generation: String,
    sequence: u64,
    message: Value,
}
fn permitted(headers: &HeaderMap, authority: &str, hash: &str) -> Result<(), StatusCode> {
    if headers.get("host").and_then(|v| v.to_str().ok()) != Some(authority) {
        return Err(StatusCode::FORBIDDEN);
    }
    if let Some(origin) = headers.get("origin") {
        if origin.to_str().ok() != Some(&format!("http://{authority}")) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if format!("sha256:{:x}", Sha256::digest(token.as_bytes())) != hash {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if let Some(v) = headers.get("mcp-protocol-version") {
        if v != "2025-11-25" {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    Ok(())
}
async fn handle(State(state): State<Arc<Endpoint>>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(status) = permitted(&headers, &state.authority, &state.token_hash) {
        return status.into_response();
    }
    let Ok(_permit) = state.slots.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Ok(message) = serde_json::from_slice(&body) else {
        return (StatusCode::BAD_REQUEST,Json(serde_json::json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Invalid JSON"}}))).into_response();
    };
    let sequence = state.counter.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(sequence, tx);
    let sent = state.channel.send(Packet {
        generation: state.generation.clone(),
        sequence,
        message,
    });
    let result = if sent.is_ok() {
        tokio::time::timeout(Duration::from_secs(60), rx)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    state.pending.lock().unwrap().remove(&sequence);
    match result {
        Some(Value::Null) => StatusCode::ACCEPTED.into_response(),
        Some(value) => Json(value).into_response(),
        None => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
#[tauri::command]
pub async fn mcp_open(
    transport: tauri::State<'_, Transport>,
    generation: String,
    token_hash: String,
    port: u16,
    channel: Channel<Packet>,
) -> Result<String, String> {
    if cfg!(mobile) {
        return Err("该平台使用应用内 MCP 入口".into());
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| e.to_string())?;
    let authority = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let state = Arc::new(Endpoint {
        authority: authority.clone(),
        generation: generation.clone(),
        token_hash,
        channel,
        pending: Mutex::new(HashMap::new()),
        counter: AtomicU64::new(1),
        slots: Semaphore::new(16),
    });
    let (stop, done) = oneshot::channel();
    let app = Router::new()
        .route("/mcp", post(handle))
        .layer(DefaultBodyLimit::max(2 << 20))
        .with_state(state.clone());
    transport
        .0
        .lock()
        .unwrap()
        .insert(generation, Connection { stop, state });
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = done.await;
            })
            .await;
    });
    Ok(format!("http://{authority}/mcp"))
}
#[tauri::command]
pub fn mcp_close(transport: tauri::State<'_, Transport>, generation: String) {
    let mut slot = transport.0.lock().unwrap();
    if let Some(c) = slot.remove(&generation) {
        let _ = c.stop.send(());
        c.state.pending.lock().unwrap().clear();
    }
}
#[tauri::command]
pub fn mcp_reply(
    transport: tauri::State<'_, Transport>,
    generation: String,
    sequence: u64,
    result: Value,
) {
    let slot = transport.0.lock().unwrap();
    if let Some(c) = slot.get(&generation) {
        if let Some(tx) = c.state.pending.lock().unwrap().remove(&sequence) {
            let _ = tx.send(result);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_requires_credential_and_valid_origin() {
        let mut h = HeaderMap::new();
        h.insert("host", "127.0.0.1:8970".parse().unwrap());
        let hash = format!("sha256:{:x}", Sha256::digest(b"secret"));
        assert_eq!(
            permitted(&h, "127.0.0.1:8970", &hash),
            Err(StatusCode::UNAUTHORIZED)
        );
        h.insert("authorization", "Bearer secret".parse().unwrap());
        assert!(permitted(&h, "127.0.0.1:8970", &hash).is_ok());
        h.insert("origin", "https://untrusted.invalid".parse().unwrap());
        assert_eq!(
            permitted(&h, "127.0.0.1:8970", &hash),
            Err(StatusCode::FORBIDDEN)
        );
    }
}
