use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, env, path::PathBuf, process::Stdio};
use tauri::{Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{oneshot, Mutex},
};

const PROTOCOL_VERSION: &str = "2025-06-18";
const PACKAGE: &str = "pi-web-access@0.48.0";

#[derive(Default)]
pub struct ManagerState {
    session: Mutex<Option<Session>>,
    cancellations: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

struct Session {
    signature: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Session {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("Web Access MCP 写入失败：{e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Web Access MCP 刷新失败：{e}"))?;
        loop {
            let mut line = String::new();
            let size = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| format!("Web Access MCP 读取失败：{e}"))?;
            if size == 0 {
                let status = self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .and_then(|status| status.code())
                    .map(|code| format!("，进程退出码 {code}"))
                    .unwrap_or_default();
                return Err(format!("Web Access MCP 进程已退出{status}"));
            }
            let value: Value = serde_json::from_str(line.trim())
                .map_err(|e| format!("Web Access MCP 返回无效 JSON：{e}"))?;
            if value.get("id").and_then(Value::as_u64) == Some(id) {
                return Ok(value);
            }
        }
    }

    async fn close(mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

fn config_signature(responses_url: &str, model: &str, api_key: &str) -> String {
    let key_hash = Sha256::digest(api_key.as_bytes());
    format!("{responses_url}\0{model}\0{key_hash:x}")
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("pi-web-access"))
        .map_err(|e| format!("无法获取 Web Access 配置目录：{e}"))
}

async fn write_config(
    app: &tauri::AppHandle,
    responses_url: &str,
    model: &str,
) -> Result<PathBuf, String> {
    let dir = config_dir(app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("无法创建 Web Access 配置目录：{e}"))?;
    let config = json!({
        "provider": "openai",
        "openaiResponsesUrl": responses_url,
        "openaiSearchModel": model,
        "openaiSearchProviders": [],
    });
    tokio::fs::write(
        dir.join("web-search.json"),
        serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| format!("无法写入 Web Access 配置：{e}"))?;
    Ok(dir)
}

fn command_from_environment() -> Option<Command> {
    let binary = env::var("WENOTE_PI_WEB_ACCESS_BIN")
        .ok()?
        .trim()
        .to_string();
    if binary.is_empty() {
        return None;
    }
    Some(Command::new(binary))
}

async fn spawn_process(
    app: &tauri::AppHandle,
    responses_url: &str,
    model: &str,
    api_key: &str,
) -> Result<Session, String> {
    let dir = write_config(app, responses_url, model).await?;
    let mut command =
        command_from_environment().unwrap_or_else(|| Command::new("pi-web-access-mcp"));
    command
        .env("PI_CODING_AGENT_DIR", &dir)
        .env("PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS", "false")
        .env_remove("OPENAI_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if !api_key.is_empty() {
        command.env("OPENAI_API_KEY", api_key);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(direct_error) if env::var("WENOTE_PI_WEB_ACCESS_BIN").is_err() => {
            let mut fallback = Command::new("npx");
            fallback
                .args(["-y", PACKAGE])
                .env("PI_CODING_AGENT_DIR", &dir)
                .env("PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS", "false")
                .env_remove("OPENAI_API_KEY")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            if !api_key.is_empty() {
                fallback.env("OPENAI_API_KEY", api_key);
            }
            fallback.spawn().map_err(|fallback_error| {
                format!(
                    "无法启动 pi-web-access-mcp：{direct_error}，npx fallback 也失败：{fallback_error}"
                )
            })?
        }
        Err(error) => return Err(format!("无法启动 pi-web-access-mcp：{error}")),
    };
    let stdin = child.stdin.take().ok_or("Web Access MCP 未提供 stdin")?;
    let stdout = child.stdout.take().ok_or("Web Access MCP 未提供 stdout")?;
    let mut session = Session {
        signature: config_signature(responses_url, model, api_key),
        stdin,
        stdout: BufReader::new(stdout),
        child,
        next_id: 1,
    };
    let init = session
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "wenote", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
    if init.get("error").is_some() {
        return Err(format!("Web Access MCP 初始化失败：{init}"));
    }
    let mut notification = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {},
    }))
    .map_err(|e| e.to_string())?;
    notification.push(b'\n');
    session
        .stdin
        .write_all(&notification)
        .await
        .map_err(|e| format!("Web Access MCP 初始化通知失败：{e}"))?;
    session
        .stdin
        .flush()
        .await
        .map_err(|e| format!("Web Access MCP 初始化刷新失败：{e}"))?;
    Ok(session)
}

#[tauri::command]
pub async fn web_access_request(
    app: tauri::AppHandle,
    state: State<'_, ManagerState>,
    request_id: String,
    responses_url: String,
    model: String,
    api_key: String,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if !matches!(method.as_str(), "tools/list" | "tools/call") {
        return Err("Web Access MCP 仅允许工具发现和工具调用".into());
    }
    let (cancel_tx, cancel_rx) = oneshot::channel();
    if state
        .cancellations
        .lock()
        .await
        .insert(request_id.clone(), cancel_tx)
        .is_some()
    {
        return Err("重复的 Web Access MCP 请求".into());
    }
    let result = async {
        let mut active = state.session.lock().await;
        let signature = config_signature(&responses_url, &model, &api_key);
        if active
            .as_ref()
            .is_some_and(|session| session.signature != signature)
        {
            if let Some(session) = active.take() {
                session.close().await;
            }
        }
        if active.is_none() {
            *active = Some(spawn_process(&app, &responses_url, &model, &api_key).await?);
        }
        tokio::select! {
            result = active.as_mut().expect("Web Access MCP session must exist").request(&method, params.unwrap_or_else(|| json!({}))) => result,
            _ = cancel_rx => {
                if let Some(session) = active.take() {
                    session.close().await;
                }
                Err("本轮已停止".into())
            }
        }
    }
    .await;
    state.cancellations.lock().await.remove(&request_id);
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            if let Some(session) = state.session.lock().await.take() {
                session.close().await;
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn web_access_cancel(
    request_id: String,
    state: State<'_, ManagerState>,
) -> Result<(), String> {
    if let Some(cancel) = state.cancellations.lock().await.remove(&request_id) {
        let _ = cancel.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn web_access_close(state: State<'_, ManagerState>) -> Result<(), String> {
    let cancellations = state
        .cancellations
        .lock()
        .await
        .drain()
        .map(|(_, cancel)| cancel)
        .collect::<Vec<_>>();
    for cancel in cancellations {
        let _ = cancel.send(());
    }
    if let Some(session) = state.session.lock().await.take() {
        session.close().await;
    }
    Ok(())
}
