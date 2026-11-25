use super::{api::Api, digest, disk, identifier, State};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;

pub(crate) const DRAFT_PREFIX: &str = "https://wenote-draft.invalid/assets/";

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct TrashedFile {
    pub external: bool,
    pub batch: uuid::Uuid,
    pub path: String,
}

/// Local editor operations are restricted to a folder previously bound by the sync engine.
pub struct Notebook {
    state_dir: PathBuf,
    root: PathBuf,
    origin: String,
    vault: String,
}
impl Notebook {
    pub fn open(data: &Path, vault: &str) -> Result<Self> {
        identifier(vault)?;
        let state_dir = data.join(vault);
        let binding: State = serde_json::from_slice(
            &fs::read(state_dir.join("state.json")).context("请先同步一次以绑定本地目录")?,
        )?;
        if binding.vault != vault || binding.root.canonicalize()? != binding.root {
            bail!("笔记目录绑定已变更")
        };
        Ok(Self {
            state_dir,
            root: binding.root,
            origin: binding.origin,
            vault: vault.into(),
        })
    }
    pub fn remember_recent(data: &Path, vault: &str) -> Result<()> {
        identifier(vault)?;
        disk::atomic(&data.join("recent-vault"), vault.as_bytes())
    }
    pub fn recent(data: &Path) -> Result<Option<Value>> {
        let Some(bytes) = disk::current(&data.join("recent-vault"))? else {
            return Ok(None);
        };
        let vault = std::str::from_utf8(&bytes)?;
        let book = Self::open(data, vault)?;
        Ok(Some(json!({"vault":vault,"origin":book.origin()})))
    }
    pub fn upload_key(&self, slot: &str, complete: Option<&str>) -> Result<Value> {
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.state_dir.join("upload.lock"))?;
        lock.lock_exclusive()?;
        let path = self
            .state_dir
            .join("pending-attachments")
            .join(&digest(slot.as_bytes())[7..]);
        let prior = disk::current(&path)?;
        if let Some(key) = complete {
            if prior.as_deref() == Some(key.as_bytes()) {
                fs::remove_file(path)?;
            }
            return Ok(Value::Null);
        }
        if let Some(bytes) = prior {
            return Ok(json!(String::from_utf8(bytes)?));
        }
        let key = uuid::Uuid::new_v4().to_string();
        disk::atomic(&path, key.as_bytes())?;
        Ok(json!(key))
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn files(&self) -> Result<Vec<String>> {
        Ok(self.library()?.into_keys().collect())
    }
    pub fn library(&self) -> Result<BTreeMap<String, String>> {
        disk::scan(&self.root)
    }

