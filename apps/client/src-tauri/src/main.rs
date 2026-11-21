#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::path::PathBuf;
use tauri::Manager;
use wenote_sync::{synchronize, Api, Report};
#[tauri::command]
async fn login(
    origin: String,
    email: String,
    password: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let session=Api::login_session(&origin,&email,&password).map_err(|e|e.to_string())?;let token=session["access_token"].as_str().ok_or("missing token")?;
        let api = Api::new(&origin, token).map_err(|e| e.to_string())?;
        let vaults = api.vaults().map_err(|e| e.to_string())?;
        Ok(serde_json::json!({"token":token,"refresh":session["refresh_token"],"expires":session["expires_at"],"vaults":vaults["vaults"]}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn sync(
    app: tauri::AppHandle,
    origin: String,
    token: String,
    vault: String,
    root: PathBuf,
) -> Result<Report, String> {
    if vault.is_empty()
        || !vault
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("invalid vault".into());
    };
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(&vault);
    tauri::async_runtime::spawn_blocking(move || {
        synchronize(&origin, &token, &vault, &root, &dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn refresh(origin: String, token: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Api::refresh(&origin, &token).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn logout(origin: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        Api::new(&origin, &token)
            .and_then(|api| api.logout())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum LocalAction {
    Catalog {
        token: String,
        route: String,
        scope: Option<String>,
    },
    Asset {
        id: String,
        token: String,
    },
    Download {
        id: String,
        kind: String,
        token: String,
    },
    FileId {
        path: String,
    },
    List,
    Read {
        path: String,
    },
    Save {
        path: String,
        base: Option<String>,
        text: String,
    },
    Image {
        url: String,
        token: String,
    },
    Upload {
        name: String,
        media: String,
        data: String,
        token: String,
    },
}
#[tauri::command]
async fn notebook(
    app: tauri::AppHandle,
    vault: String,
    session_origin: Option<String>,
    operation: LocalAction,
) -> Result<serde_json::Value, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let downloads = app.path().download_dir();
    tauri::async_runtime::spawn_blocking(move || {
        let book =
            wenote_sync::notebook::Notebook::open(&data, &vault).map_err(|e| format!("{e:#}"))?;
        if let Some(origin) = session_origin {
            if origin != book.origin() {
                return Err("请登录此笔记目录绑定的服务".into());
            }
        }
        use LocalAction::*;
        match operation {
            Catalog {
                token,
                route,
                scope,
            } => book.catalog(&token, &route, scope),
            Asset { id, token } => book.asset(&id, &token),
            Download { id, kind, token } => book
                .download(&downloads.map_err(|e| e.to_string())?, &token, &kind, &id)
                .map(serde_json::Value::String),
            FileId { path } => book.file_id(&path).map(|id| serde_json::json!(id)),
            List => book.files().map(|v| serde_json::json!(v)),
            Read { path } => book.read(&path),
            Save { path, base, text } => book
                .save(&path, base.as_deref(), &text)
                .map(serde_json::Value::String),
            Image { url, token } => book.image(&url, &token),
            Upload {
                name,
                media,
                data,
                token,
            } => book
                .upload(&token, &name, &media, &data)
                .map(serde_json::Value::String),
        }
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            login, refresh, logout, sync, notebook
        ])
        .run(tauri::generate_context!())
        .expect("start WeNote");
}
