import { markdownWritingMode } from "./markdown/modes";
import { NoteInfoToggle, NoteInfoPanel } from "./NoteInfo";
import { NoteHeading } from "./LibraryUI";
import { PluginEditor, MarkdownExport } from "./plugins/PluginEditor";
import { browserExport } from "./plugins/archive";
import { usesPluginEditor } from "./plugins/registry";
import { TextFile } from "./markdown/textFile";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RichWriting } from "./markdown/crepeSource";
import { applyDocumentText, captureInsertion, resumeWriting } from "./markdown/Source";
import type { EditorView } from "@codemirror/view";
import { Document, type Mode } from "./markdown/Markdown";
import { formatMarkdown } from "./markdown/saveFormat";
import { resolvePath, linkTarget } from "./markdown/document";
import { download } from "./Resources";
import { base64, Note, pictureTypes, request, uploadAsset, Version } from "./api";
import {
  loadNoteMode,
  markdownPreferences,
  xmindPreferences,
  saveNoteMode,
  type UserPreferences,
} from "./preferences";

import { prepareNoteLink } from "./Sharing";

type Props = {
  actions: ReactNode;
  phoneBack?: () => void;
  focused: boolean;
  toggleFocus: () => void;
  note: Note;
  files: Note[];
  open: (id: string) => void;
  token: string;
  vault: string;
  origin: string;
  changed: () => Promise<void>;
  dirty: (flag: boolean) => void;
  notify: (msg: string) => void;
  preferences: UserPreferences;
  updatePluginSetting: (pluginId: string, settings: unknown) => void;
};
export function AssetImage({
  src,
  alt,
  token,
  origin,
}: {
  src?: string;
  alt?: string;
  token: string;
  origin: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true,
      object = "";
    setUrl("");
    if (src?.startsWith(origin + "/assets/")) {
      request(token, new URL(src).pathname)
        .then((r) => r.blob())
        .then((b) => {
          if (live) {
            object = URL.createObjectURL(b);
            setUrl(object);
          }
        })
        .catch(() => {});
    } else if (src?.startsWith("https://")) setUrl(src);
    return () => {
      live = false;
      if (object) URL.revokeObjectURL(object);
    };
  }, [src, token, origin]);
  return url ? (
    <img src={url} alt={alt || ""} referrerPolicy="no-referrer" />
  ) : (
    <span>{alt}</span>
  );
}
export default function Editor({
  actions,
  phoneBack,
  focused,
  toggleFocus,
  note,
  files,
  open,
  token,
  vault,
  origin,
  changed,
  dirty,
  notify,
  preferences,
  updatePluginSetting,
}: Props) {
  const path = `/api/v1/vaults/${vault}/files/${note.file_id}`;
  const [shareURL, setShareURL] = useState("");
  const pendingShare = useRef<ReturnType<typeof prepareNoteLink> | null>(null);
  const shareDialog = useRef<HTMLDialogElement>(null);
  const [shareDays, setShareDays] = useState(7);
  const [pluginDirty, setPluginDirty] = useState(false);
  function openShare() {
    setShareDays(7);
    setShareURL("");
    pendingShare.current = null;
    shareDialog.current?.showModal();
  }
  async function generateLink() {
    pendingShare.current ??= prepareNoteLink(token, vault, note.path, shareDays);
    setShareURL(await pendingShare.current());
    pendingShare.current = null;
  }
  const markdownSettings = markdownPreferences(preferences);
  const [text, setText] = useState(""),
    [base, setBase] = useState(""),
    [mode, setMode] = useState<Mode | "history">(() => {
      if (phoneBack || note.format !== "md") return "read";
      return (
        (markdownSettings.rememberNoteMode
          ? loadNoteMode(vault, note.file_id)
          : undefined) || markdownSettings.defaultMode
      );
    }),
    [versions, setVersions] = useState<Version[]>([]),
    [history, setHistory] = useState(""),
    [busy, setBusy] = useState(false);
  const [special] = useState(() => usesPluginEditor(note.path));
  const panelId = useId();
  const [panelOpen, setPanelOpen] = useState(false);
  const [metadataHost, setMetadataHost] = useState<HTMLDivElement | null>(null);
  const loadBacklinks = useCallback(async () => (await request(token,
    `/api/v1/vaults/${vault}/links/backlinks?file_id=${encodeURIComponent(note.file_id)}`)).json(), [token, vault, note.file_id]);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const rich = useRef<RichWriting | null>(null);
  const source = useRef(new TextFile("")),
    saved = useRef("");
  const assetPicker = useRef<HTMLInputElement>(null);
  const editor = useRef<EditorView | null>(null);
  useEffect(() => {
    let live = true;
    request(token, path + "/content")
      .then(async (r) => {
        const buf = new Uint8Array(await r.arrayBuffer());
        if (!live) return;
        if (special) {
          setBytes(buf);
          setBase(r.headers.get("X-Version-Id") || note.current_version_id);
          return;
        }
        const str = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buf);
        if (live) {
          source.current = new TextFile(str);
          saved.current = source.current.text;
          setText(source.current.text);
          setBase(r.headers.get("X-Version-Id") || note.current_version_id);
        }
      })
      .catch((e) => {
        if (live) notify(e.message);
      });
    return () => {
      live = false;
    };
  }, [token, path]);
  function edit(value: string) {
    source.current.edit(value);
    setText(value);
    dirty(value !== saved.current);
  }
  function changeMode(next: Mode) {
    setMode(next);
    if (next !== "edit" && note.format === "md" && markdownSettings.rememberNoteMode)
      saveNoteMode(vault, note.file_id, next);
  }
  function changeMarkdownSettings(
    patch: Partial<typeof markdownSettings>,
  ) {
    updatePluginSetting("com.wenote.md", { ...markdownSettings, ...patch });
  }
  async function run(f: () => Promise<void>) {
    const writing = editor.current?.hasFocus ? editor.current : null;
    setBusy(true);
    try {
      await f();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
      if (writing) resumeWriting(writing);
    }
  }
  function formatBeforeSave() {
    if (note.format !== "md" || !markdownSettings.autoFormatOnSave) return;
    const current = source.current.text,
      formatted = formatMarkdown(current, markdownSettings).text,
      cm = editor.current;
    if (formatted === current) return;
    if (cm && cm.state.doc.toString() === current) {
      applyDocumentText(cm, formatted);
    } else {
      source.current.edit(formatted);
      setText(formatted);
      dirty(formatted !== saved.current);
    }
  }
  async function save() {
    await rich.current?.compositionEnd();
    formatBeforeSave();
    const submitted = source.current.text;
    const value = source.current.serialize();
    const replacements = await persistBytes(new TextEncoder().encode(value));
    if (!alive.current) return;
    const rewrite = (s: string) => Object.entries(replacements ?? {}).reduce((v,[old,url]) => v.split(old).join(url),s);
    if (replacements) {
      const text = rewrite(source.current.text);
      source.current.edit(text);
      setText(text);
    }
    saved.current = rewrite(submitted);
    dirty(source.current.text !== saved.current);
  }
  async function saveBytes(data: Uint8Array) { await persistBytes(data); }
  async function persistBytes(data: Uint8Array): Promise<Record<string,string> | undefined> {
    const out = await (
      await request(token, path + "/content", "PUT", {
        base_version_id: base,
        content: base64(data),
      })
    ).json();
    if (!alive.current) return;
    setBase(out.version_id);
    await changed();
    notify("已保存新版本");
    return out.image_urls;
  }
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function insert(files: File[]) {
    const fileAtStart = source.current;
    const insertHere = rich.current?.insertion() ?? captureInsertion(editor.current);
    const parts = [];
    for (const file of files) {
      const url = await uploadAsset(token, vault, note.file_id, file, notify);
      parts.push(
        (file.type.startsWith("image/") ? "!" : "") +
          "[" +
          file.name.replace(/[\\[\]\r\n]/g, "_") +
          "](" +
          url +
          ")",
      );
    }
    if (!alive.current || source.current !== fileAtStart) return;
    const inserted = "\n" + parts.join("\n") + "\n";
    if (!insertHere?.(inserted)) {
      edit(source.current.text + inserted);
      setMode(note.format === "md" ? "split" : "edit");
    }
  }
  const draftShare = pluginDirty || text !== saved.current;
  const editing = mode === "crepe" || mode === "edit" || mode === "split";
  function navigate(href: string, label: string) {
    if (href.startsWith(origin + "/assets/")) {
      run(() => download(token, new URL(href).pathname, label || "附件"));
      return true;
    }
    if (href.startsWith("#user-content-")) return false;
    if (!/^[\w+.-]+:|^\/\//.test(href)) {
      const raw = linkTarget(href);
      const target = resolvePath(
        note.path,
        raw,
        files.map((f) => f.path),
      );
      const f = files.find((n) => n.path === target);
      if (f) open(f.file_id);
      else notify("找不到目标笔记 · " + raw);
      return true;
    }
    return false;
  }
  const title = note.path.split("/").at(-1)!;
  return (
    <article
      className="document"
      onPasteCapture={(e) => {
        const dropped = Array.from(e.clipboardData.files);
        if (!special && editing && dropped.length) {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) run(() => insert(dropped));
        }
      }}
      onDragOver={(e) => {
        if (editing && e.dataTransfer.types.includes("Files"))
          e.preventDefault();
      }}
      onDropCapture={(e) => {
        if (editing && e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) run(() => insert(Array.from(e.dataTransfer.files)));
        }
      }}
      onKeyDown={(e) => {
        if (
          editing &&
          (e.ctrlKey || e.metaKey) &&
          e.key === "s"
        ) {
          e.preventDefault();
          if (!busy && base) run(save);
        }
      }}
    >
      <dialog ref={shareDialog} className="note-share-dialog" aria-labelledby="share-title"
        onCancel={event => { if (busy) event.preventDefault(); }}>
        <h2 id="share-title">分享 {note.path.split("/").at(-1)}</h2>
        {shareURL ? <>
          <p>{shareDays ? `有效期为 ${shareDays} 天` : "永久有效"}。持链接者可查看、保存或下载这个版本。</p>
          <input aria-label="分享链接" readOnly value={shareURL} onFocus={e => e.target.select()} />
          <form method="dialog">
            <button type="button" onClick={() => run(async () => {
              try { await navigator.clipboard.writeText(shareURL); }
              catch { shareDialog.current?.querySelector("input")?.select(); throw Error("请选择并复制链接"); }
              shareDialog.current?.close(); notify("分享链接已复制");
            })}>复制链接</button>
            <button aria-label="关闭链接">关闭</button>
          </form>
        </> : <>
          <label className="share-duration">分享有效期
            <select value={shareDays} disabled={busy} onChange={event => {
              pendingShare.current = null;
              setShareDays(Number(event.target.value));
            }}>
              {[1, 3, 7, 0].map(days => <option key={days} value={days}>{days ? `${days} 天` : "永久"}</option>)}
            </select>
          </label>
          <p>{draftShare ? "有尚未保存的修改。" : "持链接者可查看、保存或下载当前版本。"}</p>
          <div className="share-actions">
            <button disabled={busy} onClick={() => run(generateLink)}>{draftShare ? "分享已保存版本" : "生成链接"}</button>
            {draftShare && !special && <button disabled={busy} onClick={() => run(async () => { await save(); await generateLink(); })}>先保存再分享</button>}
            <button disabled={busy} onClick={() => shareDialog.current?.close()}>{draftShare && special ? "返回编辑器保存" : "取消"}</button>
          </div>
        </>}
      </dialog>
      <NoteHeading
        handset={phoneBack && {
          back: phoneBack,
          dirty: text !== saved.current,
          edit: () => setMode(note.format === "md" ? markdownWritingMode(
            markdownSettings.rememberNoteMode ? loadNoteMode(vault, note.file_id) : undefined,
            markdownSettings.defaultMode,
          ) : "edit"),
          finish: () => run(async () => {
            if (text !== saved.current) await save();
            if (source.current.text === saved.current) setMode("read");
          }),
        }}
        path={note.path}
        mode={mode}
        change={special ? undefined : changeMode}
        markdown={note.format === "md"}
        busy={busy}
        endAction={
          <NoteInfoToggle id={panelId} expanded={panelOpen} toggle={() => setPanelOpen(open => !open)} />
        }
        share={{ label: "分享", run: openShare }}
        save={
          !special && (
            <button
              className="save-button"
              disabled={busy || !base || text === saved.current}
              onClick={() => run(save)}
            >
              {busy
                ? "处理中…"
                : !base
                  ? "加载中"
                  : text === saved.current
                    ? "已保存"
                    : "保存"}
            </button>
          )
        }
        more={
          <>
            {!phoneBack && <button onClick={toggleFocus}>{focused ? "退出专注" : "专注模式"}</button>}
            {mode === "history" && (
              <button onClick={() => setMode("read")}>返回文档</button>
            )}
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const data = await (
                    await request(token, path + "/versions")
                  ).json();
                  setVersions(data.versions);
                  setHistory("");
                  setMode("history");
                })
              }
            >
              历史版本
            </button>
            {!special && note.format === "md" && base && (
              <MarkdownExport
                path={note.path}
                source={() => source.current.serialize()}
                output={browserExport}
                notify={notify}
              />
            )}
            <button
              disabled={busy || !base}
              onClick={() =>
                run(() =>
                  download(
                    token,
                    path + "/versions/" + base + "/content",
                    title,
                  ),
                )
              }
            >
              下载原文件
            </button>
            {actions}
          </>
        }
      />
      <input
        type="file"
        hidden
        ref={assetPicker}
        accept={pictureTypes}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) run(() => insert([f]));
          e.target.value = "";
        }}
      />
      <div className="document-body note-workspace">
        {special && bytes && (
          <div className="note-aux-view" hidden={mode === "history"}>
            <PluginEditor
              path={note.path}
              bytes={bytes}
              save={saveBytes}
              output={browserExport}
              dirty={value => { setPluginDirty(value); dirty(value); }}
              notify={notify}
              xmindTheme={xmindPreferences(preferences).theme}
            />
          </div>
        )}
        {mode === "history" ? (
          <section className="note-aux-view">
            <ul>
              {versions.map((v) => (
                <li key={v.version_id}>
                  <button
                    onClick={() =>
                      run(async () => {
                        if (
                          note.format === "xmind" ||
                          (special && note.format !== "json")
                        ) {
                          await download(
                            token,
                            path + "/versions/" + v.version_id + "/content",
                            title,
                          );
                          return;
                        }
                        setHistory(
                          await (
                            await request(
                              token,
                              path + "/versions/" + v.version_id + "/content",
                            )
                          ).text(),
                        );
                      })
                    }
                  >
                    版本 {v.vault_revision} ·{" "}
                    {new Date(v.created_at).toLocaleString()}
                  </button>
                </li>
              ))}
            </ul>
            <pre>{history}</pre>
          </section>
        ) : special ? null : (
          <div className="note-content" inert={!base || busy}>
            <Document
              writing={rich}
              upload={file => uploadAsset(token, vault, note.file_id, file, notify)}
              imageURL={async url => {
                if (!url.startsWith(origin + "/assets/")) return url;
                const blob = await (await request(token, new URL(url).pathname)).blob();
                return URL.createObjectURL(blob);
              }}
              metadataHost={panelOpen ? metadataHost : null}
              resolveNote={raw => resolvePath(note.path, raw, files.map(f => f.path))}
              attach={() => assetPicker.current?.click()}
              markdown={note.format === "md"}
              text={text}
              edit={edit}
              mode={mode as Mode}
              setMode={changeMode}
              editor={editor}
              preferences={note.format === "md" ? markdownSettings : undefined}
              onPreferencesChange={
                note.format === "md" ? changeMarkdownSettings : undefined
              }
              io={{
                image: (src, alt) => (
                  <AssetImage
                    src={src}
                    alt={alt}
                    token={token}
                    origin={origin}
                  />
                ),
                link: navigate,
              }}
            />
          </div>
        )}
        {panelOpen && <NoteInfoPanel id={panelId} metadata={setMetadataHost} load={loadBacklinks} open={hit => open(hit.file_id)} />}
      </div>
    </article>
  );
}
