import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { request, type Note, type Vault } from "./api";
import { FolderTree } from "./LibraryUI";
import { entryPath } from "./libraryEntries";

function VaultFolders({
  token,
  vault,
  active,
  select,
}: {
  token: string;
  vault: string;
  active: string;
  select: (path: string) => void;
}) {
  const [paths, setPaths] = useState<string[]>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError("");
    request(token, `/api/v1/vaults/${vault}/files`)
      .then((r) => r.json())
      .then(({ files }: { files: Note[] }) => {
        if (live)
          setPaths(files.map((f) => entryPath(f.path, f.current_content_hash)));
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [token, vault, attempt]);
  if (error)
    return (
      <div role="alert">
        {error}{" "}
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          重试加载目录
        </button>
      </div>
    );
  if (!paths) return <p role="status">正在读取目录…</p>;
  return (
    <FolderTree
      paths={paths}
      active={active}
      select={select}
      includeRoot={false}
    />
  );
}

export function ShareSaveDialog({
  token,
  login,
  importPath,
  close,
  saved,
}: {
  token: string;
  login: ReactNode;
  importPath: string;
  close: () => void;
  saved: (
    vault: string,
    files: { file_id: string; path: string }[],
    folder: string,
  ) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [vaults, setVaults] = useState<Vault[]>();
  const [vaultId, setVaultId] = useState("");
  const [expanded, setExpanded] = useState("");
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const selected = vaults?.find((v) => v.id === vaultId);
  const target = folder + (newFolder?.trim() || "");
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  useEffect(() => {
    if (!token) return;
    let live = true;
    setError("");
    request(token, "/api/v1/vaults")
      .then((r) => r.json())
      .then(({ vaults }: { vaults: Vault[] }) => {
        if (!live) return;
        setVaults(vaults);
        const first = vaults[0]?.id || "";
        setVaultId(first);
        setExpanded(first);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [token, attempt]);
  function chooseVault(id: string) {
    setVaultId(id);
    setExpanded(id);
    setFolder("");
    setNewFolder(null);
    setError("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !vaults) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      let destination = vaultId;
      if (!vaults.length) {
        const created: Vault = await (
          await request(token, "/api/v1/vaults", "POST", {
            name: String(fields.get("name")).trim(),
          })
        ).json();
        setVaults([created]);
        chooseVault(created.id);
        destination = created.id;
      }
      const { files } = await (
        await request(token, importPath, "POST", {
          vault_id: destination,
          folder: target.replace(/\/$/, ""),
          place_single_file_here: true,
        })
      ).json();
      saved(destination, files, target.replace(/\/$/, ""));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      className="share-save-dialog"
      ref={ref}
      aria-labelledby="save-share-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <h2 id="save-share-title">保存到我的笔记</h2>
      {!token && login}
      {token &&
        !vaults &&
        (error ? (
          <button onClick={() => setAttempt((n) => n + 1)}>
            重试加载笔记库
          </button>
        ) : (
          <p role="status">正在读取笔记库…</p>
        ))}
      {token && vaults && (
        <form id="save-share-form" onSubmit={save}>
          <fieldset disabled={busy}>
            {vaults.length ? (
              <>
                <legend>选择保存位置</legend>
                <ul
                  className="destination-tree folders"
                  aria-label="笔记库和目录"
                >
                  {vaults.map((v) => (
                    <li key={v.id}>
                      <div
                        className={
                          "folder-row" +
                          (v.id === vaultId && !folder ? " current" : "")
                        }
                      >
                        <button
                          type="button"
                          aria-label={
                            (expanded === v.id ? "折叠" : "展开") + v.name
                          }
                          aria-expanded={expanded === v.id}
                          onClick={() =>
                            expanded === v.id
                              ? setExpanded("")
                              : chooseVault(v.id)
                          }
                        >
                          {expanded === v.id ? "▾" : "▸"}
                        </button>
                        <button
                          type="button"
                          className="folder-name"
                          aria-current={
                            v.id === vaultId && !folder ? "location" : undefined
                          }
                          onClick={() => chooseVault(v.id)}
                        >
                          {v.name}
                        </button>
                      </div>
                      {expanded === v.id && (
                        <VaultFolders
                          key={v.id}
                          vault={v.id}
                          token={token}
                          active={folder}
                          select={(path) => {
                            setFolder(path);
                            setNewFolder(null);
                            setError("");
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
                <p className="selected-destination">
                  <span>保存位置</span>
                  <strong>
                    {[selected?.name, ...target.split("/")]
                      .filter(Boolean)
                      .join(" / ")}
                  </strong>
                </p>
                {newFolder === null ? (
                  <button type="button" onClick={() => setNewFolder("")}>
                    新建子目录
                  </button>
                ) : (
                  <label>
                    子目录名称
                    <input
                      required
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                    />
                  </label>
                )}
              </>
            ) : (
              <label>
                新建笔记库
                <input name="name" defaultValue="我的笔记" required />
              </label>
            )}
          </fieldset>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <footer>
        <button disabled={busy} onClick={close}>
          取消
        </button>
        {token && vaults && (
          <button
            type="submit"
            form="save-share-form"
            className="primary"
            disabled={busy || (newFolder !== null && !newFolder.trim())}
          >
            {busy ? "正在保存…" : "确认保存"}
          </button>
        )}
      </footer>
    </dialog>
  );
}
