use super::{api::Api, digest, disk, identifier, State};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

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
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn files(&self) -> Result<Vec<String>> {
        Ok(disk::scan(&self.root)?.into_keys().collect())
    }
    fn path(&self, path: &str) -> Result<PathBuf> {
        if !matches!(
            Path::new(path)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "md" | "txt" | "json"
        ) {
            bail!("请选择 Markdown、TXT 或 JSON 笔记")
        };
        disk::local_path(&self.root, path)
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
        if text.len() > 16 << 20 {
            bail!("笔记超过 16 MiB")
        };
        self.path(path)?;
        let lock = fs::OpenOptions::new()
            .write(true)
            .open(self.state_dir.join("lock"))?;
        lock.try_lock_exclusive().context("正在同步，请稍后保存")?;
        disk::replace(&self.root, path, base, text.as_bytes())
            .context("文件已被修改或移动，请保留草稿并重新打开笔记")?;
        Ok(digest(text.as_bytes()))
    }
    fn cache(&self) -> PathBuf {
        self.state_dir.join("asset-cache")
    }
    fn remember_asset(&self, url: &str, media: &str, bytes: &[u8]) -> Result<()> {
        let cache = self.cache().join(&digest(url.as_bytes())[7..]);
        disk::atomic(&cache.join("bytes"), bytes)?;
        disk::atomic(&cache.join("type"), media.as_bytes())
    }
    pub fn image(&self, url: &str, token: &str) -> Result<Value> {
        let cache = self.cache().join(&digest(url.as_bytes())[7..]);
        if cache.join("type").is_file() {
            return Ok(
                json!({"type":fs::read_to_string(cache.join("type"))?,"data":STANDARD.encode(fs::read(cache.join("bytes"))?)}),
            );
        };
        let api = Api::new(&self.origin, token)?;
        let config = api.json(reqwest::Method::GET, "/api/v1/config", None, None)?;
        let prefix = format!(
            "{}/assets/",
            config["public_url"]
                .as_str()
                .context("missing public URL")?
        );
        let id = url.strip_prefix(&prefix).context("external image")?;
        identifier(id)?;
        let (media, bytes) = api.asset_bytes(&self.vault, id)?;
        self.remember_asset(url, &media, &bytes)?;
        Ok(json!({"type":media,"data":STANDARD.encode(bytes)}))
    }
    pub fn upload(&self, token: &str, name: &str, media: &str, encoded: &str) -> Result<String> {
        let bytes = STANDARD.decode(encoded)?;
        let api = Api::new(&self.origin, token)?;
        let url = api.upload_asset(&self.vault, name, media, &bytes)?;
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
        let api = Api::new(&self.origin, token)?;
        let full = format!("/api/v1/vaults/{}{route}", self.vault);
        match scope {
            Some(scope) => api.json(
                reqwest::Method::POST,
                &full,
                Some(json!({"scope":scope})),
                Some(&uuid::Uuid::new_v4().to_string()),
            ),
            None => api.json(reqwest::Method::GET, &full, None, None),
        }
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
        let path = Path::new(&name);
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
                name.clone()
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
