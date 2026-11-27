use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::Method;
use serde_json::json;
use std::fs;
use uuid::Uuid;
use wenote_sync::{notebook::Notebook, synchronize, Api};

// Run against a disposable, freshly started WeNote server using the acceptance script.
#[test]
#[ignore = "requires a running API; run tests/e2e/desktop.mjs"]
fn two_devices_and_web_converge() -> Result<()> {
    let origin = std::env::var("WENOTE_TEST_ORIGIN")?;
    let email = format!("{}@test.invalid", Uuid::new_v4());
    let password = "sync test password";
    let guest = Api::new(&origin, "")?;
    guest.json(
        Method::POST,
        "/api/v1/auth/register",
        Some(json!({"email":email,"password":password})),
        None,
    )?;
    let token = Api::login(&origin, &email, password)?;
    let api = Api::new(&origin, &token)?;
    let v = api.json(
        Method::POST,
        "/api/v1/vaults",
        Some(json!({"name":"Acceptance"})),
        None,
    )?;
    let vault = v["id"].as_str().context("vault id")?;
    let temp = tempfile::tempdir()?;
    let a = temp.path().join("Mac");
    let b = temp.path().join("Windows");
    fs::create_dir_all(a.join("daily"))?;
    fs::create_dir(&b)?;
    let state_root = temp.path().join("state-a");
    let sync_a = || synchronize(&origin, &token, vault, &a, &state_root.join(vault));
    let state_b = temp.path().join("state-b");
    let sync_b = || synchronize(&origin, &token, vault, &b, &state_b.join(vault));
    let path = "daily/早安.md";
    let original = b"# title\r\n\r\none\r\ntwo\r\nthree\r\nfour\r\nfive\r\n";
    fs::write(a.join(path), original)?;
    fs::write(a.join("empty.txt"), b"")?;
    fs::write(a.join("data.csv"), b"a,b\r\n1,2\r\n")?;
    fs::write(a.join("README"), b"plain text")?;
    sync_a()?;
    sync_b()?;
    assert_eq!(fs::read(b.join("data.csv"))?, b"a,b\r\n1,2\r\n");
    assert_eq!(fs::read(b.join("README"))?, b"plain text");
    fs::write(b.join("data.csv"), b"updated")?;
    sync_b()?;
    sync_a()?;
    assert_eq!(fs::read(a.join("data.csv"))?, b"updated");
    assert_eq!(fs::read(b.join(path))?, original);
    assert_eq!(fs::metadata(b.join("empty.txt"))?.len(), 0);
    fs::write(
        a.join(path),
        String::from_utf8(original.to_vec())?.replace("one", "FIRST"),
    )?;
    fs::write(
        b.join(path),
        String::from_utf8(original.to_vec())?.replace("five", "LAST"),
    )?;
    sync_a()?;
    assert!(sync_b()?.conflicts.is_empty());
    sync_a()?;
    let merged = fs::read_to_string(a.join(path))?;
    assert!(merged.contains("FIRST") && merged.contains("LAST"));
    assert_eq!(merged, fs::read_to_string(b.join(path))?);
    fs::write(a.join(path), "# mac\n")?;
    fs::write(b.join(path), "# pc\n")?;
    sync_a()?;
    let conflicts = sync_b()?.conflicts;
    assert_eq!(conflicts.len(), 1);
    assert_eq!(fs::read_to_string(b.join(&conflicts[0]))?, "# pc\n");
    sync_b()?;
    sync_a()?;
    assert_eq!(fs::read_to_string(a.join(&conflicts[0]))?, "# pc\n");
    fs::rename(a.join(path), a.join("daily/moved.md"))?;
    sync_a()?;
    sync_b()?;
    assert!(!b.join(path).exists());
    assert_eq!(fs::read_to_string(b.join("daily/moved.md"))?, "# mac\n");
    let files = api.json(
        Method::GET,
        &format!("/api/v1/vaults/{vault}/files"),
        None,
        None,
    )?;
    let f = files["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "daily/moved.md")
        .unwrap();
    let id = f["file_id"].as_str().unwrap();
    let base = f["current_version_id"].as_str().unwrap();
    let route = format!("/api/v1/vaults/{vault}/files/{id}");
    let update = api.json(
        Method::PUT,
        &format!("{route}/content"),
        Some(json!({"base_version_id":base,"content":"V2ViCg=="})),
        None,
    )?;
    sync_a()?;
    sync_b()?;
    assert_eq!(fs::read(b.join("daily/moved.md"))?, b"Web\n");
    fs::remove_file(b.join("daily/moved.md"))?;
    sync_b()?;
    sync_a()?;
    assert!(!a.join("daily/moved.md").exists());
    api.json(
        Method::POST,
        &format!("{route}/restore"),
        Some(json!({"base_version_id":update["version_id"]})),
        None,
    )?;
    sync_a()?;
    sync_b()?;
    assert_eq!(fs::read(a.join("daily/moved.md"))?, b"Web\n");
    assert_eq!(sync_a()?.uploaded, 0);
    // Both names stay occupied in the final manifest, but the IDs trade paths while B is offline.
    fs::write(a.join("first.md"), "first original")?;
    fs::write(a.join("second.md"), "second original")?;
    sync_a()?;
    sync_b()?;
    fs::write(b.join("first.md"), "offline edit to first")?;
    for (old, new) in [
        ("first.md", "temporary.md"),
        ("second.md", "first.md"),
        ("temporary.md", "second.md"),
    ] {
        fs::rename(a.join(old), a.join(new))?;
        sync_a()?;
    }
    let result = sync_b()?;
    assert_eq!(
        result.conflicts.len(),
        1,
        "only the offline edit needs preservation"
    );
    assert_eq!(
        fs::read_to_string(b.join(&result.conflicts[0]))?,
        "offline edit to first"
    );
    assert_eq!(fs::read_to_string(b.join("first.md"))?, "second original");
    assert_eq!(fs::read_to_string(b.join("second.md"))?, "first original");
    sync_b()?;
    sync_a()?;
    assert_eq!(
        fs::read_to_string(a.join(&result.conflicts[0]))?,
        "offline edit to first"
    );
    assert_eq!(sync_b()?.uploaded, 0);
    // The native editor reopens an existing binding without a session, then syncs its raw bytes.
    let book = Notebook::open(&state_root, vault)?;
    let note = "notes/离线笔记.md";
    let raw = "\u{feff}# 本地编辑\r\n\r\n离线保存\r\n";
    let hash = book.save(note, None, raw)?;
    assert_eq!(book.read(note)?["text"], raw);
    assert!(book.files()?.contains(&note.to_string()));
    assert!(book.save("../outside.md", None, "bad").is_err());
    fs::write(a.join(note), format!("{raw}本地外部修改\r\n"))?;
    assert!(book.save(note, Some(&hash), "stale").is_err());
    sync_a()?;
    sync_b()?;
    assert_eq!(fs::read(b.join(note))?, fs::read(a.join(note))?);
    let matches = book.catalog(&token, "/search?q=离线保存", None)?;
    assert_eq!(matches[0]["file_id"], book.file_id(note)?.unwrap());
    // These disjoint edits would merge cleanly as lines, but a workbook is an opaque archive.
    let map = "maps/roadmap.XMind";
    let original = b"PK\xff\nbase\nfirst\nsecond\nlast\n";
    let first = b"PK\xff\nbase\nA\nsecond\nlast\n";
    let second = b"PK\xff\nbase\nfirst\nsecond\nB\n";
    let map_hash = book.save_bytes(map, None, original)?;
    sync_a()?;
    sync_b()?;
    assert_eq!(fs::read(b.join(map))?, original);
    book.save_bytes(map, Some(&map_hash), first)?;
    fs::write(b.join(map), second)?;
    sync_a()?;
    let copies = sync_b()?.conflicts;
    assert_eq!(copies.len(), 1);
    assert_eq!(fs::read(b.join(map))?, first);
    assert_eq!(fs::read(b.join(&copies[0]))?, second);
    sync_b()?;
    sync_a()?;
    assert_eq!(fs::read(a.join(&copies[0]))?, second);
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOmSuJkAAAAASUVORK5CYII=";
    let draft_path = "offline-image.md";
    let temporary_url = book.stage_image("offline.png", "image/png", png)?;
    assert_eq!(book.image(&temporary_url, "")?["data"], png);
    book.save(draft_path, None, &format!("![offline]({temporary_url})"))?;
    sync_a()?;
    sync_b()?;
    let final_note = fs::read_to_string(b.join(draft_path))?;
    assert!(!final_note.contains("wenote-draft.invalid"));
    assert!(final_note.contains(&format!("/{vault}/")));
    assert_eq!(fs::read_to_string(a.join(draft_path))?, final_note);
    // An existing note must also publish an image staged while offline.
    let before_edit = book.read(draft_path)?;
    let edited = format!("edited\n![offline]({temporary_url})");
    book.save(draft_path, before_edit["hash"].as_str(), &edited)?;
    // Losing access to staged bytes must leave the note intact and retryable.
    let cache_dir = state_root.join(vault).join("asset-cache");
    let hidden = state_root.join(vault).join("cache-unavailable");
    fs::rename(&cache_dir, &hidden)?;
    assert!(sync_a().is_err());
    assert_eq!(fs::read_to_string(a.join(draft_path))?, edited);
    fs::rename(hidden, cache_dir)?;
    sync_a()?;
    sync_b()?;
    let received = fs::read_to_string(b.join(draft_path))?;
    let received_url = received
        .trim_end_matches(')')
        .split("![offline](")
        .last()
        .unwrap();
    assert!(
        !received_url.contains("wenote-draft.invalid"),
        "existing note still uses a draft image"
    );
    assert_eq!(
        Notebook::open(&state_b, vault)?.image(received_url, &token)?["data"],
        png
    );
    let url = book.upload(&token, note, "tiny.png", "image/png", png)?;
    assert_eq!(url.rsplit('/').next().unwrap().len(), 16);
    assert_eq!(
        Notebook::open(&state_b, vault)?.image(&url, &token)?["data"],
        png
    );
    assert_eq!(book.image(&url, "")?["data"], png);
    let assets = book.catalog(&token, "/assets", None)?;
    let id = assets
        .as_array()
        .context("asset list")?
        .iter()
        .find(|asset| asset["canonical_url"] == url && asset["name"] == "tiny.png")
        .and_then(|asset| asset["asset_id"].as_str())
        .context("uploaded asset ID")?;
    assert_eq!(book.asset(id, &token)?["data"], png);
    let dir = temp.path().join("downloads");
    let downloaded = book.download(&dir, &token, "asset", id)?;
    assert_eq!(fs::read(downloaded)?, STANDARD.decode(png)?);
    let second = book.download(&dir, &token, "asset", id)?;
    assert!(second.ends_with("tiny (1).png"));
    let job = book.catalog(&token, "/exports", Some("all".into()))?;
    let job_id = job["job_id"].as_str().context("export ID")?;
    let mut ready = false;
    for _ in 0..100 {
        let jobs = book.catalog(&token, "/exports", None)?;
        if jobs[0]["status"] == "completed" {
            ready = true;
            break;
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(ready);
    let zip = book.download(&dir, &token, "export", job_id)?;
    assert!(fs::read(zip)?.starts_with(b"PK"));
    let export = book.create_export(&token, "all", Some("portable"))?;
    let job_id = export["job_id"].as_str().context("portable export id")?;
    for _ in 0..100 {
        let jobs = book.catalog(&token, "/exports", None)?;
        if jobs
            .as_array()
            .context("jobs")?
            .iter()
            .any(|j| j["job_id"] == job_id && j["status"] == "completed")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let archive = fs::read(book.download(&dir, &token, "export", job_id)?)?;
    let upload = Uuid::new_v4();
    let half = archive.len() / 2;
    book.import_chunk(&token, upload, 0, &STANDARD.encode(&archive[..half]), false)
        .context("stage first portable ZIP chunk")?;
    assert!(book.import_chunk(&token, upload, 0, "", false).is_err());
    let wrong_offset = book.import_chunk(&token, upload, half as u64 + 1, "", false);
    assert_eq!(wrong_offset.unwrap_err().to_string(), "导入分片位置不匹配");
    let preview = book.import_chunk(
        &token,
        upload,
        half as u64,
        &STANDARD.encode(&archive[half..]),
        true,
    )?;
    let id = preview["id"].as_str().context("import id")?;
    let folder = preview["folder"].as_str().context("conflict folder")?;
    assert!(!folder.is_empty());
    assert_eq!(
        book.import_action(&token, id, Some(folder.into()))?["status"],
        "completed"
    );
    sync_b()?;
    assert_eq!(fs::read(b.join(folder).join("README"))?, b"plain text");
    Ok(())
}

#[test]
#[ignore = "requires a running API; run tests/e2e/desktop.mjs"]
fn missing_merge_base_preserves_both_edits() -> Result<()> {
    let origin = std::env::var("WENOTE_TEST_ORIGIN")?;
    let email = format!("{}@test.invalid", Uuid::new_v4());
    let password = "sync test password";
    let guest = Api::new(&origin, "")?;
    guest.json(
        Method::POST,
        "/api/v1/auth/register",
        Some(json!({"email":email,"password":password})),
        None,
    )?;
    let token = Api::login(&origin, &email, password)?;
    let api = Api::new(&origin, &token)?;
    let v = api.json(
        Method::POST,
        "/api/v1/vaults",
        Some(json!({"name":"Acceptance"})),
        None,
    )?;
    let vault = v["id"].as_str().context("vault id")?;
    let temp = tempfile::tempdir()?;
    let a = temp.path().join("Mac");
    let b = temp.path().join("Windows");
    fs::create_dir_all(a.join("daily"))?;
    fs::create_dir(&b)?;
    let state_root = temp.path().join("state-a");
    let sync_a = || synchronize(&origin, &token, vault, &a, &state_root.join(vault));
    let state_b = temp.path().join("state-b");
    let sync_b = || synchronize(&origin, &token, vault, &b, &state_b.join(vault));
    let path = "edited.md";
    fs::write(a.join(path), "common ancestor")?;
    sync_a()?;
    sync_b()?;
    // Model an expired version receipt without waiting for the minute-based cleanup worker.
    let state_path = state_b.join(vault).join("state.json");
    let mut state: serde_json::Value = serde_json::from_slice(&fs::read(&state_path)?)?;
    let entry = state["files"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    entry["version"] = json!("expired-version");
    fs::write(state_path, serde_json::to_vec(&state)?)?;
    fs::write(a.join(path), "remote changes")?;
    fs::write(b.join(path), "local changes")?;
    fs::write(b.join("other.md"), "unrelated")?;
    sync_a()?;
    let conflicts = sync_b()?.conflicts;
    assert_eq!(conflicts.len(), 1);
    assert_eq!(fs::read(b.join(&conflicts[0]))?, b"local changes");
    assert_eq!(fs::read(b.join(path))?, b"remote changes");
    assert!(sync_b()?.conflicts.is_empty());
    sync_a()?;
    assert_eq!(fs::read(a.join("other.md"))?, b"unrelated");
    assert_eq!(fs::read(a.join(&conflicts[0]))?, b"local changes");
    let book = Notebook::open(&state_b, vault)?;
    let pending = book.conflicts()?;
    assert_eq!(pending.get(&conflicts[0]).map(String::as_str), Some(path));
    let local_hash = book.read(&conflicts[0])?["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    let remote_hash = book.read(path)?["hash"].as_str().unwrap().to_owned();
    assert!(book
        .resolve_conflict(&conflicts[0], "stale", &local_hash, "merged", "combined")
        .is_err());
    assert_eq!(book.conflicts()?, pending);
    book.resolve_conflict(
        &conflicts[0],
        &remote_hash,
        &local_hash,
        "merged",
        "combined",
    )?;
    assert!(book.conflicts()?.is_empty());
    assert_eq!(fs::read(b.join(path))?, b"combined");
    assert_eq!(fs::read(b.join(&conflicts[0]))?, b"local changes");
    Ok(())
}
