//! A user-selected parent for all of one desktop account's notebooks.
use super::{disk, identifier, State};
use anyhow::{bail, ensure, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MARKER: &str = ".wenote-storage.json";
#[derive(Deserialize, Serialize)]
struct Manifest {
    owner: String,
    id: Uuid,
    books: BTreeMap<String, String>,
}
#[derive(Deserialize, Serialize)]
struct Location {
    root: PathBuf,
    id: Uuid,
}

fn account(data: &Path, owner: &str) -> Result<PathBuf> {
    identifier(owner)?;
    Ok(data.join("accounts").join(owner))
}
fn manifest(root: &Path) -> Result<Manifest> {
    Ok(serde_json::from_slice(&fs::read(root.join(MARKER))?)?)
}
fn lock(path: &Path) -> Result<fs::File> {
    fs::create_dir_all(path)?;
    let f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.join("lock"))?;
    f.try_lock_exclusive()
        .context("笔记目录正在使用，请稍后重试")?;
    Ok(f)
}
fn location(data: &Path, owner: &str) -> Result<Location> {
    let saved: Location =
        serde_json::from_slice(&fs::read(account(data, owner)?.join("location.json"))?)?;
    ensure!(
        saved.root.canonicalize().ok().as_ref() == Some(&saved.root),
        "请重新定位笔记库存储位置：{}",
        saved.root.display()
    );
    let found = manifest(&saved.root)
        .with_context(|| format!("请重新定位笔记库存储位置：{}", saved.root.display()))?;
    ensure!(
        found.owner == owner && saved.id == found.id,
        "存储位置已变更，请重新选择"
    );
    Ok(saved)
}
pub fn resolve(data: &Path, owner: &str) -> Result<PathBuf> {
    Ok(location(data, owner)?.root)
}
pub fn states(data: &Path, owner: &str) -> Result<PathBuf> {
    Ok(account(data, owner)?.join(location(data, owner)?.id.to_string()))
}
pub fn bind(data: &Path, owner: &str, path: &Path, separate: bool) -> Result<PathBuf> {
    let settings = account(data, owner)?;
    let _guard = lock(&data.join("accounts"))?;
    let mut root = path.canonicalize()?;
    ensure!(root.is_dir(), "请选择文件夹");
    let app = data.canonicalize()?;
    ensure!(
        !root.starts_with(&app) && !app.starts_with(&root),
        "请选择与应用数据独立的文件夹"
    );
    for parent in root.ancestors().skip(1) {
        if parent.join(MARKER).exists() {
            let marker = manifest(parent)?;
            ensure!(
                !marker
                    .books
                    .values()
                    .any(|name| root.starts_with(parent.join(name))),
                "请选择笔记库以外的文件夹"
            );
        }
    }
    // A legacy single-vault directory must never contain the new storage tree.
    for item in fs::read_dir(data)? {
        let item = item?;
        if !item.file_type()?.is_dir() {
            continue;
        }
        if let Some(bytes) = disk::current(&item.path().join("state.json"))? {
            if let Ok(old) = serde_json::from_slice::<State>(&bytes) {
                ensure!(
                    !root.starts_with(old.root),
                    "这里是旧版笔记库，请选择它的上级或其他文件夹"
                );
            }
        }
    }
    if separate {
        let base = root.clone();
        for n in 1.. {
            root = base.join(if n == 1 {
                "WeNote".into()
            } else {
                format!("WeNote {n}")
            });
            match fs::create_dir(&root) {
                Ok(()) => break,
                Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
    let marker = if root.join(MARKER).try_exists()? {
        let m = manifest(&root)?;
        ensure!(m.owner == owner, "其他账号正在使用这个位置");
        m
    } else {
        ensure!(fs::read_dir(&root)?.next().is_none(), "所选文件夹已有文件");
        let m = Manifest {
            owner: owner.into(),
            id: Uuid::new_v4(),
            books: BTreeMap::new(),
        };
        disk::atomic(&root.join(MARKER), &serde_json::to_vec(&m)?)?;
        m
    };
    disk::atomic(
        &settings.join("location.json"),
        &serde_json::to_vec(&Location {
            root: root.clone(),
            id: marker.id,
        })?,
    )?;
    Ok(root)
}
fn child(root: &Path, name: &str) -> Result<PathBuf> {
    ensure!(
        Path::new(name).file_name().and_then(|s| s.to_str()) == Some(name),
        "无效的笔记库目录"
    );
    let path = root.join(name);
    ensure!(
        path.is_dir() && path.canonicalize()? == path,
        "笔记库目录已移动，请先恢复 {}",
        path.display()
    );
    Ok(path)
}
pub fn book(data: &Path, owner: &str, vault: &str) -> Result<PathBuf> {
    let root = resolve(data, owner)?;
    let marker = manifest(&root)?;
    child(
        &root,
        marker.books.get(vault).context("请先同步这个笔记库")?,
    )
}
pub fn open_book(data: &Path, owner: &str, vault: &str) -> Result<super::notebook::Notebook> {
    let expected = book(data, owner, vault)?;
    let states = states(data, owner)?;
    ensure!(
        !states.join(vault).join("migration.json").try_exists()?,
        "正在迁移旧笔记库"
    );
    let book = super::notebook::Notebook::open(&states, vault)?;
    ensure!(book.root_path() == expected, "请重新定位笔记库存储位置");
    Ok(book)
}
pub fn prepare(data: &Path, owner: &str, vault: &str, name: &str) -> Result<PathBuf> {
    identifier(vault)?;
    let _guard = lock(&data.join("accounts"))?;
    let root = resolve(data, owner)?;
    let mut marker = manifest(&root)?;
    if let Some(folder) = marker.books.get(vault) {
        return child(&root, folder);
    }
    let readable: String = name
        .chars()
        .filter(|c| !c.is_control() && !r#"/\:*?"<>|"#.contains(*c))
        .take(32)
        .collect();
    let mut folder = format!("{} [{}]", readable.trim(), vault);
    // Windows reserves device names even with extensions (e.g. CON.txt).
    if disk::relative(&folder).is_err() {
        folder = format!("笔记库 [{vault}]");
    }
    let dir = root.join(&folder);
    fs::create_dir(&dir)
        .with_context(|| format!("无法新建独立目录 {}，请检查是否有同名文件夹", dir.display()))?;
    marker.books.insert(vault.into(), folder);
    if let Err(e) = disk::atomic(&root.join(MARKER), &serde_json::to_vec(&marker)?) {
        let _ = fs::remove_dir(&dir);
        return Err(e);
    }
    Ok(dir)
}

// Snapshot both ordinary files and pending sync/editor state before the first
// managed sync. The old client can still read its original copy.
fn copy_contents(from: &Path, to: &Path, skip_held_lock: bool) -> Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if skip_held_lock && entry.file_name() == "lock" {
            continue;
        }
        let dest = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::create_dir(&dest)?;
            copy_contents(&entry.path(), &dest, false)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), dest)?;
        } else {
            bail!("旧库包含无法迁移的特殊文件 {}", entry.path().display());
        }
    }
    Ok(())
}
pub fn prepare_sync(
    data: &Path,
    owner: &str,
    origin: &str,
    vault: &str,
    name: &str,
) -> Result<(PathBuf, PathBuf)> {
    let root = prepare(data, owner, vault, name)?;
    let states = states(data, owner)?;
    let _guard = lock(&states)?;
    let state_dir = states.join(vault);
    let path = state_dir.join("state.json");
    if let Some(bytes) = disk::current(&path)? {
        let mut state: State = serde_json::from_slice(&bytes)?;
        ensure!(
            state.origin == origin && state.vault == vault,
            "笔记库绑定不匹配"
        );
        if state.root != root {
            let _book_guard = lock(&state_dir)?;
            ensure!(
                !state.root.try_exists()?,
                "原笔记库仍然存在，请选择原存储位置"
            );
            state.root = root.clone();
            disk::atomic(&path, &serde_json::to_vec(&state)?)?;
        }
    } else if let Some(bytes) = legacy_state(data, owner, &states, vault)? {
        let old: State = serde_json::from_slice(&bytes)?;
        if old.origin.trim_end_matches('/') == origin && old.vault == vault && old.root.is_dir() {
            let old_dir = data.join(vault);
            let _legacy_guard = lock(&old_dir)?;
            let mut old: State = serde_json::from_slice(&fs::read(old_dir.join("state.json"))?)?;
            ensure!(
                !root.starts_with(&old.root) && !old.root.starts_with(&root),
                "新旧笔记目录不能嵌套"
            );
            ensure!(
                fs::read_dir(&root)?.next().is_none(),
                "新目录已有内容，请检查后重试旧库迁移"
            );
            let snapshot = tempfile::tempdir_in(&states)?;
            copy_contents(&old_dir, snapshot.path(), true)?;
            old.root = old.root.canonicalize()?;
            // Stage next to the destination for an atomic same-volume rename.
            let staged = tempfile::tempdir_in(root.parent().context("存储位置无效")?)?;
            copy_contents(&old.root, staged.path(), false)?;
            old.root = root.clone();
            old.origin = origin.into();
            disk::atomic(
                &snapshot.path().join("state.json"),
                &serde_json::to_vec(&old)?,
            )?;
            let staging_name = staged
                .path()
                .file_name()
                .context("迁移目录无效")?
                .to_owned();
            disk::atomic(
                &snapshot.path().join("migration.json"),
                &serde_json::to_vec(&staging_name)?,
            )?;
            let staged_path = staged.keep();
            if let Err(e) = fs::rename(snapshot.path(), &state_dir) {
                fs::remove_dir_all(staged_path)?;
                return Err(e.into());
            }
        }
    }
    // A crash between installing the state and installing the staged files is
    // replayed before sync can interpret an empty folder as local deletions.
    let journal = state_dir.join("migration.json");
    if let Some(bytes) = disk::current(&journal)? {
        let staged_name: std::ffi::OsString = serde_json::from_slice(&bytes)?;
        let staged = child_path_for_stage(&root, &staged_name)?;
        if staged.try_exists()? {
            // Windows cannot rename a directory over an existing directory.
            // Each successful rename consumes one entry from the journal's
            // stage, so an interrupted installation resumes with the rest.
            for item in fs::read_dir(&staged)? {
                let item = item?;
                let target = root.join(item.file_name());
                ensure!(
                    fs::symlink_metadata(&target).is_err_and(|e| e.kind() == ErrorKind::NotFound),
                    "目标文件已存在或无法访问：{}",
                    target.display()
                );
                fs::rename(item.path(), target)?;
            }
            fs::remove_dir(staged)?;
        }
        fs::remove_file(journal)?;
    }
    Ok((root, state_dir))
}

fn child_path_for_stage(root: &Path, name: &std::ffi::OsStr) -> Result<PathBuf> {
    ensure!(
        Path::new(name).file_name() == Some(name) && name.to_string_lossy().starts_with(".tmp"),
        "迁移记录无效"
    );
    Ok(root.parent().context("无效的存储位置")?.join(name))
}

// Returning to a different managed location should not resurrect stale drafts
// from a legacy copy which was already migrated and subsequently edited.
fn legacy_state(data: &Path, owner: &str, states: &Path, vault: &str) -> Result<Option<Vec<u8>>> {
    let old = disk::current(&data.join(vault).join("state.json"))?;
    if old.is_some() {
        for item in fs::read_dir(account(data, owner)?)? {
            let item = item?;
            if item.file_type()?.is_dir()
                && item.path() != states
                && item.path().join(vault).join("state.json").try_exists()?
            {
                return Ok(None);
            }
        }
    }
    Ok(old)
}
