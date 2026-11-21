mod api;
mod disk;
use anyhow::{bail, Context, Result};
pub use api::Api;
use api::{Receipt, Remote};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}
fn identifier(id: &str) -> Result<()> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("invalid resource id")
    };
    Ok(())
}
#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    path: String,
    version: String,
    hash: String,
}
#[derive(Serialize, Deserialize)]
struct Pending {
    method: String,
    route: String,
    key: String,
    body: serde_json::Value,
}
#[derive(Serialize, Deserialize)]
struct State {
    origin: String,
    vault: String,
    root: PathBuf,
    device: String,
    revision: u64,
    files: BTreeMap<String, Entry>,
    #[serde(default)]
    pending: Option<Pending>,
}
#[derive(Serialize, Default)]
pub struct Report {
    pub uploaded: usize,
    pub downloaded: usize,
    pub conflicts: Vec<String>,
    pub revision: u64,
}
struct Sync<'a> {
    api: &'a Api,
    root: &'a Path,
    state_dir: &'a Path,
    state: State,
    report: Report,
}
impl Sync<'_> {
    fn save(&self) -> Result<()> {
        disk::atomic(
            &self.state_dir.join("state.json"),
            &serde_json::to_vec(&self.state)?,
        )
    }
    fn remember(&mut self, id: String, entry: Entry) -> Result<()> {
        self.state.files.insert(id, entry);
        self.save()
    }
    fn send(
        &mut self,
        method: Method,
        suffix: &str,
        path: &str,
        base: Option<&Entry>,
        bytes: Option<&[u8]>,
    ) -> Result<()> {
        let mut body = json!({"device_id":self.state.device});
        if !path.is_empty() {
            body["path"] = json!(path)
        }
        if let Some(base) = base {
            body["base_version_id"] = json!(base.version);
            body["base_path"] = json!(base.path)
        }
        if let Some(bytes) = bytes {
            body["content"] = json!(STANDARD.encode(bytes))
        };
        let route = format!("/api/v1/vaults/{}/files{suffix}", self.state.vault);
        self.state.pending = Some(Pending {
            method: method.to_string(),
            route,
            key: Uuid::new_v4().to_string(),
            body,
        });
        self.save()?;
        self.flush()
    }
    fn flush(&mut self) -> Result<()> {
        let Some(op) = self.state.pending.as_ref() else {
            return Ok(());
        };
        let response = self.api.json(
            op.method.parse()?,
            &op.route,
            Some(op.body.clone()),
            Some(&op.key),
        );
        let receipt: Receipt = match response {
            Ok(value) => serde_json::from_value(value)?,
            Err(err) => {
                if err
                    .downcast_ref::<api::HttpError>()
                    .is_some_and(|e| matches!(e.0, 400 | 403 | 404 | 409 | 413))
                {
                    self.state.pending = None;
                    self.save()?;
                }
                return Err(err);
            }
        };
        if op.method == "DELETE" {
            self.state.files.remove(&receipt.file_id);
        } else {
            self.state.files.insert(
                receipt.file_id,
                Entry {
                    path: receipt.path,
                    version: receipt.version_id,
                    hash: receipt.content_hash,
                },
            );
        }
        self.report.uploaded += 1;
        self.state.pending = None;
        self.save()
    }
    fn content(&self, id: &str, entry: &Entry) -> Result<Vec<u8>> {
        self.api
            .version(&self.state.vault, id, &entry.version, &entry.hash)
    }
    fn keep_conflict(&mut self, path: &str, bytes: &[u8]) -> Result<()> {
        let copy = disk::conflict(self.root, path, bytes)?;
        self.report.conflicts.push(copy);
        Ok(())
    }
    fn recycle(&self, path: &str, expected: &str) -> Result<()> {
        let local = disk::local_path(self.root, path)?;
        let Some(data) = disk::current(&local)? else {
            return Ok(());
        };
        if digest(&data) != expected {
            bail!("本地文件已变化 {path}")
        };
        let dest = self
            .state_dir
            .join("trash")
            .join(Uuid::new_v4().to_string())
            .join(path);
        disk::atomic(&dest, &data)?;
        if disk::current(&local)?.as_deref() != Some(data.as_slice()) {
            bail!("本地文件已变化 {path}")
        };
        fs::remove_file(local)?;
        Ok(())
    }
    fn reconcile(
        &mut self,
        r: &Remote,
        local: &mut BTreeMap<String, String>,
        remote_paths: &BTreeSet<String>,
    ) -> Result<()> {
        identifier(&r.file_id)?;
        disk::relative(&r.path)?;
        let previous = self.state.files.get(&r.file_id).cloned();
        if r.is_deleted {
            if let Some(base) = previous {
                if let Some(hash) = local
                    .get(&base.path)
                    .filter(|_| !remote_paths.contains(&base.path))
                {
                    if hash != &base.hash {
                        let data = fs::read(disk::local_path(self.root, &base.path)?)?;
                        self.keep_conflict(&base.path, &data)?
                    };
                    self.recycle(&base.path, hash)?;
                    local.remove(&base.path);
                }
                self.state.files.remove(&r.file_id);
                self.save()?
            };
            return Ok(());
        }
        let remote = Entry {
            path: r.path.clone(),
            version: r
                .current_version_id
                .clone()
                .context("missing current version")?,
            hash: r.current_content_hash.clone(),
        };
        let Some(mut base) = previous else {
            let present = local.remove(&r.path);
            if present.as_deref() != Some(&remote.hash) {
                let bytes = self.content(&r.file_id, &remote)?;
                if present.is_some() {
                    let data = fs::read(disk::local_path(self.root, &r.path)?)?;
                    self.keep_conflict(&r.path, &data)?
                };
                disk::replace(self.root, &r.path, present.as_deref(), &bytes)?;
                self.report.downloaded += 1
            };
            return self.remember(r.file_id.clone(), remote);
        };
        // A casing-only move may resolve both spellings to one file on Windows and macOS.
        if base.path != r.path && base.path.to_lowercase() == r.path.to_lowercase() {
            let old = disk::local_path(self.root, &base.path)?;
            let new = disk::local_path(self.root, &r.path)?;
            if old.try_exists()? && new.try_exists()? && same_file::is_same_file(&old, &new)? {
                fs::rename(&old, &new)?;
                if let Some(hash) = local.remove(&base.path) {
                    local.insert(r.path.clone(), hash);
                }
                base.path = r.path.clone();
                self.remember(r.file_id.clone(), base.clone())?;
            }
        }
        if base.path != r.path {
            let previous_hash = local.remove(&base.path);
            let new_hash = local.remove(&r.path);
            let remote_bytes = self.content(&r.file_id, &remote)?;
            if let Some(current) = new_hash.as_ref() {
                if current != &remote.hash {
                    self.keep_conflict(&r.path, &fs::read(disk::local_path(self.root, &r.path)?)?)?
                }
            };
            disk::replace(self.root, &r.path, new_hash.as_deref(), &remote_bytes)?;
            if let Some(hash) = previous_hash {
                if hash != base.hash {
                    self.keep_conflict(
                        &base.path,
                        &fs::read(disk::local_path(self.root, &base.path)?)?,
                    )?
                };
                if !remote_paths.contains(&base.path) {
                    self.recycle(&base.path, &hash)?
                }
            };
            self.report.downloaded += 1;
            return self.remember(r.file_id.clone(), remote);
        }
        let Some(hash) = local.remove(&base.path) else {
            let old_path = disk::local_path(self.root, &base.path)?;
            if remote.hash != base.hash || remote.version != base.version {
                let bytes = self.content(&r.file_id, &remote)?;
                disk::replace(self.root, &r.path, None, &bytes)?;
                self.report.downloaded += 1;
                return self.remember(r.file_id.clone(), remote);
            };
            let candidates: Vec<String> = local
                .iter()
                .filter(|(p, h)| {
                    *h == &base.hash
                        && !remote_paths.contains(*p)
                        && !self.state.files.values().any(|e| &e.path == *p)
                })
                .map(|(p, _)| p.clone())
                .collect();
            if candidates.len() == 1 {
                let path = &candidates[0];
                self.send(
                    Method::PATCH,
                    &format!("/{}", r.file_id),
                    path,
                    Some(&base),
                    None,
                )?;
                local.remove(path);
                return Ok(());
            };
            if old_path.exists() {
                bail!("本地路径仍存在，暂缓远端删除 {}", base.path)
            }
            self.send(
                Method::DELETE,
                &format!("/{}", r.file_id),
                "",
                Some(&base),
                None,
            )?;
            return Ok(());
        };
        if hash == remote.hash && base.version == remote.version {
            return Ok(());
        };
        if hash == remote.hash {
            return self.remember(r.file_id.clone(), remote);
        };
        if hash == base.hash {
            let data = self.content(&r.file_id, &remote)?;
            disk::replace(self.root, &r.path, Some(&hash), &data)?;
            self.report.downloaded += 1;
            return self.remember(r.file_id.clone(), remote);
        };
        let mut data = fs::read(disk::local_path(self.root, &r.path)?)?;
        if digest(&data) != hash {
            bail!("文件在扫描后已修改")
        };
        if remote.hash != base.hash {
            let theirs = self.content(&r.file_id, &remote)?;
            let ancestor = self.content(&r.file_id, &base)?;
            match diffy::merge_bytes(&ancestor, &data, &theirs) {
                Ok(merged) => {
                    disk::replace(self.root, &r.path, Some(&hash), &merged)?;
                    data = merged
                }
                Err(_) => {
                    self.keep_conflict(&r.path, &data)?;
                    disk::replace(self.root, &r.path, Some(&hash), &theirs)?;
                    return self.remember(r.file_id.clone(), remote);
                }
            }
        };
        self.send(
            Method::PUT,
            &format!("/{}/content", r.file_id),
            "",
            Some(&remote),
            Some(&data),
        )
    }
}

