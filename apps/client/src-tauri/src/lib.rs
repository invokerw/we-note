#[cfg(target_os = "android")]
mod mobile;
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
    #[cfg(target_os = "android")]
    let root = {
        if !root.as_os_str().is_empty() {
            return Err("Android 使用应用私有笔记目录".into());
        }
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("notebooks")
            .join(&vault);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        root
    };
    tauri::async_runtime::spawn_blocking(move || {
        let report =
            synchronize(&origin, &token, &vault, &root, &dir).map_err(|e| e.to_string())?;
        wenote_sync::notebook::Notebook::remember_recent(
            dir.parent().ok_or("missing data directory")?,
            &vault,
        )
        .map_err(|e| e.to_string())?;
        Ok(report)
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
    UploadKey {
        slot: String,
        complete: Option<String>,
    },
    Transfer {
        token: String,
        request: wenote_sync::AssetTransfer,
    },
    CreateExport {
        token: String,
        scope: String,
        mode: Option<String>,
    },
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
    ReadBytes {
        path: String,
    },
    SaveBytes {
        path: String,
        base: Option<String>,
        data: String,
    },
    ExportBytes {
        name: String,
        data: String,
    },
    List,
    Library,
    ChangeEntry {
        operation: String,
        source: String,
        destination: String,
        expected: std::collections::BTreeMap<String, String>,
    },
    Read {
        path: String,
    },
    Save {
        path: String,
        base: Option<String>,
        text: String,
    },
    StageImage {
        name: String,
        media: String,
        data: String,
    },
    Image {
        url: String,
        token: String,
    },
    Upload {
        path: String,
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
        use base64::{engine::general_purpose::STANDARD, Engine};
        use LocalAction::*;
        match operation {
            UploadKey { slot, complete } => book.upload_key(&slot, complete.as_deref()),
            Transfer { token, request } => {
                Api::new(book.origin(), &token).and_then(|api| api.transfer(&vault, request))
            }
            CreateExport { token, scope, mode } => {
                book.create_export(&token, &scope, mode.as_deref())
            }
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
            ReadBytes { path } => book.read_bytes(&path),
            SaveBytes { path, base, data } => STANDARD
                .decode(data)
                .map_err(anyhow::Error::from)
                .and_then(|bytes| book.save_bytes(&path, base.as_deref(), &bytes))
                .map(serde_json::Value::String),
            ExportBytes { name, data } => {
                let dir = downloads.map_err(|e| e.to_string())?;
                STANDARD
                    .decode(data)
                    .map_err(anyhow::Error::from)
                    .and_then(|bytes| book.export_bytes(&dir, &name, &bytes))
                    .map(serde_json::Value::String)
            }
            Library => book.library().map(|v| serde_json::json!(v)),
            ChangeEntry {
                operation,
                source,
                destination,
                expected,
            } => book
                .change_entry(&operation, &source, &destination, &expected)
                .map(|_| serde_json::Value::Null),
            List => book.files().map(|v| serde_json::json!(v)),
            Read { path } => book.read(&path),
            Save { path, base, text } => book
                .save(&path, base.as_deref(), &text)
                .map(serde_json::Value::String),
            StageImage { name, media, data } => book
                .stage_image(&name, &media, &data)
                .map(serde_json::Value::String),
            Image { url, token } => book.image(&url, &token),
            Upload {
                path,
                name,
                media,
                data,
                token,
            } => book
                .upload(&token, &path, &name, &media, &data)
                .map(serde_json::Value::String),
        }
        .map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn encrypted_vault(
    origin: String,
    token: String,
    id: Option<String>,
    envelope: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Api::new(&origin, &token)
            .and_then(|api| api.encrypted_vault(id.as_deref(), envelope))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn export_decrypted_file(
    app: tauri::AppHandle,
    name: String,
    data: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
        wenote_sync::notebook::Notebook::export_download(&downloads, &name, &bytes)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn devices(
    origin: String,
    token: String,
    remove: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Api::new(&origin, &token)
            .and_then(|api| api.devices(remove.as_deref()))
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn recent_notebook(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    wenote_sync::notebook::Notebook::recent(&data).map_err(|e| e.to_string())
}
#[tauri::command]
fn print_note(webview: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        webview.print().map_err(|e| e.to_string())
    }
    #[cfg(mobile)]
    {
        let _ = webview;
        Err("请使用系统打印".into())
    }
}
#[tauri::command]
fn is_android() -> bool {
    cfg!(target_os = "android")
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile::plugin());
    builder
        .invoke_handler(tauri::generate_handler![
            login,
            refresh,
            logout,
            sync,
            notebook,
            encrypted_vault,
            export_decrypted_file,
            devices,
            is_android,
            print_note,
            recent_notebook,
            mobile::mobile_control
        ])
        .run(tauri::generate_context!())
        .expect("start WeNote");
}

#[cfg(not(target_os = "android"))]
mod mobile {
    #[tauri::command]
    pub fn mobile_control() -> Result<(), String> {
        Err("此操作需要 Android".into())
    }
}
