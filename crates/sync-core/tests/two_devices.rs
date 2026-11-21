use anyhow::{Context, Result};
use reqwest::Method;
use serde_json::json;
use std::fs;
use uuid::Uuid;
use wenote_sync::{synchronize, Api};

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
    let sync_a = || synchronize(&origin, &token, vault, &a, &temp.path().join("state-a"));
    let sync_b = || synchronize(&origin, &token, vault, &b, &temp.path().join("state-b"));
    let path = "daily/早安.md";
    let original = b"# title\r\n\r\none\r\ntwo\r\nthree\r\nfour\r\nfive\r\n";
    fs::write(a.join(path), original)?;
    fs::write(a.join("empty.txt"), b"")?;
    sync_a()?;
    sync_b()?;
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
    Ok(())
}
