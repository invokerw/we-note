import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Editor from "./Editor";
import { rememberSession, base64, Note, request, Share, Vault } from "./api";
import "./style.css";
function Auth({ login }: { login: (s: string) => void }) {
  const [register, setRegister] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="auth">
      <div className="brand">WeNote</div>
      <h1>{register ? "创建账户" : "打开你的笔记库"}</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget),
            body = { email: data.get("email"), password: data.get("password") };
          setBusy(true);
          try {
            if (register)
              await request("", "/api/v1/auth/register", "POST", body);
            const s = await (
              await request("", "/api/v1/auth/login", "POST", body)
            ).json();
            rememberSession(s);
            login(s.access_token);
          } catch (err) {
            setError(String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          邮箱
          <input type="email" name="email" autoComplete="username" required />
        </label>
        <label>
          密码
          <input
            type="password"
            name="password"
            autoComplete={register ? "new-password" : "current-password"}
            minLength={8}
            required
          />
        </label>
        <button disabled={busy} className="primary">
          {register ? "注册并登录" : "登录"}
        </button>
      </form>
      <button
        onClick={() => {
          setRegister(!register);
          setError("");
        }}
      >
        {register ? "已有账户，登录" : "创建账户"}
      </button>
      <p role="alert">{error}</p>
    </main>
  );
}
function Tree({
  files,
  prefix = "",
  select,
  active,
}: {
  files: Note[];
  prefix?: string;
  select: (n: Note) => void;
  active: string;
}) {
  const folders = new Map<string, Note[]>(),
    leaves: Note[] = [];
  for (const f of files) {
    const suffix = f.path.slice(prefix.length),
      i = suffix.indexOf("/");
    if (i < 0) {
      leaves.push(f);
      continue;
    }
    const dir = suffix.slice(0, i + 1);
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir)!.push(f);
  }
  return (
    <ul className="tree">
      {Array.from(folders, ([dir, items]) => (
        <li key={dir}>
          <details open>
            <summary>{dir.slice(0, -1)}</summary>
            <Tree
              files={items}
              prefix={prefix + dir}
              select={select}
              active={active}
            />
          </details>
        </li>
      ))}
      {leaves.map((f) => (
        <li key={f.file_id}>
          <button
            className={active === f.file_id ? "selected" : ""}
            onClick={() => select(f)}
          >
            {f.path.slice(prefix.length)}
          </button>
        </li>
      ))}
    </ul>
  );
}
function Library({ token, logout }: { token: string; logout: () => void }) {
  const [vaults, setVaults] = useState<Vault[]>([]),
    [vault, setVault] = useState(""),
    [files, setFiles] = useState<Note[]>([]),
    [note, setNote] = useState<Note | null>(null),
    [view, setView] = useState("files"),
    [trash, setTrash] = useState<Note[]>([]),
    [shares, setShares] = useState<Share[]>([]),
    [message, msg] = useState(""),
    [origin, setOrigin] = useState(location.origin);
  const dirty = useRef(false),
    picker = useRef<HTMLInputElement>(null);
  const base = `/api/v1/vaults/${vault}`;
  async function run(f: () => Promise<void>) {
    try {
      await f();
    } catch (e) {
      msg(String(e));
    }
  }
  function leave() {
    if (dirty.current && !confirm("放弃尚未保存的编辑？")) return false;
    dirty.current = false;
    return true;
  }
  async function listVaults() {
    const v = (await (await request(token, "/api/v1/vaults")).json())
      .vaults as Vault[];
    setVaults(v);
    setVault((x) => x || v[0]?.id || "");
  }
  async function list() {
    if (!vault) return;
    const next: Note[] = (await (await request(token, base + "/files")).json())
      .files;
    setFiles(next);
    setNote((n) =>
      n ? next.find((f) => f.file_id === n.file_id) || null : null,
    );
  }
  useEffect(() => {
    run(listVaults);
    request(token, "/api/v1/config")
      .then((r) => r.json())
      .then((x) => setOrigin(x.public_url))
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    let live = true;
    setFiles([]);
    setNote(null);
    setView("files");
    if (vault)
      run(async () => {
        const result = await (await request(token, base + "/files")).json();
        if (live) setFiles(result.files);
      });
    return () => {
      live = false;
    };
  }, [vault]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  async function section(s: string) {
    if (!leave()) return;
    setNote(null);
    if (s === "trash")
      setTrash((await (await request(token, base + "/trash")).json()).files);
    if (s === "inbox" || s === "sent")
      setShares(
        (await (await request(token, "/api/v1/shares/" + s)).json()).shares,
      );
    if (s === "files") await list();
    setView(s);
  }
  async function create(path: string, bytes: Uint8Array) {
    const r = await (
      await request(token, base + "/files", "POST", {
        path,
        content: base64(bytes),
      })
    ).json();
    await list();
    const f = await (await request(token, base + "/files/" + r.file_id)).json();
    setView("files");
    setNote(f);
  }
  function select(n: Note) {
    if (leave()) {
      setView("files");
      setNote(n);
      msg("");
    }
  }
  async function share() {
    const recipient = prompt("接收者邮箱");
    if (!recipient) return;
    const path = prompt("文件或目录路径", note?.path || "");
    if (path) {
      await request(token, "/api/v1/shares", "POST", {
        vault_id: vault,
        recipient,
        paths: [path],
      });
      msg("快照已发送");
    }
  }
  return (
    <div className="layout">
      <aside>
        <div className="brand">WeNote</div>
        <div className="vault">
          <select
            aria-label="笔记库"
            value={vault}
            onChange={(e) => {
              if (leave()) setVault(e.target.value);
            }}
          >
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <button
            aria-label="新建笔记库"
            onClick={() =>
              run(async () => {
                const name = prompt("笔记库名称");
                if (name && leave()) {
                  const v = await (
                    await request(token, "/api/v1/vaults", "POST", { name })
                  ).json();
                  await listVaults();
                  setVault(v.id);
                }
              })
            }
          >
            ＋
          </button>
        </div>
        <nav className="sections">
          {[
            ["files", "文件"],
            ["inbox", "收件箱"],
            ["sent", "已发送"],
            ["trash", "回收站"],
          ].map(([v, label]) => (
            <button
              key={v}
              disabled={!vault}
              className={view === v ? "on" : ""}
              onClick={() => run(() => section(v))}
            >
              {label}
            </button>
          ))}
        </nav>
        {vault && (
          <>
            <div className="treehead">
              <strong>文件树</strong>
              <button
                onClick={() =>
                  run(async () => {
                    if (!leave()) return;
                    const p = prompt("新笔记路径", "未命名.md");
                    if (p) await create(p, new Uint8Array());
                  })
                }
              >
                新建笔记
              </button>
            </div>
            <Tree files={files} select={select} active={note?.file_id || ""} />
          </>
        )}
        <div className="account">
          <button
            onClick={() => {
              if (leave()) logout();
            }}
          >
            退出登录
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <span>{vaults.find((v) => v.id === vault)?.name || "笔记库"}</span>
          {vault && (
            <div>
              <button
                onClick={() => {
                  if (leave()) picker.current?.click();
                }}
              >
                上传笔记
              </button>
              <button onClick={() => run(share)}>分享快照</button>
            </div>
          )}
        </header>
        <input
          ref={picker}
          hidden
          type="file"
          accept=".md,.txt,.json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              run(async () => {
                const path = prompt("保存路径", f.name);
                if (path)
                  await create(path, new Uint8Array(await f.arrayBuffer()));
              });
            e.target.value = "";
          }}
        />
        {message && (
          <div role="status" className="message">
            {message}
            <button aria-label="关闭提示" onClick={() => msg("")}>
              ×
            </button>
          </div>
        )}
        {view === "files" && note ? (
          <>
            <Editor
              key={note.file_id}
              {...{
                note,
                token,
                vault,
                origin,
                changed: list,
                dirty: (b) => {
                  dirty.current = b;
                },
                notify: msg,
              }}
            />
            <footer>
              <button
                onClick={() =>
                  run(async () => {
                    if (!leave()) return;
                    const p = prompt("新路径", note.path);
                    if (!p) return;
                    await request(
                      token,
                      base + "/files/" + note.file_id,
                      "PATCH",
                      {
                        path: p,
                        base_version_id: note.current_version_id,
                        base_path: note.path,
                      },
                    );
                    await list();
                    setNote({ ...note, path: p });
                  })
                }
              >
                移动或重命名
              </button>
              <button
                onClick={() =>
                  run(async () => {
                    if (!confirm("将这篇笔记移入回收站？") || !leave()) return;
                    await request(
                      token,
                      base + "/files/" + note.file_id,
                      "DELETE",
                      {
                        base_version_id: note.current_version_id,
                        base_path: note.path,
                      },
                    );
                    setNote(null);
                    await list();
                  })
                }
              >
                移入回收站
              </button>
            </footer>
          </>
        ) : (
          <article>
            <h1>
              {view === "trash"
                ? "回收站"
                : view === "inbox"
                  ? "收件箱"
                  : view === "sent"
                    ? "已发送"
                    : vault
                      ? "笔记库"
                      : "创建你的第一个笔记库"}
            </h1>
            {view === "files" && (
              <p>
                {vault
                  ? files.length
                    ? "从左侧文件树选择一篇笔记。"
                    : "点击「新建笔记」，或上传已有的 Markdown、TXT 文件。"
                  : "点击左侧的 ＋ 创建笔记库。"}
              </p>
            )}
            {view === "trash" &&
              (trash.length ? (
                trash.map((f) => (
                  <div className="row" key={f.file_id}>
                    {f.path}
                    <button
                      onClick={() =>
                        run(async () => {
                          const p = prompt("恢复路径", f.path);
                          if (!p) return;
                          await request(
                            token,
                            base + "/files/" + f.file_id + "/restore",
                            "POST",
                            { base_version_id: f.current_version_id, path: p },
                          );
                          await list();
                          await section("trash");
                        })
                      }
                    >
                      恢复
                    </button>
                  </div>
                ))
              ) : (
                <p>回收站为空。</p>
              ))}
            {(view === "inbox" || view === "sent") &&
              (shares.length ? (
                shares.map((s) => (
                  <section className="share" key={s.share_id}>
                    <strong>
                      {s.snapshot.files.map((f) => f.path).join("、")}
                    </strong>
                    <p>
                      {view === "inbox" ? s.sender : s.recipient} ·{" "}
                      {
                        (
                          {
                            pending: "等待接收",
                            accepted: "已导入",
                            rejected: "已拒绝",
                            revoked: "已撤销",
                          } as Record<string, string>
                        )[s.status]
                      }
                    </p>
                    {s.status === "pending" &&
                      (view === "inbox" ? (
                        <>
                          <button
                            onClick={() =>
                              run(async () => {
                                const folder = prompt(
                                  "导入当前笔记库的目录（留空为根目录）",
                                  "",
                                );
                                if (folder === null) return;
                                await request(
                                  token,
                                  "/api/v1/shares/" + s.share_id + "/accept",
                                  "POST",
                                  { vault_id: vault, folder },
                                );
                                await list();
                                await section(view);
                              })
                            }
                          >
                            导入快照
                          </button>
                          <button
                            onClick={() =>
                              run(async () => {
                                await request(
                                  token,
                                  "/api/v1/shares/" + s.share_id + "/reject",
                                  "POST",
                                );
                                await section(view);
                              })
                            }
                          >
                            拒绝
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() =>
                            run(async () => {
                              await request(
                                token,
                                "/api/v1/shares/" + s.share_id,
                                "DELETE",
                              );
                              await section(view);
                            })
                          }
                        >
                          撤销
                        </button>
                      ))}
                  </section>
                ))
              ) : (
                <p>暂无分享。</p>
              ))}
          </article>
        )}
      </main>
    </div>
  );
}
function App() {
  const [token, setToken] = useState(
    sessionStorage.getItem("wenote-session") || "",
  );
  return token ? (
    <Library
      token={token}
      logout={() => {
        void request(token, "/api/v1/auth/logout", "POST").catch(() => {});
        sessionStorage.removeItem("wenote-renewal");
        sessionStorage.removeItem("wenote-session");
        setToken("");
      }}
    />
  ) : (
    <Auth
      login={(s) => {
        sessionStorage.setItem("wenote-session", s);
        setToken(s);
      }}
    />
  );
}
createRoot(document.getElementById("root")!).render(<App />);
