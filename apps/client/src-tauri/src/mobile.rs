use jni::{
    objects::{JClass, JString},
    sys::jstring,
    JNIEnv,
};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::{
    plugin::{PluginHandle, TauriPlugin},
    Manager, Wry,
};
use wenote_sync::{synchronize_while, Api};
static JOB: AtomicI64 = AtomicI64::new(0);
#[no_mangle]
pub extern "system" fn Java_com_wenote_mobile_NativeSync_generation(
    _env: JNIEnv,
    _class: JClass,
    advance: jni::sys::jboolean,
) -> i64 {
    if advance != 0 {
        JOB.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        JOB.load(Ordering::SeqCst)
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("wenote-mobile")
        .setup(|app, api| {
            app.manage(api.register_android_plugin("com.wenote.mobile", "MobilePlugin")?);
            Ok(())
        })
        .build()
}

#[tauri::command]
pub async fn mobile_control(
    app: tauri::AppHandle,
    action: String,
    mut payload: Value,
) -> Result<Value, String> {
    if !matches!(
        action.as_str(),
        "restore" | "enable" | "disable" | "access" | "share" | "exportDocument"
    ) {
        return Err("未知移动端操作".into());
    }
    if action == "enable" {
        let vault = payload["vault"].as_str().ok_or("missing vault")?;
        let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let book =
            wenote_sync::notebook::Notebook::open(&data, vault).map_err(|e| e.to_string())?;
        if Some(book.origin()) != payload["origin"].as_str() {
            return Err("笔记库与服务地址不匹配".into());
        }
        payload["directory"] = json!(data);
    }
    app.state::<PluginHandle<Wry>>()
        .run_mobile_plugin_async(action, payload)
        .await
        .map_err(|e| e.to_string())
}

// JobScheduler can start a new process with no Activity or WebView.
#[no_mangle]
pub extern "system" fn Java_com_wenote_mobile_NativeSync_execute(
    mut env: JNIEnv,
    _class: JClass,
    action: JString,
    payload: JString,
) -> jstring {
    let run = || -> Result<String, String> {
        let action: String = env.get_string(&action).map_err(|e| e.to_string())?.into();
        let payload: String = env.get_string(&payload).map_err(|e| e.to_string())?.into();
        let args: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
        let field = |key: &str| args[key].as_str().ok_or_else(|| format!("missing {key}"));
        let origin = field("origin")?;
        let value = match action.as_str() {
            "refresh" => {
                let mut session =
                    Api::refresh(origin, field("refresh")?).map_err(|e| e.to_string())?;
                let expires = chrono::DateTime::parse_from_rfc3339(
                    session["expires_at"].as_str().ok_or("missing expiry")?,
                )
                .map_err(|e| e.to_string())?;
                session["expires_ms"] = json!(expires.timestamp_millis());
                session
            }
            "sync" => {
                let vault = field("vault")?;
                let dir = Path::new(field("directory")?);
                let job = args["job"].as_i64().ok_or("missing job")?;
                json!(synchronize_while(
                    origin,
                    field("token")?,
                    vault,
                    &dir.join("notebooks").join(vault),
                    &dir.join(vault),
                    || JOB.load(Ordering::SeqCst) == job
                )
                .map_err(|e| e.to_string())?)
            }
            _ => return Err("unknown job".into()),
        };
        Ok(value.to_string())
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(Ok(value)) => env
            .new_string(value)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut()),
        result => {
            let msg = result
                .ok()
                .and_then(Result::err)
                .unwrap_or_else(|| "sync failed".into());
            let _ = env.throw_new("java/lang/IllegalStateException", msg);
            std::ptr::null_mut()
        }
    }
}
