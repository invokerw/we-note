use std::path::PathBuf;
use tauri::Manager;
use wenote_sync::{storage, Api};

#[tauri::command]
pub fn account_storage_available() -> bool {
    cfg!(any(target_os = "macos", windows))
}

#[tauri::command]
pub async fn choose_storage(window: tauri::Window) -> Result<Option<PathBuf>, String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
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
    #[cfg(windows)]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let parent = window.clone();
        window
            .run_on_main_thread(move || {
                let result = parent
                    .hwnd()
                    .map_err(|e| e.to_string())
                    .and_then(|hwnd| windows_folder(hwnd).map_err(|e| e.to_string()));
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = window;
        Err("当前平台未提供笔记库存储位置选择器".into())
    }
}
#[cfg(windows)]
fn windows_folder(
    parent: windows::Win32::Foundation::HWND,
) -> windows::core::Result<Option<PathBuf>> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::Win32::{
        Foundation::ERROR_CANCELLED,
        System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER},
        UI::Shell::{
            FileOpenDialog, IFileOpenDialog, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
            SIGDN_FILESYSPATH,
        },
    };
    // WebView2 initializes COM on the UI thread. Keep the dialog and shell
    // item on that thread and release the shell-allocated UTF-16 path there.
    unsafe {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)?;
        if let Err(error) = dialog.Show(Some(parent)) {
            if error.code() == ERROR_CANCELLED.to_hresult() {
                return Ok(None);
            }
            return Err(error);
        }
        let raw = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = OsString::from_wide(raw.as_wide());
        CoTaskMemFree(Some(raw.0.cast()));
        Ok(Some(path.into()))
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

#[cfg(all(test, windows))]
#[test]
fn windows_enters_account_storage_setup() {
    assert!(account_storage_available());
}
