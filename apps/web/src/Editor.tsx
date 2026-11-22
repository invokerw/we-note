import { NoteHeading } from "./LibraryUI";
import { PluginEditor, MarkdownExport } from "./plugins/PluginEditor";
import { browserExport } from "./plugins/archive";
import { usesPluginEditor } from "./plugins/registry";
import { TextFile } from "./markdown/textFile";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { captureInsertion, resumeWriting } from "./markdown/Source";
import type { EditorView } from "@codemirror/view";
import { Document, type Mode } from "./markdown/Markdown";
import { resolvePath, linkTarget } from "./markdown/document";
import { download, type Hit } from "./Resources";
import { base64, Note, request, uploadAsset, Version } from "./api";

type Props = {
  actions: ReactNode;
  share: () => void;
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
function Backlinks({
  token,
  vault,
  fileId,
  open,
}: {
  token: string;
  vault: string;
  fileId: string;
  open: (id: string) => void;
}) {
  const [links, setLinks] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    request(
      token,
      `/api/v1/vaults/${vault}/links/backlinks?file_id=${encodeURIComponent(fileId)}`,
    )
      .then((response) => response.json())
      .then((results) => {
        if (active) setLinks(results);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [token, vault, fileId]);
  return (
    <section className="panel-backlinks" aria-label="反向链接">
      <h2>反向链接</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : links === null ? (
        <p role="status">正在加载…</p>
      ) : links.length ? (
        <ul>
          {links.map((f) => (
            <li key={f.file_id}>
              <button onClick={() => open(f.file_id)}>{f.path}</button>
            </li>
          ))}
        </ul>
      ) : (
        <p>没有笔记链接到此处。</p>
      )}
    </section>
  );
}
export default function Editor({
  actions,
  share,
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
}: Props) {
  const path = `/api/v1/vaults/${vault}/files/${note.file_id}`;
  const [text, setText] = useState(""),
    [base, setBase] = useState(""),
    [mode, setMode] = useState("read"),
    [versions, setVersions] = useState<Version[]>([]),
    [history, setHistory] = useState(""),
    [busy, setBusy] = useState(false);
  const special = usesPluginEditor(note.path);
  const panelId = useId();
  const [panelOpen, setPanelOpen] = useState(false);
  const [metadataHost, setMetadataHost] = useState<HTMLDivElement | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
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
  async function save() {
    const value = source.current.serialize();
    await saveBytes(new TextEncoder().encode(value));
    if (!alive.current) return;
    saved.current = text;
    dirty(false);
  }
  async function saveBytes(data: Uint8Array) {
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
  }
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function insert(files: File[]) {
    const insertHere = captureInsertion(editor.current);
    const parts = [];
    for (const file of files) {
      const url = await uploadAsset(token, vault, file, notify);
      parts.push(
        (file.type.startsWith("image/") ? "!" : "") +
          "[" +
          file.name.replace(/[\\[\]\r\n]/g, "_") +
          "](" +
          url +
          ")",
      );
    }
    if (!alive.current) return;
    const inserted = "\n" + parts.join("\n") + "\n";
    if (!insertHere?.(inserted)) {
      edit(source.current.text + inserted);
      setMode("edit");
    }
  }
  const editing = mode === "edit" || mode === "live" || mode === "split";
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
          (editing || mode === "map") &&
          (e.ctrlKey || e.metaKey) &&
          e.key === "s"
        ) {
          e.preventDefault();
          if (!busy && base) run(save);
        }
      }}
    >
      <NoteHeading
        path={note.path}
        mode={mode}
        change={special ? undefined : setMode}
        markdown={note.format === "md"}
        busy={busy}
        endAction={
          <button
            className="metadata-toggle"
            title={
              panelOpen
                ? "收起笔记信息"
                : "展开笔记信息（目录、属性与反向链接）"
            }
            aria-label="笔记信息"
            aria-expanded={panelOpen}
            aria-controls={panelId}
            onClick={() => setPanelOpen((open) => !open)}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="2" y="3" width="16" height="14" rx="2" />
              <path d="M11.5 3v14M14 7h2M14 10h2" />
            </svg>
          </button>
        }
        share={{ label: "分享快照", run: share }}
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
            <button onClick={toggleFocus}>
              {focused ? "退出专注" : "专注模式"}
            </button>
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
              dirty={dirty}
              notify={notify}
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
              metadataHost={panelOpen ? metadataHost : null}
              attach={() => assetPicker.current?.click()}
              markdown={note.format === "md"}
              text={text}
              edit={edit}
              mode={mode as Mode}
              setMode={setMode}
              editor={editor}
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
        <aside
          className="metadata-panel"
          id={panelId}
          hidden={!panelOpen}
          aria-label="笔记信息"
        >
          <div ref={setMetadataHost} />
          {panelOpen && (
            <Backlinks
              token={token}
              vault={vault}
              fileId={note.file_id}
              open={open}
            />
          )}
        </aside>
      </div>
    </article>
  );
}
