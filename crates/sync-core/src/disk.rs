use anyhow::{bail, Context, Result};
use std::{
    collections::BTreeMap,
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

pub fn relative(p: &str) -> Result<()> {
    if p.is_empty()
        || p.len() > 2048
        || p.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
        || p.chars().any(char::is_control)
    {
        bail!("不支持的路径 {p:?}")
    };
    for part in p.split('/') {
        let name = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part.len() > 255
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.eq_ignore_ascii_case(".git")
            || part.eq_ignore_ascii_case(".wenote")
            || matches!(
                name.as_str(),
                "CON" | "PRN" | "NUL" | "AUX" | "CONIN$" | "CONOUT$"
            )
            || ((name.starts_with("COM") || name.starts_with("LPT"))
                && name.len() == 4
                && matches!(name.as_bytes()[3], b'1'..=b'9'))
        {
            bail!("不支持的路径 {p:?}")
        }
    }
    Ok(())
}
pub fn local_path(root: &Path, p: &str) -> Result<PathBuf> {
    relative(p)?;
    let mut dest = root.to_owned();
    for part in p.split('/') {
        let mut next = dest.join(part);
        if !next.try_exists()? && dest.is_dir() {
            for child in fs::read_dir(&dest)? {
                let child = child?;
                if child
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.nfc().eq(part.nfc()))
                {
                    next = child.path();
                    break;
                }
            }
        }
        dest = next;
        match fs::symlink_metadata(&dest) {
            Ok(m) if m.file_type().is_symlink() => bail!("跳过符号链接 {}", dest.display()),
            Ok(_) => (),
            Err(e) if e.kind() == ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    Ok(dest)
}
pub fn scan(root: &Path) -> Result<BTreeMap<String, String>> {
    let mut files = BTreeMap::new();
    let mut keys = BTreeMap::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.file_name() != ".wenote" && e.file_name() != ".git")
    {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "md" | "txt" | "json" | "xmind") {
            continue;
        }
        let p = path
            .strip_prefix(root)?
            .to_str()
            .context("non-unicode filename")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        relative(&p)?;
        let key: String = p.nfc().collect::<String>().to_lowercase();
        if let Some(old) = keys.insert(key, p.clone()) {
            bail!("路径冲突 {old} / {p}")
        };
        files.insert(p.nfc().collect(), super::digest(&fs::read(path)?));
    }
    Ok(files)
}
pub fn current(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("missing parent directory")?;
    fs::create_dir_all(parent)?;
    let mut file = NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)?;
    Ok(())
}
pub fn replace(root: &Path, p: &str, expected: Option<&str>, bytes: &[u8]) -> Result<()> {
    let dest = local_path(root, p)?;
    if current(&dest)?.as_deref().map(super::digest).as_deref() != expected {
        bail!("{p} 已变更，将在下次扫描重试")
    };
    atomic(&dest, bytes)
}
pub fn conflict(root: &Path, p: &str, bytes: &[u8]) -> Result<String> {
    let path = Path::new(p);
    let name = path.file_stem().context("name")?.to_string_lossy();
    let ext = path.extension().context("extension")?.to_string_lossy();
    let hash = super::digest(bytes);
    for n in 1..=1000 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate =
            path.with_file_name(format!("{name} (conflict {}{suffix}).{ext}", &hash[7..15]));
        let relative = candidate
            .to_str()
            .context("path")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        let dest = local_path(root, &relative)?;
        match current(&dest)? {
            Some(data) if data == bytes => return Ok(relative),
            Some(_) => continue,
            None => {
                replace(root, &relative, None, bytes)?;
                return Ok(relative);
            }
        }
    }
    bail!("too many conflict copies")
}
