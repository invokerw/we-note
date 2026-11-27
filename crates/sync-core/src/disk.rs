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
pub fn legacy_note(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "md" | "txt" | "json" | "xmind"
    )
}
pub fn text_bytes(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct CachedHash {
    stamp: [i128; 7],
    hash: String,
}
pub type ScanCache = BTreeMap<String, CachedHash>;
#[cfg(unix)]
fn file_stamp(m: &fs::Metadata) -> Option<[i128; 7]> {
    use std::os::unix::fs::MetadataExt;
    // Coarse timestamps cannot distinguish consecutive same-size edits. Rehash those files.
    if m.ctime_nsec() == 0 || m.mtime_nsec() == 0 {
        return None;
    }
    Some([
        m.dev() as i128,
        m.ino() as i128,
        m.len() as i128,
        m.ctime() as i128,
        m.ctime_nsec() as i128,
        m.mtime() as i128,
        m.mtime_nsec() as i128,
    ])
}
#[cfg(not(unix))]
fn file_stamp(_: &fs::Metadata) -> Option<[i128; 7]> {
    None
}

pub fn scan(root: &Path) -> Result<BTreeMap<String, String>> {
    Ok(scan_cached(root, &ScanCache::new())?.0)
}
pub fn scan_cached(
    root: &Path,
    old: &ScanCache,
) -> Result<(BTreeMap<String, String>, ScanCache, u64)> {
    let mut files = BTreeMap::new();
    let mut keys = BTreeMap::new();
    let mut cache = ScanCache::new();
    let mut bytes_read = 0;
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
        let legacy = legacy_note(path);
        let metadata = entry.metadata()?;
        if !legacy && metadata.len() > 16 << 20 {
            continue;
        }
        let p = path
            .strip_prefix(root)?
            .to_str()
            .context("non-unicode filename")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        let stamp = file_stamp(&metadata);
        let cached = old.get(&p).filter(|item| Some(item.stamp) == stamp);
        let hash = match cached {
            Some(item) => item.hash.clone(),
            None => {
                let bytes = fs::read(path)?;
                bytes_read += bytes.len() as u64;
                if !legacy && !text_bytes(&bytes) {
                    continue;
                }
                super::digest(&bytes)
            }
        };
        if let Some(stamp) = stamp {
            cache.insert(
                p.clone(),
                CachedHash {
                    stamp,
                    hash: hash.clone(),
                },
            );
        }
        relative(&p)?;
        let key: String = p.nfc().collect::<String>().to_lowercase();
        if let Some(old) = keys.insert(key, p.clone()) {
            bail!("路径冲突 {old} / {p}")
        }
        files.insert(p.nfc().collect(), hash);
    }
    Ok((files, cache, bytes_read))
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
    let ext = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let hash = super::digest(bytes);
    for n in 1..=1000 {
        let suffix = if n == 1 {
            String::new()
        } else {
            format!("-{n}")
        };
        let candidate =
            path.with_file_name(format!("{name} (conflict {}{suffix}){ext}", &hash[7..15]));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_other_text_and_handle_extensionless_conflicts() -> Result<()> {
        let dir = tempfile::tempdir()?;
        for name in ["a.csv", "README", "log.txt", "run.LOG"] {
            fs::write(dir.path().join(name), "你好\r\n")?;
        }
        fs::write(dir.path().join("image.bin"), b"\x00\x80")?;
        assert_eq!(scan(dir.path())?.len(), 4);
        let copy = conflict(dir.path(), "README", b"changes")?;
        assert!(scan(dir.path())?.contains_key(&copy));
        Ok(())
    }
}
