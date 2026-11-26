import { CreateNoteWindow } from "./CreateNoteWindow";
import { useNoteStars } from "./StarredNotes";
import { lazy, Suspense, useCallback, useMemo } from "react";
import {
  Sharing,
  Audit,
  PublicShare,
  readShareLocation,
} from "./Sharing";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { handlerKey } from "./plugins/registry";
import PersonalSettings, { SettingsButton, useAccountProfile, type ProfileRequest } from "./PersonalSettings";
import { browserExport } from "./plugins/archive";
import {
  containsEntry,
  entryName,
  entryPath,
  isFolder,
  type EntryIO,
} from "./libraryEntries";
import Editor, { AssetImage } from "./Editor";
import { TrashDocument, TrashList, type TrashEntry, type TrashAction } from "./TrashPane";
import { useMediaQuery } from "@mantine/hooks";
import { PhoneIcon } from "./PhoneUI";
import { AppShell } from "@mantine/core";
import { WorkspaceShell } from "./WorkspaceShell";
import { LibraryResources } from "./Resources";
import { rememberSession, base64, Note, request, Vault } from "./api";
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
function Auth({ login, compact = false }: { login: (s: string) => void; compact?: boolean }) {
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
    <div className={compact ? "share-auth" : "auth"}>
      {!compact && <Cover />}
      <div className="entry-form">
        {compact ? <h3>{register ? "创建账户" : "登录"}</h3> : <h1>{register ? "创建账户" : "打开你的笔记库"}</h1>}
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
  batch?: string;
  folder?: string;
};
function Library({ token, logout }: { token: string; logout: () => void }) {
  const [vaults, setVaults] = useState<Vault[]>([]),
    [vault, setVault] = useState(""),
    [files, setFiles] = useState<Note[]>([]),
    [note, setNote] = useState<Note | null>(null),
    [view, setView] = useState("files"),
    [trashRevision, refreshTrash] = useState(0),
    [trash, setTrash] = useState<{
      files: Note[];
      items: TrashItem[];
      can_manage: boolean;
    }>(),
    [trashSelected, setTrashSelected] = useState(""),
    [trashBusy,setTrashBusy] = useState(false),
    [trashError,setTrashError] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false),
    [message, msg] = useState(""),
    [origin, setOrigin] = useState(location.origin),
    [preferences, setPreferences] =
      useState<UserPreferences>(loadLocalPreferences);
  const initialLocation = useRef(new URLSearchParams(location.search));
  const [editorRevision, setEditorRevision] = useState(0);
  const originalHandler = useRef("");
  function openSettings() {
    originalHandler.current = note ? handlerKey(note.path) : "";
    setSettingsOpen(true);
  }
  function closeSettings() {
    setSettingsOpen(false);
    if (note && !dirty.current && originalHandler.current !== handlerKey(note.path)) setEditorRevision(n => n + 1);
  }
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [createAnchor, setCreateAnchor] = useState<HTMLButtonElement | null>(null);
  const panes = usePanes();
  const phone = !!useMediaQuery("(max-width: 720px)");
  const profileRequest = useCallback<ProfileRequest>(async (action, body) => {
    const paths = {me:"/api/v1/me",avatar:"/api/v1/me/avatar",saveAvatar:"/api/v1/me/avatar",password:"/api/v1/auth/password/change"};
    const response = await request(token, paths[action], action === "password" ? "POST" : body ? "PUT" : "GET", body);
    return response.status === 204 ? {} : response.json();
  }, [token]);
  const profile = useAccountProfile(profileRequest);
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
    if (!v.length) panes.setPane("nav");
    setVault((x) => x || v.find(item => item.id === initialLocation.current.get("vault"))?.id || v[0]?.id || "");
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
          const wanted = vault === initialLocation.current.get("vault") &&
            (result.files as Note[]).find(f => f.file_id === initialLocation.current.get("note"));
          if (wanted) {
            panes.setPane("doc");
            initialLocation.current = new URLSearchParams();
          }
          setNote(wanted || (result.files as Note[]).find(
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
  useEffect(() => {
    if (view !== "trash" || !vault) return;
    let live = true;
    request(token, base + "/trash").then(r => r.json()).then(data => {
      if (live) setTrash(data);
    }).catch(e => { if (live) setTrashError(String(e)); });
    return () => { live = false; };
  }, [token, base, view, trashRevision]);
  function openTrash() {
    if (!leave()) return;
    setNote(null);
    setTrash(undefined);
    setTrashSelected("");
    setTrashError('');
    setView("trash");
    refreshTrash(n => n + 1);
    panes.browse(null);
  }
  const trashEntries = useMemo(() => {
    if (!trash) return undefined;
    const notes = new Map(trash.files.map(file => [file.file_id,file]));
    const rows = new Map<string,TrashEntry>();
    for (const item of trash.items) {
      const file = notes.get(item.id);
      const path = item.folder || (file ? entryPath(file.path,file.current_content_hash) : item.name);
      const key = item.batch ? `folder:${item.batch}` : item.id;
      const kind = item.folder || isFolder(path) ? 'folder' : item.kind;
      const expiry = new Date(item.expires_at * 1000).toLocaleDateString();
      rows.set(key,{key,path,kind,detail:`${path} · ${expiry} 起可自动清理`});
    }
    return Array.from(rows.values()).sort((a,b) => Number(b.kind === 'folder') - Number(a.kind === 'folder'));
  }, [trash]);
  const selectedTrash = trashEntries?.find(item => item.key === trashSelected);
  const readTrash = useCallback(async (entry: TrashEntry) => new Uint8Array(await
    (await request(token,`${base}/trash/files/${entry.key}/content`)).arrayBuffer()),[token,base]);
  async function changeTrash(operation: 'restore' | 'purge' | 'empty', entry?: TrashEntry) {
    if (trashBusy || !trash) return;
    if (operation === 'empty' && !confirm('彻底清空这个笔记库的回收站？仍被引用的项目将保留。')) return;
    if (operation === 'purge' && entry && !confirm(`永久删除「${entryName(entry.path)}」及其内容？`)) return;
    setTrashBusy(true);
    try {
      const file = entry && trash.files.find(f => f.file_id === entry.key);
      if (operation === 'restore' && file && entry) {
        await request(token,`${base}/files/${file.file_id}/restore`,'POST',{
          base_version_id:file.current_version_id, base_path:file.path,
          path: entry.kind === 'folder' ? file.path : undefined,
        });
      } else {
        const result = await (await request(token,base + '/trash','POST',{
          operation,kind:file ? 'file' : entry?.kind,id:entry?.key.replace(/^folder:/,''),
        })).json();
        if (result.retained) msg(`${result.retained} 个项目仍被引用，已保留。`);
      }
      if (!entry || entry.key === trashSelected) {setTrashSelected('');panes.setPane('list');}
      await list();
    } finally {
      refreshTrash(n => n+1);
      setTrashBusy(false);
    }
  }
  const trashAction: TrashAction = (op,entry) => void run(() => changeTrash(op,entry));
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
  const searchContent = useCallback(async (query: string) => {
    if (!vault) return [];
    const hits: {path:string}[] = await (await request(token, base + "/search?" + new URLSearchParams({q:query}))).json();
    return hits.map(hit => hit.path);
  },[base,token,vault,files]);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const stars = useNoteStars(profile.email && vault ? JSON.stringify([profile.email, vault]) : undefined,
    path => byPath.get(path)?.file_id, msg);
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
  return (
    <WorkspaceShell className={phone ? "layout android-phone" : "layout"} data-pane={panes.pane} data-columns={panes.columns}>
      <LibraryPanes
        key={vault}
        phone={phone}
        panes={panes}
        stars={stars}
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
        create={setCreateAnchor}
        avatar={<SettingsButton avatar={profile.avatar} open={openSettings}/>}
        searchContent={searchContent}
        historyKey={vault}
        trash={{active:view === 'trash',disabled:!vault,open:openTrash,list:<TrashList
          entries={trashEntries} error={trashError} selected={trashSelected} action={trashAction} busy={trashBusy} canPurge={!!trash?.can_manage}
          select={entry => {setTrashSelected(entry.key);panes.setPane(entry.kind === 'file' ? 'doc' : 'list');}}
          footer={!!trashEntries?.length && trash?.can_manage && <button disabled={trashBusy} onClick={() => run(() => changeTrash('empty'))}>清空回收站</button>}/>}}
        allNotes={() => { if (view === 'trash') setView('files'); return true; }}
        listActions={
          <button disabled={!vault} onClick={() => picker.current?.click()}>
            上传笔记
          </button>
        }
      />
      {createAnchor && vault && <CreateNoteWindow anchor={createAnchor} phone={phone} folder={panes.folder || ""}
        paths={paths} io={entries} close={() => setCreateAnchor(null)}
        createAtPath={async (path, bytes) => { if (leave()) await create(path, bytes); }}
        browse={folder => { setView("files"); panes.browse(folder); }} />}
      {settingsOpen && <PersonalSettings profile={profile} request={profileRequest} phone={phone} close={closeSettings} confirmLeave={() => !dirty.current || confirm("放弃尚未保存的编辑？")} logout={logout} preferences={preferences} updatePluginSetting={updatePluginSetting}
        exportPanel={vault ? <><p>当前笔记库 · {vaults.find(v => v.id === vault)?.name}</p><LibraryResources base={base} token={token} onImported={list} viewFolder={folder => { if (!leave()) return; setNote(null); setView("files"); panes.browse(folder ? folder + "/" : null); closeSettings(); }}/></> : <p>请先选择笔记库。</p>}
        audit={<Audit token={token}/>} manage={profile.admin && <a href="/gm" onClick={e => {if(!leave()) e.preventDefault();}}>服务端管理</a>}
        shares={<Sharing token={token} vaults={vaults}/>}/>}
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
              key={JSON.stringify([note.file_id, note.path, editorRevision])}
              {...{
                note,
                stars,
                phoneBack: phone ? () => panes.setPane("list") : undefined,
                toggleFocus: panes.toggleFocus,
                focused: panes.columns === 1,
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
            <button className="primary" aria-haspopup={vault ? "dialog" : undefined} onClick={e => vault ? setCreateAnchor(e.currentTarget) : newVault()}>
              {vault ? "写一篇笔记" : "创建笔记库"}
            </button>
          </article>
        ) : selectedTrash?.kind === 'file' ? (
          <TrashDocument key={selectedTrash.key} entry={selectedTrash} read={readTrash} io={{image:entries.image}}
            action={trashAction} busy={trashBusy} canPurge={!!trash?.can_manage}/>
        ) : (
          <article className="trash-blank" aria-label="回收站空白内容区" />
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
      compact={!!shared}
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