pub fn synchronize(
    origin: &str,
    token: &str,
    vault: &str,
    root: &Path,
    state_dir: &Path,
) -> Result<Report> {
    identifier(vault)?;
    let root = root.canonicalize().context("打开本地目录")?;
    if !root.is_dir() {
        bail!("请选择已有目录")
    };
    fs::create_dir_all(state_dir)?;
    let state_dir = state_dir.canonicalize()?;
    if state_dir.starts_with(&root) || root.starts_with(&state_dir) {
        bail!("同步状态目录与笔记目录必须相互独立")
    };
    let lock = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(state_dir.join("lock"))?;
    lock.try_lock_exclusive()
        .context("另一个同步任务正在运行")?;
    let api = Api::new(origin, token)?;
    let state: State = match disk::current(&state_dir.join("state.json"))? {
        Some(bytes) => serde_json::from_slice(&bytes)?,
        None => State {
            origin: origin.into(),
            vault: vault.into(),
            root: root.clone(),
            device: api.device()?,
            revision: 0,
            files: BTreeMap::new(),
            pending: None,
        },
    };
    if state.origin != origin || state.vault != vault || state.root != root {
        bail!("已有状态绑定到另一个 Vault 或目录")
    };
    let mut sync = Sync {
        api: &api,
        root: &root,
        state_dir: &state_dir,
        state,
        report: Report::default(),
    };
    sync.flush()?;
    sync.save()?;
    let mut local = disk::scan(&root)?;
    let manifest = api.manifest(vault, &sync.state.device)?;
    let paths: BTreeSet<_> = manifest
        .files
        .iter()
        .filter(|r| !r.is_deleted)
        .map(|r| r.path.clone())
        .collect();
    for remote in &manifest.files {
        sync.reconcile(remote, &mut local, &paths)?
    }
    for (path, hash) in local {
        let bytes = fs::read(disk::local_path(&root, &path)?)?;
        if digest(&bytes) != hash {
            bail!("文件在扫描后已修改 {path}")
        };
        sync.send(Method::POST, "", &path, None, Some(&bytes))?;
    }
    sync.state.revision = manifest.snapshot_revision;
    sync.report.revision = manifest.snapshot_revision;
    sync.save()?;
    Ok(sync.report)
}
