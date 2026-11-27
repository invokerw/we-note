use std::fs;
use tempfile::tempdir;
use wenote_sync::storage::{bind, prepare, resolve};

#[test]
fn account_root_reuses_books_and_survives_relocation() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("Books");
    let data = tmp.path().join("data");
    fs::create_dir(&root).unwrap();
    let a = bind(&data, "alice", &root, false).unwrap();
    let work = prepare(&data, "alice", "v1", "工作").unwrap();
    let home = prepare(&data, "alice", "v2", "工作").unwrap();
    assert_ne!(work, home);
    assert_eq!(work.parent().unwrap(), a);
    assert_eq!(work, prepare(&data, "alice", "v1", "重命名").unwrap());
    assert!(bind(&data, "bob", &root, false).is_err());
    assert!(resolve(&data, "bob").is_err());
    assert!(bind(&data, "bob", &work, true).is_err());
    fs::write(work.join("草稿.md"), "保留").unwrap();
    let moved = tmp.path().join("Moved");
    fs::rename(&root, &moved).unwrap();
    assert!(resolve(&data, "alice").is_err());
    bind(&data, "alice", &moved, false).unwrap();
    assert_eq!(
        fs::read_to_string(
            prepare(&data, "alice", "v1", "工作")
                .unwrap()
                .join("草稿.md")
        )
        .unwrap(),
        "保留"
    );
}

#[test]
fn unknown_files_require_explicit_separate_folder() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("Documents");
    let data = tmp.path().join("data");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("private.md"), "personal").unwrap();
    assert!(bind(&data, "a", &root, false).is_err());
    let own = bind(&data, "a", &root, true).unwrap();
    assert_eq!(own.parent(), Some(root.canonicalize().unwrap().as_path()));
    assert!(!prepare(&data, "a", "v", "库")
        .unwrap()
        .join("private.md")
        .exists());
    assert!(prepare(&data, "a", "../escape", "库").is_err());
}

#[test]
fn legacy_offline_edits_survive_migration_and_move() {
    use wenote_sync::storage::{open_book, prepare_sync};
    let temp = tempdir().unwrap();
    let data = temp.path().join("state");
    let old = temp.path().join("old");
    let root = temp.path().join("managed");
    for path in [&data.join("v1"), &old, &root] {
        fs::create_dir_all(path).unwrap();
    }
    let binding = serde_json::json!({"origin":"https://local.test","vault":"v1","root":old.canonicalize().unwrap(),"device":"my-device","revision":12,"files":{}});
    fs::write(data.join("v1/state.json"), binding.to_string()).unwrap();
    fs::write(data.join("v1/lock"), "held by legacy sync").unwrap();
    fs::write(old.join("lock"), "普通笔记文件").unwrap();
    fs::write(old.join("未上传.md"), "最新离线修改").unwrap();
    bind(&data, "alice", &root, false).unwrap();
    let (folder, state) = prepare_sync(&data, "alice", "https://local.test", "v1", "工作").unwrap();
    assert_eq!(
        fs::read(folder.join("未上传.md")).unwrap(),
        fs::read(old.join("未上传.md")).unwrap()
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(state.join("state.json")).unwrap()).unwrap();
    assert_eq!(saved["revision"], 12);
    assert!(!state.join("lock").exists());
    assert_eq!(
        fs::read_to_string(folder.join("lock")).unwrap(),
        "普通笔记文件"
    );
    // Replay a journal interrupted between moving two top-level items.
    let pending = root.join(".tmp-test");
    fs::create_dir(&pending).unwrap();
    fs::write(pending.join("second.md"), "待迁移").unwrap();
    fs::write(
        state.join("migration.json"),
        serde_json::to_vec(std::ffi::OsStr::new(".tmp-test")).unwrap(),
    )
    .unwrap();
    assert!(open_book(&data, "alice", "v1").is_err());
    prepare_sync(&data, "alice", "https://local.test", "v1", "工作").unwrap();
    assert_eq!(
        fs::read_to_string(folder.join("second.md")).unwrap(),
        "待迁移"
    );
    assert!(!pending.exists());
    fs::write(folder.join("未上传.md"), "新位置的修改").unwrap();
    let moved = temp.path().join("moved");
    fs::rename(root, &moved).unwrap();
    bind(&data, "alice", &moved, false).unwrap();
    prepare_sync(&data, "alice", "https://local.test", "v1", "工作").unwrap();
    assert!(open_book(&data, "alice", "v1")
        .unwrap()
        .files()
        .unwrap()
        .contains(&"未上传.md".into()));
    assert_eq!(
        fs::read_to_string(old.join("未上传.md")).unwrap(),
        "最新离线修改"
    );
}

#[test]
#[ignore = "requires WENOTE_TEST_ORIGIN with registration enabled"]
fn sync_all_account_libraries_and_reopen_offline() -> anyhow::Result<()> {
    use reqwest::Method;
    use serde_json::json;
    use wenote_sync::{storage, synchronize, Api};
    let service = std::env::var("WENOTE_TEST_ORIGIN")?;
    let email = format!("{}@test.invalid", uuid::Uuid::new_v4());
    let credentials = json!({"email":email,"password":"storage acceptance"});
    Api::new(&service, "")?.json(
        Method::POST,
        "/api/v1/auth/register",
        Some(credentials),
        None,
    )?;
    let token = Api::login(&service, &email, "storage acceptance")?;
    let api = Api::new(&service, &token)?;
    let tmp = tempdir()?;
    let root = tmp.path().join("notebooks");
    let data = tmp.path().join("data");
    fs::create_dir(&root)?;
    storage::bind(&data, "user", &root, false)?;
    for name in ["工作", "生活"] {
        api.json(
            Method::POST,
            "/api/v1/vaults",
            Some(json!({"name":name})),
            None,
        )?;
    }
    let libraries = api.vaults()?;
    for vault in libraries["vaults"].as_array().unwrap() {
        let id = vault["id"].as_str().unwrap();
        let name = vault["name"].as_str().unwrap();
        let (book, state) = storage::prepare_sync(&data, "user", &service, id, name)?;
        fs::write(book.join("首页.md"), name)?;
        assert_eq!(
            synchronize(&service, &token, id, &book, &state)?.uploaded,
            1
        );
        assert!(storage::open_book(&data, "user", id)?
            .files()?
            .contains(&"首页.md".into()));
        assert!(storage::open_book(&data, "different", id).is_err());
    }
    Ok(())
}

#[test]
fn vault_names_are_portable_windows_directory_components() {
    let tmp = tempdir().unwrap();
    let root = tmp.path().join("books");
    let data = tmp.path().join("data");
    fs::create_dir(&root).unwrap();
    bind(&data, "alice", &root, false).unwrap();
    for (id, name) in [("v1", "项目：Q1 <草稿> | * ? \"a\""), ("v2", "CON.txt")] {
        let path = prepare(&data, "alice", id, name).unwrap();
        let component = path.file_name().unwrap().to_str().unwrap();
        assert!(!component.contains(['<', '>', '|', '*', '?', '"']));
        assert!(!component.to_uppercase().starts_with("CON."));
        assert_eq!(prepare(&data, "alice", id, "renamed").unwrap(), path);
    }
}
