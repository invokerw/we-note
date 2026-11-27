use std::path::PathBuf;
use tauri::Manager;
use wenote_sync::{storage, Api};

#[tauri::command]
pub fn mac_storage_available() -> bool {
    cfg!(target_os = "macos")
}

#[tauri::command]
pub async fn choose_storage(app: tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let panel = objc2_app_kit::NSOpenPanel::openPanel(
                objc2::MainThreadMarker::new().expect("main thread"),
            );
            panel.setCanChooseFiles(false);
            panel.setCanChooseDirectories(true);
            panel.setCanCreateDirectories(true);
            let path = (panel.runModal() == 1)
                .then(|| panel.URL())
                .flatten()
                .and_then(|url| url.to_file_path());
            let _ = tx.send(path);
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("需要 macOS 文件夹选择器".into())
    }
}
#[tauri::command]
pub async fn account_location(
    app: tauri::AppHandle,
    owner: String,
    path: Option<PathBuf>,
    separate: Option<bool>,
) -> Result<PathBuf, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || match path {
        Some(path) => storage::bind(&data, &owner, &path, separate.unwrap_or(false)),
        None => storage::resolve(&data, &owner),
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
pub async fn account_vaults(
    origin: String,
    token: String,
    create: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api = Api::new(&origin, &token)?;
        if let Some(name) = create {
            return api.json(
                reqwest::Method::POST,
                "/api/v1/vaults",
                Some(serde_json::json!({"name":name})),
                None,
            );
        }
        api.vaults()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}
