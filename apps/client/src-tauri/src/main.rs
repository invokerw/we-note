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
fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![login, refresh, logout, sync])
        .run(tauri::generate_context!())
        .expect("start WeNote");
}
