import { lazy, Suspense, useCallback } from "react";
import {
  Sharing,
  Audit,
  CopyUpdates,
  PublicShare,
  readShareLocation,
} from "./Sharing";
import EncryptedVaults, { type EncryptedIO } from "./EncryptedVaults";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Manager from "./plugins/Manager";
import { browserExport } from "./plugins/archive";
import {
  containsEntry,
  entryPath,
  marker,
  type EntryIO,
} from "./libraryEntries";
import { initialBytes } from "./plugins/xmind";
import Editor, { AssetImage } from "./Editor";
import { useMediaQuery } from "@mantine/hooks";
import { PhoneIcon } from "./PhoneUI";
import { AppShell } from "@mantine/core";
import { WorkspaceShell } from "./WorkspaceShell";
import { LibraryResources } from "./Resources";
import { rememberSession, base64, Note, request, Share, Vault } from "./api";
import { Cover, LibraryPanes, usePanes } from "./LibraryUI";
import {
  loadLocalPreferences,
  mergeRemotePreferences,
  saveLocalPreferences,
  updatePluginPreferences,
  type UserPreferences,
} from "./preferences";
import "./style.css";
import "./phone.css";
import "./workspace.css";
const Admin = lazy(() => import("./Admin"));
import { AccountAction, accountAction } from "./AccountAction";
function Auth({ login }: { login: (s: string) => void }) {
  const [register, setRegister] = useState(false),
    [mode, setMode] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    request("", "/api/v1/auth/registration")
      .then((r) => r.json())
      .then((p) => setMode(p.registration_mode))
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <div className="auth">
      <Cover />
      <div className="entry-form">
        <h1>{register ? "创建账户" : "打开你的笔记库"}</h1>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget),
              body = {
                email: data.get("email"),
                password: data.get("password"),
              };
            setBusy(true);
            try {
              if (register) {
                const registration = await (
                  await request("", "/api/v1/auth/register", "POST", body)
                ).json();
                if (registration.verification_required) {
                  setRegister(false);
                  setError(
                    registration.delivery_status === "sent"
                      ? "请查收验证邮件后登录。"
                      : "请联系管理员检查 SMTP，再重发验证邮件。",
                  );
                  return;
                }
              }
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
        {mode === "invite_only" && (
          <p>本站仅限邀请注册，请通过邀请邮件创建账户。</p>
        )}
        {mode === "closed" && <p>本站已关闭注册。</p>}
        {mode === "open" && (
          <button
            onClick={() => {
              setRegister(!register);
              setError("");
            }}
          >
            {register ? "已有账户，登录" : "创建账户"}
          </button>
        )}
        <p>
          <a href="/#forgot">找回密码</a> · <a href="/#resend">重发验证邮件</a>
        </p>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
type TrashItem = {
  id: string;
  kind: "asset" | "file";
  name: string;
  expires_at: number;
};
function Library({ token, logout }: { token: string; logout: () => void }) {
  const [vaults, setVaults] = useState<Vault[]>([]),
    [vault, setVault] = useState(""),
    [files, setFiles] = useState<Note[]>([]),
    [note, setNote] = useState<Note | null>(null),
    [view, setView] = useState("files"),
    [trash, setTrash] = useState<{
      files: Note[];
      items: TrashItem[];
      can_manage: boolean;
    }>({ files: [], items: [], can_manage: false }),
    [shares, setShares] = useState<Share[]>([]),
    [message, msg] = useState(""),
    [origin, setOrigin] = useState(location.origin),
    [preferences, setPreferences] =
      useState<UserPreferences>(loadLocalPreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const panes = usePanes();
  const phone = !!useMediaQuery("(max-width: 720px)");
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    request(token, "/api/v1/me")
      .then((r) => r.json())
      .then((u) => setIsAdmin(u.role === "system_admin"))
      .catch(() => setIsAdmin(false));
  }, [token]);
  const dirty = useRef(false),
    picker = useRef<HTMLInputElement>(null);
  const encryptedIO = useCallback<EncryptedIO>(
    async (id, payload) =>
      (
        await request(
          token,
          "/api/v1/encrypted-vaults" + (id ? "/" + id : ""),
          payload ? "PUT" : "GET",
          payload,
        )
      ).json(),
    [token],
  );
  const encryptedDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
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
    if (!v.length) panes.setPane("nav");
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
    let live = true;
    request(token, "/api/v1/me/plugin-settings")
      .then((r) => r.json())
      .then((remote) => {
        if (!live) return;
        const next = mergeRemotePreferences(preferencesRef.current, remote);
        preferencesRef.current = next;
        setPreferences(next);
        saveLocalPreferences(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token]);
  function updatePluginSetting(pluginId: string, settings: unknown) {
    const next = updatePluginPreferences(
      preferencesRef.current,
      pluginId,
      settings,
    );
    preferencesRef.current = next;
    setPreferences(next);
    saveLocalPreferences(next);
    void request(
      token,
      "/api/v1/me/plugin-settings/" + encodeURIComponent(pluginId),
      "PUT",
      settings,
    ).catch((e) => msg(String(e)));
  }
  useEffect(() => {
    let live = true;
    panes.browse(null);
    setFiles([]);
    setNote(null);
    setView("files");
    if (vault)
      run(async () => {
        const result = await (await request(token, base + "/files")).json();
        if (live) {
          setFiles(result.files);
          setNote(
            (result.files as Note[]).find(
              (f) => entryPath(f.path, f.current_content_hash) === f.path,
            ) || null,
          );
        }
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
      setTrash(await (await request(token, base + "/trash")).json());
    if (s === "inbox" || s === "sent")
      setShares(
        (await (await request(token, "/api/v1/shares/" + s)).json()).shares,
      );
    if (s === "files") await list();
    setView(s);
    panes.setPane("doc");
  }
  async function changeTrash(
    operation: "restore" | "purge" | "empty",
    item?: TrashItem,
  ) {
    if (
      operation === "empty" &&
      !confirm("彻底清空这个笔记库的回收站？仍被引用的项目将保留。")
    )
      return;
    if (
      operation === "purge" &&
      !confirm(`彻底删除「${item?.name}」及其历史版本？`)
    )
      return;
    if (operation === "restore" && item?.kind === "file") {
      const f = trash.files.find((note) => note.file_id === item.id);
      if (!f) throw Error("笔记已变化，请重新打开回收站");
      const old = entryPath(f.path, f.current_content_hash),
        path = prompt("恢复路径", old);
      if (!path) return;
      await request(token, base + "/files/" + f.file_id + "/restore", "POST", {
        base_version_id: f.current_version_id,
        path: old === f.path ? path : path.replace(/\/$/, "") + "/" + marker,
      });
    } else {
      const result = await (
        await request(token, base + "/trash", "POST", {
          operation,
          kind: item?.kind,
          id: item?.id,
        })
      ).json();
      if (result.retained) msg(`${result.retained} 个项目仍被引用，已保留。`);
    }
    await list();
    await section("trash");
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
    panes.setPane("doc");
  }
  function select(n: Note) {
    if (view === "files" && note?.file_id === n.file_id) {
      panes.setPane("doc");
      return;
    }
    if (leave()) {
      setView("files");
      setNote(n);
      panes.setPane("doc");
      msg("");
    }
  }
  function open(id: string) {
    const f = files.find((n) => n.file_id === id);
    if (f) select(f);
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
  const newVault = () =>
    run(async () => {
      const name = prompt("笔记库名称");
      if (name && leave()) {
        const v = await (
          await request(token, "/api/v1/vaults", "POST", { name })
        ).json();
        await listVaults();
        setVault(v.id);
        panes.setPane("doc");
      }
    });
  const newNote = () =>
    run(async () => {
      const path = prompt("新笔记路径", (panes.folder || "") + "未命名.md");
      if (path && leave()) await create(path, initialBytes(path));
    });
  const byPath = new Map(files.map((f) => [f.path, f]));
  const openPath = (path: string) => {
    const file = byPath.get(path);
    if (file) select(file);
  };
  const paths = files.map((f) => entryPath(f.path, f.current_content_hash));
  const entries: EntryIO = {
    revisions: Object.fromEntries(
      files.map((f) => [f.path, f.current_version_id]),
    ),
    read: async (path) => {
      const f = byPath.get(path);
      if (!f) throw Error("笔记已移动或删除");
      return new Uint8Array(
        await (
          await request(token, base + "/files/" + f.file_id + "/content")
        ).arrayBuffer(),
      );
    },
    write: async (path, bytes) => {
      await request(token, base + "/files", "POST", {
        path,
        content: base64(bytes),
      });
    },
    change: async (operation, source, destination, expected) => {
      if (
        dirty.current &&
        note &&
        operation !== "copy" &&
        containsEntry(source, note.path)
      )
        throw Error("请先保存正在编辑的笔记");
      await request(token, base + "/entry", "POST", {
        operation,
        source,
        destination,
        expected,
      });
    },
    refresh: list,
    output: browserExport,
    image: (src, alt) => (
      <AssetImage src={src} alt={alt} token={token} origin={origin} />
    ),
    print: () => window.print(),
    openCreated: async (path) => {
      if (dirty.current) return;
      const fresh: Note[] = (
        await (await request(token, base + "/files")).json()
      ).files;
      const target = fresh.find((f) => f.path === path);
      if (target) select(target);
    },
  };
  const goToSection = (id: string, label: string) => (
    <button
      key={id}
      disabled={!vault && !["encrypted", "audit", "inbox", "sent"].includes(id)}
      aria-current={view === id ? "page" : undefined}
      className={view === id ? "on" : ""}
      onClick={() => run(() => section(id))}
    >
      {label}
    </button>
  );
  return (
    <WorkspaceShell className={phone ? "layout android-phone" : "layout"} data-pane={panes.pane} data-columns={panes.columns}>
      <LibraryPanes
        key={vault}
        phone={phone}
        panes={panes}
        paths={paths}
        entries={vault ? entries : undefined}
        sizes={new Map(files.map((f) => [f.path, f.current_content_size]))}
        dates={new Map(files.map((f) => [f.path, f.updated_at || ""]))}
        active={note?.path || ""}
        open={openPath}
        libraryTitle="笔记库"
        vault={
          <div className="vault">
            <select
              aria-label="笔记库"
              value={vault}
              onChange={(e) => {
                if (leave()) {
                  setVault(e.target.value);
                  panes.setPane("doc");
                }
              }}
            >
              {vaults.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button aria-label="新建笔记库" onClick={newVault}>
              ＋
            </button>
          </div>
        }
        create={
          <button
            className="primary create-button"
            aria-label="新建笔记"
            disabled={!vault}
            onClick={newNote}
          >
            ＋　新建笔记
          </button>
        }
        tools={
          <>
            {goToSection("搜索", "搜索")}
            {goToSection("附件", "附件")}
            {!note && vault && (
              <button onClick={() => run(share)}>分享快照</button>
            )}{" "}
            {Object.entries({
              inbox: "收件箱",
              sent: "已发送",
              sharing: "分享管理",
              encrypted: "加密笔记库",
              导出: "导出",
              插件: "插件",
              audit: "审计日志",
              trash: "回收站",
            }).map(([id, label]) => goToSection(id, label))}
          </>
        }
        account={
          <div className="account-actions">
            {isAdmin && (
              <a
                href="/gm"
                onClick={(e) => {
                  if (!leave()) e.preventDefault();
                }}
              >
                服务端管理
              </a>
            )}
            <a
              href="/#change"
              onClick={(e) => {
                if (!leave()) e.preventDefault();
              }}
            >
              修改密码
            </a>
            <button
              onClick={() => {
                if (leave()) logout();
              }}
            >
              退出登录
            </button>
          </div>
        }
        listActions={
          <button disabled={!vault} onClick={() => picker.current?.click()}>
            上传笔记
          </button>
        }
      />
      <AppShell.Main className="workspace">
        {phone && (view !== "files" || !note) && (
          <header className="phone-head">
            <button aria-label="返回笔记列表" onClick={() => panes.setPane("list")}><PhoneIcon name="back" /></button>
          </header>
        )}
        <input
          ref={picker}
          hidden
          type="file"
          accept=".md,.txt,.json,.xmind"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
              run(async () => {
                const path = prompt("保存路径", f.name);
                if (f.size > 16 << 20) throw Error("笔记超过 16 MiB");
                if (path && leave())
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
              key={note.file_id + note.path}
              {...{
                note,
                phoneBack: phone ? () => panes.setPane("list") : undefined,
                toggleFocus: panes.toggleFocus,
                focused: panes.columns === 1,
                share: () => run(share),
                actions: (
                  <>
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
                          panes.browse(p.slice(0, p.lastIndexOf("/") + 1));
                          panes.setPane("doc");
                        })
                      }
                    >
                      移动或重命名
                    </button>
                    <button
                      onClick={() =>
                        run(async () => {
                          if (!confirm("将这篇笔记移入回收站？") || !leave())
                            return;
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
                  </>
                ),
                files,
                open,
                token,
                vault,
                origin,
                preferences,
                updatePluginSetting,
                changed: list,
                dirty: (b) => {
                  dirty.current = b;
                },
                notify: msg,
              }}
            />
          </>
        ) : view === "files" ? (
          <article className="blank-document">
            <h1>{vault ? "笔记库" : "创建你的第一个笔记库"}</h1>
            <p>
              {files.length
                ? "从笔记列表打开一篇笔记。"
                : vault
                  ? "新建笔记，或上传已有文件。"
                  : "创建笔记库，开始整理笔记。"}
            </p>
            <button className="primary" onClick={vault ? newNote : newVault}>
              {vault ? "写一篇笔记" : "创建笔记库"}
            </button>
          </article>
        ) : view === "sharing" ? (
          <Sharing key={vault} token={token} vault={vault} />
        ) : view === "audit" ? (
          <Audit token={token} />
        ) : view === "encrypted" ? (
          <EncryptedVaults io={encryptedIO} dirty={encryptedDirty} />
        ) : view === "插件" ? (
          <Manager
            preferences={preferences}
            updatePluginSetting={updatePluginSetting}
          />
        ) : ["搜索", "附件", "导出"].includes(view) ? (
          <LibraryResources
            key={vault + view}
            view={view}
            base={base}
            token={token}
            open={open}
            notify={msg}
          />
        ) : (
          <article>
            <h1>
              {view === "trash"
                ? "回收站"
                : view === "inbox"
                  ? "收件箱"
                  : "已发送"}
            </h1>
            {view === "trash" &&
              (trash.items.length ? (
                <>
                  {trash.can_manage && (
                    <button onClick={() => run(() => changeTrash("empty"))}>
                      清空回收站
                    </button>
                  )}
                  {trash.items.map((item) => {
                    const f = trash.files.find((n) => n.file_id === item.id);
                    return (
                      <div className="row" key={item.id}>
                        <span>
                          {f
                            ? entryPath(f.path, f.current_content_hash)
                            : item.name}
                          <small className="trash-expiry">
                            {item.kind === "asset" ? "附件" : "笔记"} ·{" "}
                            {new Date(
                              item.expires_at * 1000,
                            ).toLocaleDateString()}{" "}
                            起可自动清理
                          </small>
                        </span>
                        {(trash.can_manage || item.kind === "file") && (
                          <button
                            onClick={() =>
                              run(() => changeTrash("restore", item))
                            }
                          >
                            恢复
                          </button>
                        )}
                        {trash.can_manage && (
                          <button
                            onClick={() =>
                              run(() => changeTrash("purge", item))
                            }
                          >
                            彻底删除
                          </button>
                        )}
                      </div>
                    );
                  })}
                </>
              ) : (
                <p>回收站为空。</p>
              ))}
            {(view === "inbox" || view === "sent") &&
              (shares.length ? (
                shares.map((s) => (
                  <section className="share" key={s.share_id}>
                    <strong>
                      {[
                        ...s.snapshot.files.map((f) => f.path),
                        ...(s.snapshot.assets || []).map((a) => a.name),
                      ].join("、")}
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
                    {s.status === "accepted" && (
                      <CopyUpdates
                        token={token}
                        share={s}
                        sent={view === "sent"}
                        changed={list}
                      />
                    )}
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
      </AppShell.Main>
    </WorkspaceShell>
  );
}
function App() {
  const [action, setAction] = useState(accountAction);
  const [shared, setShared] = useState(readShareLocation);
  useEffect(() => {
    const navigate = () => {
      setAction(accountAction());
      const route = readShareLocation();
      setShared((old) =>
        route && !route.secret && old?.id === route.id ? old : route,
      );
    };
    window.addEventListener("hashchange", navigate);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("hashchange", navigate);
      window.removeEventListener("popstate", navigate);
    };
  }, []);

  const [token, setToken] = useState(
    sessionStorage.getItem("wenote-session") || "",
  );
  const auth = (
    <Auth
      login={(s) => {
        sessionStorage.setItem("wenote-session", s);
        setToken(s);
      }}
    />
  );
  if (action)
    return (
      <AccountAction
        key={action.name + action.secret}
        action={action}
        token={token}
      />
    );
  if (location.pathname.startsWith("/gm"))
    return (
      <Suspense fallback={<div role="status">正在载入管理后台…</div>}>
        <Admin
          token={token}
          login={setToken}
          logout={() => {
            void request(token, "/api/v1/auth/logout", "POST").catch(() => {});
            sessionStorage.removeItem("wenote-renewal");
            sessionStorage.removeItem("wenote-session");
            setToken("");
          }}
        />
      </Suspense>
    );
  if (shared)
    return (
      <PublicShare key={shared.id} entry={shared} token={token} login={auth} />
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
    auth
  );
}
createRoot(document.getElementById("root")!).render(<App />);