    fn trash_root(&self, external: bool) -> Result<Option<PathBuf>> {
        let mut dir = if external {
            self.root.clone()
        } else {
            self.state_dir.clone()
        };
        let parts: &[&str] = if external {
            &[".wenote", "trash"]
        } else {
            &["trash"]
        };
        for part in parts {
            dir.push(part);
            match fs::symlink_metadata(&dir) {
                Ok(meta) if meta.is_dir() => (),
                Ok(_) => bail!("无效的本地回收站"),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            }
        }
        Ok(Some(dir))
    }
    pub fn trash_files(&self) -> Result<Vec<TrashedFile>> {
        let mut files = Vec::new();
        for external in [false, true] {
            let Some(root) = self.trash_root(external)? else {
                continue;
            };
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                let Ok(batch) = uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()) else {
                    continue;
                };
                if !entry.file_type()?.is_dir() {
                    continue;
                }
                let dir = entry.path();
                if let Some(folder) = Self::trashed_folder(&dir)? {
                    if disk::local_path(&dir, &folder)?.is_dir() {
                        files.push(TrashedFile {
                            external,
                            batch,
                            path: format!("{folder}/"),
                        });
                    }
                    continue;
                }
                for file in walkdir::WalkDir::new(&dir) {
                    let file = file?;
                    if !file.file_type().is_file() {
                        continue;
                    }
                    let path = file
                        .path()
                        .strip_prefix(&dir)?
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    if self.path(&path).is_ok() {
                        files.push(TrashedFile {
                            external,
                            batch,
                            path,
                        });
                    }
                }
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path).then(a.batch.cmp(&b.batch)));
        Ok(files)
    }
    fn trashed_folder(batch: &Path) -> Result<Option<String>> {
        let meta = batch.join(".wenote");
        match fs::symlink_metadata(&meta) {
            Ok(m) if m.is_file() && m.len() <= 2048 => {
                let name = fs::read_to_string(meta)?;
                disk::relative(&name)?;
                Ok(Some(name))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => bail!("无效的回收站目录记录"),
        }
    }
    fn trashed_path(&self, item: &TrashedFile) -> Result<PathBuf> {
        let root = self
            .trash_root(item.external)?
            .context("回收站项目不存在")?;
        let batch = disk::local_path(&root, &item.batch.to_string())?;
        let name = item.path.trim_end_matches('/');
        let source = disk::local_path(&batch, name)?;
        if item.path.ends_with('/') {
            if Self::trashed_folder(&batch)?.as_deref() != Some(name) || !source.is_dir() {
                bail!("无效的回收站目录")
            }
        } else {
            self.path(name)?;
            if !source.is_file() {
                bail!("回收站笔记不存在")
            }
        }
        Ok(source)
    }
    pub fn read_trash(&self, item: &TrashedFile) -> Result<Value> {
        let path = self.trashed_path(item)?;
        if !path.is_file() || path.metadata()?.len() > 16 << 20 {
            bail!("无法预览此项目")
        }
        Ok(json!(STANDARD.encode(fs::read(path)?)))
    }
    fn trash_lock(&self) -> Result<fs::File> {
        let lock = fs::OpenOptions::new()
            .write(true)
            .open(self.state_dir.join("lock"))?;
        lock.try_lock_exclusive().context("正在同步，请稍后重试")?;
        Ok(lock)
    }
    pub fn purge_trash(&self, item: &TrashedFile) -> Result<()> {
        let _lock = self.trash_lock()?;
        let source = self.trashed_path(item)?;
        if item.path.ends_with('/') {
            fs::remove_dir_all(source)?;
        } else {
            fs::remove_file(source)?;
        }
        Ok(())
    }
    pub fn restore_file(&self, item: &TrashedFile) -> Result<()> {
        let _lock = self.trash_lock()?;
        let source = self.trashed_path(item)?;
        let dest = disk::local_path(&self.root, item.path.trim_end_matches('/'))?;
        if dest.try_exists()? {
            bail!("原位置已有同名文件，请先移动或重命名它")
        }
        let parent = dest.parent().context("无效的恢复路径")?;
        fs::create_dir_all(parent)?;
        if item.path.ends_with('/') {
            fs::rename(source, dest)?;
            return Ok(());
        }
        let mut input = fs::File::open(&source)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        std::io::copy(&mut input, &mut tmp)?;
        tmp.as_file().sync_all()?;
        tmp.persist_noclobber(dest)?;
        fs::remove_file(source)?;
        Ok(())
    }

    pub fn change_entry(
        &self,
        operation: &str,
        source: &str,
        destination: &str,
        expected: &BTreeMap<String, String>,
    ) -> Result<()> {
        let lock = fs::OpenOptions::new()
            .write(true)
            .open(self.state_dir.join("lock"))?;
        lock.try_lock_exclusive().context("正在同步，请稍后重试")?;
        let folder = source.ends_with('/');
        let name = source.strip_suffix('/').unwrap_or(source);
        let from = if folder {
            disk::local_path(&self.root, name)?
        } else {
            self.path(name)?
        };
        let files = self.library()?;
        let selected: BTreeMap<_, _> = files
            .iter()
            .filter(|(p, _)| *p == source || (folder && p.starts_with(source)))
            .map(|(p, h)| (p.clone(), h.clone()))
            .collect();
        if selected.is_empty() || &selected != expected {
            bail!("目录内容已更改，请刷新后重试")
        }
        if folder {
            // Moving or recycling a directory must never take unrelated files with it.
            for item in walkdir::WalkDir::new(&from) {
                let item = item?;
                let relative = item
                    .path()
                    .strip_prefix(&self.root)?
                    .to_str()
                    .context("无效的路径")?
                    .replace(std::path::MAIN_SEPARATOR, "/")
                    .nfc()
                    .collect::<String>();
                if !item.file_type().is_dir()
                    && (!item.file_type().is_file() || !selected.contains_key(&relative))
                {
                    bail!("文件夹含其他文件或符号链接，请先移出这些项目")
                }
                if item.file_name().eq_ignore_ascii_case(".wenote")
                    || item.file_name().eq_ignore_ascii_case(".git")
                {
                    bail!("文件夹含受保护的目录")
                }
            }
        }
        let trash_batch = uuid::Uuid::new_v4().to_string();
        let to = match operation {
            "delete" => self.state_dir.join("trash").join(&trash_batch).join(name),
            "move" | "copy" => {
                let dest = destination.strip_suffix('/').unwrap_or(destination);
                if folder != destination.ends_with('/')
                    || (folder
                        && destination
                            .to_lowercase()
                            .starts_with(&source.to_lowercase()))
                {
                    bail!("无效的目标路径")
                }
                let path = if folder {
                    disk::local_path(&self.root, dest)?
                } else {
                    self.path(dest)?
                };
                let key = dest.to_lowercase();
                if path.try_exists()?
                    || files.keys().any(|p| {
                        let p = p.to_lowercase();
                        p == key
                            || p.starts_with(&(key.clone() + "/"))
                            || key.starts_with(&(p + "/"))
                    })
                {
                    bail!("目标位置已存在同名项目")
                }
                path
            }
            _ => bail!("未知的目录操作"),
        };
        let parent = to.parent().context("无效的目标位置")?;
        fs::create_dir_all(parent)?;
        if operation == "delete" && folder {
            disk::atomic(
                &self
                    .state_dir
                    .join("trash")
                    .join(&trash_batch)
                    .join(".wenote"),
                name.as_bytes(),
            )?;
        }
        if operation != "copy" {
            match fs::rename(&from, &to) {
                Ok(()) => return Ok(()),
                Err(err)
                    if operation == "delete"
                        && err.kind() == std::io::ErrorKind::CrossesDevices =>
                {
                    // An external-volume notebook needs a same-volume trash for an atomic move.
                    let mut trash = self.root.clone();
                    for part in [".wenote", "trash"] {
                        trash.push(part);
                        if !trash.try_exists()? {
                            fs::create_dir(&trash)?;
                        }
                        if !fs::symlink_metadata(&trash)?.file_type().is_dir() {
                            bail!("无效的本地回收站")
                        }
                    }
                    let batch = trash.join(&trash_batch);
                    let location = batch.join(name);
                    fs::create_dir_all(location.parent().context("无效的回收站路径")?)?;
                    if folder {
                        disk::atomic(&batch.join(".wenote"), name.as_bytes())?;
                    }
                    fs::rename(from, location)?;
                    return Ok(());
                }
                Err(err) => return Err(err.into()),
            }
        }
        // Publish the copy only after all files have been read and verified.
        let staging = tempfile::tempdir_in(parent)?;
        let staged = staging.path().join("entry");
        for (path, hash) in &selected {
            let bytes = fs::read(self.path(path)?)?;
            if digest(&bytes) != *hash {
                bail!("文件已更改，请刷新后重试")
            }
            let dest = if folder {
                staged.join(path.strip_prefix(source).context("无效的源路径")?)
            } else {
                staged.clone()
            };
            disk::atomic(&dest, &bytes)?;
        }
        fs::rename(&staged, &to)?;
        Ok(())
    }
    fn path(&self, path: &str) -> Result<PathBuf> {
        if !matches!(
            Path::new(path)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "md" | "txt" | "json" | "xmind"
        ) {
            bail!("请选择 Markdown、TXT、JSON 或 XMind 笔记")
        };
        disk::local_path(&self.root, path)
    }
    pub fn search_notes(&self, query: &str, paths: &[String]) -> Result<Vec<String>> {
        let term = query.trim().to_lowercase();
        let mut matches = Vec::new();
        if term.is_empty() {
            return Ok(matches);
        }
        for path in paths {
            if path.to_lowercase().ends_with(".xmind") {
                continue;
            }
            let location = self.path(path)?;
            match fs::metadata(&location) {
                Ok(meta) if meta.is_file() && meta.len() <= 16 << 20 => (),
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
            match fs::read_to_string(location) {
                Ok(text) if text.to_lowercase().contains(&term) => matches.push(path.clone()),
                Ok(_) => (),
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::InvalidData | std::io::ErrorKind::NotFound
                    ) =>
                {
                    ()
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(matches)
    }
    pub fn read(&self, path: &str) -> Result<Value> {
        let dest = self.path(path)?;
        if fs::metadata(&dest)?.len() > 16 << 20 {
            bail!("笔记超过 16 MiB")
        };
        let raw = fs::read_to_string(dest)?;
        Ok(json!({"hash":digest(raw.as_bytes()),"text":raw}))
    }
    pub fn save(&self, path: &str, base: Option<&str>, text: &str) -> Result<String> {
        self.save_bytes(path, base, text.as_bytes())
    }
    pub fn read_bytes(&self, path: &str) -> Result<Value> {
        let path = self.path(path)?;
        if fs::metadata(&path)?.len() > 16 << 20 {
            bail!("笔记超过 16 MiB")
        }
        let bytes = fs::read(path)?;
        Ok(json!({"hash":digest(&bytes),"data":STANDARD.encode(bytes)}))
    }
    pub fn save_bytes(&self, path: &str, base: Option<&str>, bytes: &[u8]) -> Result<String> {
        if bytes.len() > 16 << 20 {
            bail!("笔记超过 16 MiB")
        };
        self.path(path)?;
        let lock = fs::OpenOptions::new()
            .write(true)
            .open(self.state_dir.join("lock"))?;
        lock.try_lock_exclusive().context("正在同步，请稍后保存")?;
        disk::replace(&self.root, path, base, bytes)
            .context("文件已被修改或移动，请保留草稿并重新打开笔记")?;
        Ok(digest(bytes))
    }
    fn cache(&self) -> PathBuf {
        self.state_dir.join("asset-cache")
    }
    fn remember_asset(&self, url: &str, media: &str, bytes: &[u8]) -> Result<()> {
        let cache = self.cache().join(&digest(url.as_bytes())[7..]);
        disk::atomic(&cache.join("bytes"), bytes)?;
        disk::atomic(&cache.join("type"), media.as_bytes())
    }
    pub fn stage_image(&self, name: &str, media: &str, encoded: &str) -> Result<String> {
        if !matches!(
            media,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) || name.is_empty()
        {
            bail!("请选择支持的图片")
        }
        let data = STANDARD.decode(encoded)?;
        if data.len() > 256 << 20 {
            bail!("图片超过 256 MiB")
        }
        let url = format!("{}{}", DRAFT_PREFIX, &digest(&data)[7..]);
        self.remember_asset(&url, media, &data)?;
        disk::atomic(
            &self.cache().join(&digest(url.as_bytes())[7..]).join("name"),
            name.as_bytes(),
        )?;
        Ok(url)
    }
    pub fn image(&self, url: &str, token: &str) -> Result<Value> {
        let cache = self.cache().join(&digest(url.as_bytes())[7..]);
        if cache.join("type").is_file() {
            return Ok(
                json!({"type":fs::read_to_string(cache.join("type"))?,"data":STANDARD.encode(fs::read(cache.join("bytes"))?)}),
            );
        };
        if url.starts_with(DRAFT_PREFIX) {
            bail!("本机缺少草稿图片")
        }
        let api = Api::new(&self.origin, token)?;
        let config = api.json(reqwest::Method::GET, "/api/v1/config", None, None)?;
        let prefix = format!(
            "{}/assets/",
            config["public_url"]
                .as_str()
                .context("missing public URL")?
        );
        let route = url.strip_prefix(&prefix).context("external image")?;
        let (media, bytes) = api.asset_bytes(&self.vault, route)?;
        self.remember_asset(url, &media, &bytes)?;
        Ok(json!({"type":media,"data":STANDARD.encode(bytes)}))
    }
    pub fn upload(
        &self,
        token: &str,
        path: &str,
        name: &str,
        media: &str,
        encoded: &str,
    ) -> Result<String> {
        let bytes = STANDARD.decode(encoded)?;
        let api = Api::new(&self.origin, token)?;
        let url = api.upload_asset(
            &self.vault,
            &self.file_id(path)?.context("笔记尚未同步")?,
            name,
            media,
            &bytes,
        )?;
        self.remember_asset(&url, media, &bytes)?;
        Ok(url)
    }
}

impl Notebook {
    pub fn catalog(&self, token: &str, route: &str, scope: Option<String>) -> Result<Value> {
        let name = route.split('?').next().unwrap_or("");
        if !matches!(
            name,
            "/assets" | "/search" | "/tags" | "/exports" | "/links/backlinks"
        ) || (scope.is_some() && route != "/exports")
        {
            bail!("未知的笔记库操作")
        };
        if let Some(scope) = scope {
            return self.create_export(token, &scope, None);
        }
        let api = Api::new(&self.origin, token)?;
        let full = format!("/api/v1/vaults/{}{route}", self.vault);
        api.json(reqwest::Method::GET, &full, None, None)
    }
    pub fn create_export(&self, token: &str, scope: &str, mode: Option<&str>) -> Result<Value> {
        let mut options = json!({"scope":scope});
        if let Some(mode) = mode {
            options["mode"] = json!(mode);
        }
        Api::new(&self.origin, token)?.json(
            reqwest::Method::POST,
            &format!("/api/v1/vaults/{}/exports", self.vault),
            Some(options),
            Some(&uuid::Uuid::new_v4().to_string()),
        )
    }
    pub fn asset(&self, id: &str, token: &str) -> Result<Value> {
        identifier(id)?;
        let api = Api::new(&self.origin, token)?;
        let (media, bytes) = api.asset_bytes(&self.vault, id)?;
        Ok(json!({"type":media,"data":STANDARD.encode(bytes)}))
    }
    pub fn download(&self, dir: &Path, token: &str, kind: &str, id: &str) -> Result<String> {
        identifier(id)?;
        let api = Api::new(&self.origin, token)?;
        let base = format!("/api/v1/vaults/{}", self.vault);
        let (name, route, meta) = match kind {
            "asset" => {
                let m = api.json(
                    reqwest::Method::GET,
                    &format!("{base}/assets/{id}"),
                    None,
                    None,
                )?;
                let safe = m["name"]
                    .as_str()
                    .filter(|s| !s.contains('/') && disk::relative(s).is_ok())
                    .unwrap_or("attachment");
                (safe.to_owned(), format!("/assets/{id}"), m)
            }
            "export" => {
                let m = api.json(
                    reqwest::Method::GET,
                    &format!("{base}/exports/{id}"),
                    None,
                    None,
                )?;
                if m["status"] != "completed" {
                    bail!("导出任务尚未完成")
                };
                (
                    format!("wenote-{id}.zip"),
                    format!("{base}/exports/{id}/download"),
                    m,
                )
            }
            _ => bail!("未知的下载类型"),
        };
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        api.copy_download(
            &route,
            temp.as_file_mut(),
            meta["content_size"].as_u64().context("missing size")?,
            meta["content_hash"].as_str().context("missing hash")?,
        )?;
        Self::publish_download(dir, &name, temp)
    }
    pub fn export_bytes(&self, dir: &Path, name: &str, bytes: &[u8]) -> Result<String> {
        self.path(name)?;
        Self::export_download(dir, name, bytes)
    }
    pub fn export_download(dir: &Path, name: &str, bytes: &[u8]) -> Result<String> {
        use std::io::Write;
        if name.contains('/') || bytes.len() > 16 << 20 {
            bail!("无效的导出文件")
        }
        disk::relative(name)?;
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        temp.write_all(bytes)?;
        Self::publish_download(dir, name, temp)
    }
    fn publish_download(
        dir: &Path,
        name: &str,
        mut temp: tempfile::NamedTempFile,
    ) -> Result<String> {
        let path = Path::new(name);
        let stem = path
            .file_stem()
            .context("missing file name")?
            .to_string_lossy();
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        for n in 0..1000 {
            let dest = dir.join(if n == 0 {
                name.to_owned()
            } else {
                format!("{stem} ({n}){ext}")
            });
            match temp.persist_noclobber(&dest) {
                Ok(_) => return Ok(dest.display().to_string()),
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => temp = e.file,
                Err(e) => return Err(e.error.into()),
            }
        }
        bail!("下载目录有过多同名文件")
    }
    pub fn file_id(&self, path: &str) -> Result<Option<String>> {
        let state: State = serde_json::from_slice(&fs::read(self.state_dir.join("state.json"))?)?;
        Ok(state
            .files
            .into_iter()
            .find(|(_, f)| f.path == path)
            .map(|(id, _)| id))
    }
}

#[cfg(test)]
mod entry_tests {
    use super::*;

    #[test]
    fn search_saved_text_without_a_server() -> Result<()> {
        let data = tempfile::tempdir()?;
        let book = Notebook {
            root: data.path().to_owned(),
            state_dir: data.path().join("state"),
            vault: "test".into(),
            origin: String::new(),
        };
        fs::write(book.root.join("本地.md"), "这是 LiNuX 的本地笔记")?;
        fs::write(book.root.join("配置.json"), r#"{"说明":"其他内容"}"#)?;
        fs::write(book.root.join("图.xmind"), b"Linux")?;
        let paths = vec![
            "本地.md".into(),
            "配置.json".into(),
            "图.xmind".into(),
            "已删除.txt".into(),
        ];
        assert_eq!(book.search_notes("linux", &paths)?, vec!["本地.md"]);
        assert_eq!(book.search_notes("其他内容", &paths)?, vec!["配置.json"]);
        Ok(())
    }
    #[test]
    fn folder_changes_check_snapshot_and_keep_original_bytes() -> Result<()> {
        let data = tempfile::tempdir()?;
        let book = Notebook {
            root: data.path().join("notes"),
            state_dir: data.path().join("state"),
            vault: "vault".into(),
            origin: String::new(),
        };
        fs::create_dir_all(&book.root)?;
        fs::create_dir_all(&book.state_dir)?;
        fs::File::create(book.state_dir.join("lock"))?;
        book.save_bytes("Docs/nested/a.xmind", None, b"\x00\xff")?;
        let expected = book.library()?;
        assert!(book
            .change_entry("move", "Docs/", "Docs/nested/deeper/", &expected)
            .is_err());
        book.change_entry("copy", "Docs/", "Copy/", &expected)?;
        assert_eq!(
            fs::read(book.root.join("Copy/nested/a.xmind"))?,
            b"\x00\xff"
        );
        assert!(book
            .change_entry("move", "Docs/", "Copy/", &expected)
            .is_err());
        fs::write(book.root.join("Docs/untracked.bin"), b"external")?;
        assert!(book.change_entry("delete", "Docs/", "", &expected).is_err());
        assert!(book.root.join("Docs/untracked.bin").is_file());
        book.change_entry(
            "move",
            "Copy/nested/a.xmind",
            "new.md",
            &BTreeMap::from([("Copy/nested/a.xmind".into(), digest(b"\x00\xff"))]),
        )?;
        let file = BTreeMap::from([("new.md".into(), digest(b"\x00\xff"))]);
        fs::write(book.root.join("new.md"), b"changed")?;
        assert!(book.change_entry("delete", "new.md", "", &file).is_err());
        book.change_entry(
            "delete",
            "new.md",
            "",
            &BTreeMap::from([("new.md".into(), digest(b"changed"))]),
        )?;
        assert!(!book.root.join("new.md").exists());
        let trash = fs::read_dir(book.state_dir.join("trash"))?
            .next()
            .unwrap()?
            .path();
        assert_eq!(fs::read(trash.join("new.md"))?, b"changed");
        let items = book.trash_files()?;
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(book.read_trash(item)?, json!(STANDARD.encode(b"changed")));
        book.save("new.md", None, "replacement")?;
        assert!(book.restore_file(item).is_err());
        assert_eq!(fs::read(trash.join("new.md"))?, b"changed");
        fs::remove_file(book.root.join("new.md"))?;
        book.restore_file(item)?;
        assert_eq!(fs::read(book.root.join("new.md"))?, b"changed");
        assert!(book.trash_files()?.is_empty());
        book.save("trash-folder/child/a.md", None, "nested")?;
        let members = BTreeMap::from([("trash-folder/child/a.md".into(), digest(b"nested"))]);
        book.change_entry("delete", "trash-folder/", "", &members)?;
        let folder = book.trash_files()?.pop().unwrap();
        assert_eq!(folder.path, "trash-folder/");
        assert!(book.read_trash(&folder).is_err());
        book.restore_file(&folder)?;
        assert_eq!(
            fs::read(book.root.join("trash-folder/child/a.md"))?,
            b"nested"
        );
        book.change_entry("delete", "trash-folder/", "", &members)?;
        book.purge_trash(&book.trash_files()?.pop().unwrap())?;
        assert!(book.trash_files()?.is_empty());
        Ok(())
    }
}
