import { StarButton, useNoteStars } from "./StarredNotes";
import { checkPicture, pictureTypes } from "./api";
import { markdownWritingMode } from "./markdown/modes";
import { PluginEditor } from "./plugins/PluginEditor";
import { fromBase64, type ExportFile } from "./plugins/archive";
import { handler, handlerKey, openTextDocument } from "./plugins/registry";
import PersonalSettings, { SettingsButton, useAccountProfile, type ProfileRequest } from "./PersonalSettings";
import { TextFile } from "./markdown/textFile";
import { useEffect, useRef, useState, useMemo, useCallback, useId } from "react";
import { createRoot } from "react-dom/client";
import type { RichWriting } from "./markdown/crepeSource";
import { applyDocumentText, captureInsertion, resumeWriting } from "./markdown/Source";
import type { EditorView } from "@codemirror/view";
import { Document, type Mode } from "./markdown/Markdown";
import { formatMarkdown } from "./markdown/saveFormat";
import { resolvePath, linkTarget } from "./markdown/document";
import { Resources, type ResourceClient, type Hit } from "./Resources";
import { multipart, multipartThreshold } from "./multipart";
import { base64 } from "./api";
import {
  newContent,
  containsEntry,
  entryPath,
  parentFolder,
  type EntryIO,
} from "./libraryEntries";
import { NoteInfoPanel, NoteInfoToggle } from "./NoteInfo";
import { TrashDocument, TrashList, type TrashEntry, type TrashAction } from "./TrashPane";
import { LibraryPanes, NoteHeading, usePanes } from "./LibraryUI";
import { AppShell } from "@mantine/core";
import { WorkspaceShell } from "./WorkspaceShell";
import { PhoneIcon, useAndroidPhone, useAndroidBack } from "./PhoneUI";
import {
  loadLocalPreferences,
  loadNoteMode,
  markdownPreferences,
  saveLocalPreferences,
  saveNoteMode,
  updatePluginPreferences,
  type UserPreferences,
} from "./preferences";
import "./style.css";
import "./phone.css";
import "./workspace.css";

type TrashedFile = { external: boolean; batch: string; path: string };

type Binding = {
  android?: boolean;
  vault: string;
  account?: string;
  access: () => Promise<string>;
};
declare global {
  interface Window {
    __TAURI__: {
      app: {
        onBackButtonPress: (
          listener: () => void,
        ) => Promise<{ unregister: () => Promise<void> }>;
      };
      core: { invoke: <T>(name: string, args: unknown) => Promise<T> };
    };
  }
}
function local<T>(
  vault: string,
  action: string,
  args: Record<string, unknown> = {},
) {
  return window.__TAURI__.core.invoke<T>("notebook", {
    vault,
    sessionOrigin: args.token ? localStorage.getItem("origin") : null,
    operation: { action, ...args },
  });
}
function isAsset(src: string) {
  return src.startsWith("https://wenote-draft.invalid/assets/") || /^https?:\/\/[^/]+\/assets\/(?:asset_[\w-]+|(?:[\w-]+\/[\w-]+\/)?\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}|[\w-]+\/[\w-]+\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{16})$/.test(src);
}
function LocalImage({
  binding,
  src,
  alt,
}: {
  binding: Binding;
  src: string;
  alt: string;
}) {
  const [url, set] = useState("");
  useEffect(() => {
    let live = true;
    set("");
    if (isAsset(src)) {
      binding
        .access()
        .catch(() => "")
        .then((token) =>
          local<{ type: string; data: string }>(binding.vault, "image", {
            url: src,
            token,
          }),
        )
        .then((a) => {
          if (live && a.type.startsWith("image/"))
            set(`data:${a.type};base64,${a.data}`);
        })
        .catch(() => {
          if (live) set(src);
        });
    } else if (src.startsWith("https://")) set(src);
    return () => {
      live = false;
    };
  }, [binding, src]);
  return url ? (
    <img src={url} alt={alt} referrerPolicy="no-referrer" />
  ) : (
    <span>{alt}</span>
  );
}
function Workspace({
  binding,
  close,
}: {
  binding: Binding;
  close: () => void;
}) {
  const [revisions, list] = useState<Record<string, string>>({}),
    [path, choose] = useState(""),
    [text, setText] = useState(""),
    [saved, setSaved] = useState(""),
    [base, setBase] = useState<string | null>(null),
    [mode, setMode] = useState<Mode>("read"),
    [message, notify] = useState(""),
    [busy, setBusy] = useState(false);
  const files = useMemo(
    () => Object.entries(revisions).map(([p, h]) => entryPath(p, h)),
    [revisions],
  );
  const panes = usePanes();
  const phone = useAndroidPhone(!!binding.android);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const profileRequest = useCallback<ProfileRequest>(async (action, body) => local(binding.vault, "profile", {token: await binding.access(), operation: action, body}), [binding]);
  const profile = useAccountProfile(profileRequest);
  const account = binding.account || profile.email;
  const stars = useNoteStars(
    account ? JSON.stringify([localStorage.getItem("origin"), account, binding.vault]) : undefined,
    path => path, notify,
  );
  const originalHandler = useRef("");
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [saveHost, setSaveHost] = useState<HTMLSpanElement | null>(null);
  const [localHandler, setLocalHandler] = useState("");
  const [trash, setTrash] = useState<TrashedFile[]>([]);
  const [trashKey, setTrashKey] = useState('');
  const trashRows = useMemo(() => trash.map(item => ({key:JSON.stringify([item.external,item.batch,item.path]),
    kind:item.path.endsWith('/') ? 'folder' as const : 'file' as const,path:item.path,item})),[trash]);
  const selectedTrash = trashRows.find(row => row.key === trashKey);
  const readTrash = useCallback(async (entry: TrashEntry) => {
    const row = trashRows.find(row => row.key === entry.key);
    if (!row) throw Error('回收站项目已变化');
    return fromBase64(await local<string>(binding.vault,'read_trash',{item:row.item}));
  },[binding.vault,trashRows]);
  const trashAction: TrashAction = (op,entry) => run(async () => {
    const row = trashRows.find(row => row.key === entry.key);
    if (!row || (op === 'purge' && !confirm(`永久删除「${row.path}」及其内容？`))) return;
    await local(binding.vault,op === 'purge' ? 'purge_trash' : 'restore_file',{item:row.item});
    if (trashKey === row.key) {setTrashKey('');panes.setPane('list');}
    setTrash(await local<TrashedFile[]>(binding.vault,'trash'));
    await load();
  });
  const [view, setView] = useState("笔记"),
    [newPath, setNewPath] = useState<string | null>(null);
  const [pluginBytes, setPluginBytes] = useState<Uint8Array | null>(null),
    [pluginDirty, setPluginDirty] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences>(
    loadLocalPreferences,
  );
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const panelId = useId();
  const [panelOpen, setPanelOpen] = useState(false);
  const [metadataHost, setMetadataHost] = useState<HTMLDivElement | null>(null);
  const markdown = localHandler.startsWith("com.wenote.md:");
  const rich = useRef<RichWriting | null>(null);
  const source = useRef(new TextFile("")),
    editor = useRef<EditorView | null>(null),
    picker = useRef<HTMLInputElement>(null);
  const vault = binding.vault,
    dirty = pluginDirty || text !== saved,
    editing = mode === "crepe" || mode === "edit" || mode === "split";
  const markdownSettings = markdownPreferences(preferences);
  function updatePluginSetting(pluginId: string, settings: unknown) {
    const next = updatePluginPreferences(
      preferencesRef.current,
      pluginId,
      settings,
    );
    preferencesRef.current = next;
    setPreferences(next);
    saveLocalPreferences(next);
  }
  function changeMode(next: Mode) {
    setMode(next);
    if (
      next !== "edit" && markdown &&
      markdownPreferences(preferencesRef.current).rememberNoteMode
    )
      saveNoteMode(vault, path, next);
  }
  const leave = () => !dirty || confirm("放弃尚未保存的编辑？");
  function back() {
    if (busy) return;
    if (newPath !== null) {
      setNewPath(null);
      panes.setPane("list");
      return;
    }
    if (panes.pane === "doc") {
      panes.setPane("list");
      return;
    }
    if (panes.pane === "nav") {
      panes.setPane("list");
      return;
    }
    if (panes.query) {
      panes.search("");
      return;
    }
    if (panes.folder !== null || panes.starredOnly) {
      panes.browse(panes.folder ? parentFolder(panes.folder) : null);
      return;
    }
    if (leave()) close();
  }
  useAndroidBack(phone, back);
  const client = useMemo<ResourceClient>(
    () => ({
      json: async (route) =>
        local(vault, "catalog", {
          token: await binding.access(),
          route,
        }),
      createExport: async (scope, portable) => {
        await local(vault, "create_export", {
          token: await binding.access(),
          scope,
          mode: portable ? "portable" : null,
        });
      },
      save: async (kind, id) => local<string>(vault, "download", {
        kind, id, token: await binding.access(),
      }),
    }),
    [binding],
  );
  const searchContent = useCallback((query: string) => local<string[]>(vault,"search_notes",{query,paths:files.filter(p=>!p.endsWith("/"))}),[vault,files]);
  const loadBacklinks = useCallback(async (): Promise<Hit[]> => {
    const id = await local<string | null>(vault, "file_id", { path });
    return id ? client.json("/links/backlinks?file_id=" + encodeURIComponent(id)) : [];
  }, [client, path, vault]);
  async function load() {
    list(await local<Record<string, string>>(vault, "library"));
  }
  useEffect(() => {
    load().catch((e) => notify(String(e)));
  }, [vault]);
  useEffect(() => {
    function warn(e: BeforeUnloadEvent) {
      if (dirty) e.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    const writing = editor.current?.hasFocus ? editor.current : rich.current?.focusedView();
    const trigger = document.activeElement;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
      if (writing) resumeWriting(writing, trigger);
    }
  }
  async function open(p: string, discardConfirmed = false, writing = false) {
    if (!discardConfirmed && p === path && (phone || view === "笔记")) {
      setView("笔记");
      panes.setPane("doc");
      return;
    }
    if (!discardConfirmed && !leave()) return;
    const plugin = handler(p);
    const result = await local<{ data: string; hash: string }>(vault, "read_bytes", { path: p });
    const bytes = fromBase64(result.data);
    const doc = openTextDocument(plugin, bytes);
    setLocalHandler(handlerKey(p));
    setPluginBytes(doc ? null : bytes);
    setPluginDirty(false);
    source.current = doc ?? new TextFile("");
    setText(source.current.text);
    setSaved(source.current.text);
    setBase(result.hash);
    choose(p);
    setPanelOpen(false);
    panes.setPane("doc");
    setView("笔记");
    const md = plugin.manifest.id === "com.wenote.md";
    const settings = markdownPreferences(preferencesRef.current);
    const remembered = md && settings.rememberNoteMode
      ? loadNoteMode(vault, p)
      : undefined;
    const preferred = remembered ?? settings.defaultMode;
    let nextMode: Mode = "read";
    if (doc && writing) nextMode = md ? markdownWritingMode(remembered, settings.defaultMode) : "edit";
    else if (doc && !phone) nextMode = md ? preferred : "edit";
    setMode(nextMode);
    notify("");
  }
  const output: ExportFile = async (name, bytes) => {
    if (binding.android) {
      await window.__TAURI__.core.invoke("mobile_control", {
        action: "exportDocument",
        payload: { name, data: base64(bytes) },
      });
      return;
    }
    const dest = await local<string>(vault, "export_bytes", {
      name,
      data: base64(bytes),
    });
    notify("已保存到 " + dest);
  };
  const entries: EntryIO = {
    revisions,
    read: async (p) =>
      fromBase64(
        (await local<{ data: string }>(vault, "read_bytes", { path: p })).data,
      ),
    write: async (p, bytes) => {
      await local(vault, "save_bytes", {
        path: p,
        base: null,
        data: base64(bytes),
      });
    },
    change: async (operation, source, destination, expected) => {
      const affected =
        path && operation !== "copy" && containsEntry(source, path);
      if (affected && dirty) throw Error("请先保存正在编辑的笔记");
      await local(vault, "change_entry", {
        operation,
        source,
        destination,
        expected,
      });
      if (operation !== "copy") stars.changePaths(source, operation === "move" ? destination : undefined);
      if (affected) {
        if (operation === "delete") {
          choose("");
          setPluginBytes(null);
          setText("");
          setSaved("");
        } else {
          await open(destination + path.slice(source.length), true);
          if (phone) panes.setPane("list");
        }
      }
    },
    refresh: load,
    output,
    image: (src, alt) => <LocalImage binding={binding} src={src} alt={alt} />,
    openCreated: async (p) => {
      if (!dirty) await open(p, true, phone);
    },
    print: async (name) => {
      if (binding.android)
        await window.__TAURI__.core.invoke("mobile_control", {
          action: "printNote",
          payload: { name },
        });
      else if (/Mac/.test(navigator.platform))
        await window.__TAURI__.core.invoke("print_note", {});
      else window.print();
    },
  };
  async function savePlugin(data: Uint8Array) {
    setBusy(true);
    try {
      setBase(
        await local<string>(vault, "save_bytes", {
          path,
          base,
          data: base64(data),
        }),
      );
      await load();
      notify("已保存到本地目录");
    } finally {
      setBusy(false);
    }
  }
  function formatBeforeSave() {
    if (!markdown || !markdownSettings.autoFormatOnSave) return;
    const current = source.current.text,
      formatted = formatMarkdown(current, markdownSettings).text,
      cm = editor.current;
    if (formatted === current) return;
    if (cm && cm.state.doc.toString() === current) {
      applyDocumentText(cm, formatted);
    } else {
      source.current.edit(formatted);
      setText(formatted);
    }
  }
  async function save() {
    await rich.current?.compositionEnd();
    formatBeforeSave();
    const submitted = source.current.text;
    const raw = source.current.serialize();
    const hash = await local<string>(vault, "save", { path, base, text: raw });
    setBase(hash);
    setSaved(submitted);
    await load();
    notify("已保存到本地目录");
  }
  function edit(next: string) {
    source.current.edit(next);
    setText(next);
  }
  async function uploadFile(f: File) {
    checkPicture(f);
    if (f.size > 256 << 20) throw Error("图片超过 256 MiB");
    async function stage() {
      const url = await local<string>(vault,"stage_image",{name:f.name,media:f.type,data:base64(new Uint8Array(await f.arrayBuffer()))});
      notify("图片已存到本机，保存笔记并同步后将生成正式地址");
      return url;
    }
    const token = await binding.access().catch(() => "");
    const fileID = await local<string | null>(vault, "file_id", { path });
    if (!fileID || !token || !navigator.onLine) return stage();
    const transfer = async <T,>(
      step: string,
      args: Record<string, unknown> = {},
    ) =>
      local<T>(vault, "transfer", {
        token: await binding.access(),
        request: { step, ...args },
      });
    try { return f.size >= multipartThreshold
        ? await multipart(
            f,
            [
              localStorage.getItem("origin") || "",
              vault, path,
              (await transfer<{ id: string }>("user")).id,
            ],
            {
              create: (meta, key) => transfer("create", { meta: { ...meta, file_id: fileID }, key }),
              parts: (id) => transfer("parts", { id }),
              put: (id, number, range, hash, data) =>
                transfer("put", {
                  id,
                  number,
                  range,
                  hash,
                  data: base64(data),
                }),
              assemble: (id) => transfer("assemble", { id }),
            },
            notify,
            (slot, complete) =>
              local(vault, "upload_key", { slot, complete }),
          )
        : await local<string>(vault, "upload", {
            path, token,
            name: f.name,
            media: f.type || "application/octet-stream",
            data: base64(new Uint8Array(await f.arrayBuffer())),
          });
    } catch (error) {
      if (/network|connect|offline|error sending request|timed out|failed to fetch/i.test(String(error))) return stage();
      throw error;
    }
  }
  async function attach(input: File[]) {
    const insertHere = rich.current?.insertion() ?? captureInsertion(editor.current),
      file = source.current;
    const links = [];
    for (const f of input) {
      const url = await uploadFile(f);
      links.push(
        (f.type.startsWith("image/") ? "!" : "") +
          "[" +
          f.name.replace(/[\\\[\]\r\n]/g, "_") +
          "](" +
          url +
          ")",
      );
    }
    const value = "\n" + links.join("\n") + "\n";
    if (file === source.current && !insertHere?.(value)) {
      edit(file.text + value);
      changeMode(markdown ? "split" : "edit");
    }
  }
  const fileContent = pluginBytes ? (
    <PluginEditor
      key={path + localHandler}
      path={path}
      bytes={pluginBytes}
      save={savePlugin}
      output={output}
      dirty={setPluginDirty}
      notify={notify}
      actionHost={actionHost}
      saveHost={saveHost}
    />
  ) : (
    <>
      <input
        type="file"
        hidden
        ref={picker}
        accept={pictureTypes}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) run(() => attach([f]));
          e.target.value = "";
        }}
      />
      <div className="document-body" inert={busy}>
        <Document
          metadataHost={panelOpen ? metadataHost : null}
          resolveNote={raw => resolvePath(path, raw, files)}
          writing={rich}
          upload={uploadFile}
          imageURL={async url => {
            if (!isAsset(url)) return url;
            const asset = await local<{ type: string; data: string }>(vault, "image", { url, token: await binding.access().catch(() => "") });
            return `data:${asset.type};base64,${asset.data}`;
          }}
          key={path}
          focusSource={phone && (mode === "edit" || mode === "split")}
          attach={markdown ? () => picker.current?.click() : undefined}
          markdown={markdown}
          text={text}
          edit={edit}
          mode={mode}
          setMode={changeMode}
          editor={editor}
          preferences={
            markdown ? markdownSettings : undefined
          }
          onPreferencesChange={
            markdown
              ? (patch) =>
                  updatePluginSetting("com.wenote.md", {
                    ...markdownSettings,
                    ...patch,
                  })
              : undefined
          }
          io={{
            image: (src, alt) => (
              <LocalImage binding={binding} src={src} alt={alt} />
            ),
            link: (href) => {
              if (
                /^https:\/\/[^/]+\/assets\/asset_[\w-]+$/.test(
                  href,
                )
              ) {
                run(async () => {
                  const dest = await client.save(
                    "asset",
                    new URL(href).pathname.split("/").at(-1)!,
                    "附件",
                  );
                  if (dest) notify("已保存到 " + dest);
                });
                return true;
              }
              if (/^[\w+.-]+:/.test(href)) return false;
              const raw = linkTarget(href);
              const found = resolvePath(path, raw, files);
              if (found) run(() => open(found));
              else notify("找不到目标笔记 · " + raw);
              return true;
            },
          }}
        />
      </div>
    </>
  );
  return (
    <WorkspaceShell
      className={"layout local-layout" + (phone ? " android-phone" : "")}
      data-pane={panes.pane}
      data-columns={panes.columns}
      onPasteCapture={(e) => {
        if (
          markdown && !pluginBytes &&
          view === "笔记" &&
          editing &&
          e.clipboardData.files.length
        ) {
          e.preventDefault();
          e.stopPropagation();
          run(() => attach(Array.from(e.clipboardData.files)));
        }
      }}
      onKeyDown={(e) => {
        if (
          view === "笔记" &&
          path &&
          !pluginBytes &&
          (e.ctrlKey || e.metaKey) &&
          e.key === "s"
        ) {
          e.preventDefault();
          run(save);
        }
      }}
    >
      <LibraryPanes key={vault}
        phone={phone}
        stars={stars}
        paths={files}
        entries={entries}
        panes={panes}
        active={view === "笔记" ? path : ""}
        busy={busy}
        open={(p) => run(() => open(p))}
        libraryTitle="本地笔记库"
        vault={<strong className="local-vault">本地笔记库</strong>}
        create={
          <button
            className="primary create-button"
            aria-label="新建笔记"
            disabled={busy}
            onClick={() => {
              setNewPath((panes.folder || "") + "未命名.md");
              panes.setPane("doc");
            }}
          >
            ＋　新建笔记
          </button>
        }
        avatar={<SettingsButton avatar={profile.avatar} open={() => {originalHandler.current = handlerKey(path);setSettingsOpen(true);}}/>}
        allNotes={() => {if (!leave()) return false; setView("笔记");choose("");setPluginBytes(null);setPluginDirty(false);setSaved(text);return true;}}
        searchContent={searchContent}
        historyKey={vault}
        trash={{ active: view === "回收站", disabled: busy, open: () => run(async () => {
          if (!leave()) return;
          setTrash(await local<TrashedFile[]>(vault, "trash"));
          choose(""); setPluginBytes(null); setPluginDirty(false); setSaved(text); setNewPath(null);
          setView("回收站"); setTrashKey(''); panes.browse(null);
        }), list:<TrashList entries={trashRows} selected={trashKey} select={entry => {
          setTrashKey(entry.key);panes.setPane(entry.kind === 'file' ? 'doc' : 'list');
        }} action={trashAction} canPurge busy={busy}/> }}
        listActions={
          <>
            {" "}
            <label className="file-action">
              导入笔记
              <input
                type="file"
                disabled={busy}
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (!f) return;
                  run(async () => {
                    if (!leave()) return;
                    if (f.size > 16 << 20) throw Error("笔记超过 16 MiB");
                    const raw = new Uint8Array(await f.arrayBuffer());
                    await local(vault, "save_bytes", {
                      path: f.name,
                      base: null,
                      data: base64(raw),
                    });
                    await load();
                    await open(f.name, true);
                  });
                }}
              />
            </label>
            <button disabled={busy} onClick={() => run(load)}>
              刷新列表
            </button>
          </>
        }
      />
      {settingsOpen && <PersonalSettings profile={profile} request={profileRequest} phone={phone} close={() => {setSettingsOpen(false); if(path && !dirty && view === "笔记" && originalHandler.current !== handlerKey(path)) void run(() => open(path,true));}} confirmLeave={leave} logout={() => {close();document.getElementById("logout")?.click();}} sync={close} exportPanel={<Resources client={client}/>} preferences={preferences} updatePluginSetting={updatePluginSetting}/>}
      <AppShell.Main className="workspace">
        {phone && view !== "笔记" && (
          <header className="phone-head">
            <button aria-label="返回笔记列表" onClick={back}>
              <PhoneIcon name="back" />
            </button>
          </header>
        )}
        {newPath !== null && (
          <form
            className="new-path"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                if (!leave()) return;
                await local(vault, "save_bytes", {
                  path: newPath,
                  base: null,
                  data: base64(await newContent(newPath)),
                });
                await open(newPath, true, true);
                setNewPath(null);
                await load();
              });
            }}
          >
            <label>
              新笔记路径
              <input
                autoFocus
                required
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
              />
            </label>
            <button disabled={busy}>创建</button>
            <button type="button" onClick={() => setNewPath(null)}>
              取消
            </button>
          </form>
        )}
        {message && (
          <p className="message" role="status">
            {message}
          </p>
        )}
        {view !== "笔记" ? (
          selectedTrash?.kind === 'file' ? <TrashDocument key={selectedTrash.key} entry={selectedTrash} read={readTrash}
            io={{image:entries.image}} action={trashAction} canPurge busy={busy}/> : <article className="trash-blank"/>
        ) : (
          <article className={path ? "document" : "blank-document"}>
            {!path && (
              <>
                <h1>本地笔记库</h1>
                <p>
                  {files.length
                    ? "从笔记列表打开一篇笔记。"
                    : "新建笔记，或导入本地文件。"}
                </p>
              </>
            )}
            {path && (
              <>
                <NoteHeading
                  handset={
                    phone
                      ? {
                          back,
                          dirty,
                          edit: () => changeMode(markdown ? markdownWritingMode(
                            markdownSettings.rememberNoteMode ? loadNoteMode(vault, path) : undefined,
                            markdownSettings.defaultMode,
                          ) : "edit"),
                          finish: () =>
                            run(async () => {
                              if (text !== saved) await save();
                              setMode("read");
                            }),
                        }
                      : undefined
                  }
                  path={path}
                  endAction={<><StarButton stars={stars} path={path}/><NoteInfoToggle id={panelId} expanded={panelOpen} toggle={() => setPanelOpen(open => !open)} /></>}
                  mode={mode}
                  change={pluginBytes ? undefined : changeMode}
                  markdown={markdown}
                  busy={busy}
                  share={
                    binding.android && !pluginBytes
                      ? {
                          label: "系统分享",
                          run: () =>
                            run(async () => {
                              if (new Blob([text]).size > 256 * 1024)
                                throw Error("系统文本分享限 256 KiB");
                              await window.__TAURI__.core.invoke(
                                "mobile_control",
                                {
                                  action: "share",
                                  payload: {
                                    title: path,
                                    text: source.current.serialize(),
                                  },
                                },
                              );
                            }),
                        }
                      : undefined
                  }
                  fileActions={pluginBytes ? <div className="file-actions-slot" ref={setActionHost} /> : null}
                  save={
                    pluginBytes ? <span ref={setSaveHost} /> : (
                      <button
                        className="save-button"
                        disabled={busy || text === saved}
                        onClick={() => run(save)}
                      >
                        {text === saved ? "已保存" : "保存"}
                      </button>
                    )
                  }
                  more={
                    <>
                      {!pluginBytes && <button disabled={busy} onClick={() => run(async () => {
                        await output(path.split("/").at(-1)!, await entries.read(path));
                      })}>下载原文件</button>}
                      {!phone && (
                        <button
                          onClick={() =>
                            panes.toggleFocus()
                          }
                        >
                          {panes.columns === 1 ? "退出专注" : "专注模式"}
                        </button>
                      )}
                    </>
                  }
                />
                <div className="document-body note-workspace">
                  <div className={pluginBytes ? "note-aux-view" : "note-content"}>{fileContent}</div>
                  {panelOpen && <NoteInfoPanel id={panelId} metadata={setMetadataHost} load={loadBacklinks} open={hit => run(() => open(hit.path))} />}
                </div>
              </>
            )}
          </article>
        )}
      </AppShell.Main>
    </WorkspaceShell>
  );
}
const root = createRoot(document.getElementById("desktop-editor")!);
window.addEventListener("open-notebook", (e) => {
  const binding = (e as CustomEvent<Binding>).detail,
    settings = document.querySelector("body > main") as HTMLElement;
  settings.hidden = true;
  root.render(
    <Workspace
      binding={binding}
      close={() => {
        root.render(null);
        settings.hidden = false;
      }}
    />,
  );
});
