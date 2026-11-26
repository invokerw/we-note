import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TextFile } from "../markdown/textFile";
import { decodeText, utf8, type ExportFile } from "./archive";
import { handler, invoke } from "./registry";
const MindCanvas = lazy(() => import("./MindCanvas"));

export function PluginEditor({
  path,
  bytes,
  save,
  saveHost,
  output,
  dirty,
  notify,
}: {
  path: string;
  bytes: Uint8Array;
  save: (bytes: Uint8Array) => Promise<void>;
  saveHost: HTMLElement | null;
  output: ExportFile;
  dirty: (v: boolean) => void;
  notify: (msg: string) => void;
}) {
  const [plugin] = useState(() => handler(path));
  const { capabilities: caps, id } = plugin.manifest;
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [modified, setModified] = useState(false);
  const originalMindText = useRef("");
  const file = useRef(new TextFile("")),
    savedText = useRef(""),
    original = useRef(bytes),
    live = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    let active = true;
    live.current = true;
    async function open() {
      const data = plugin.wasm ? await invoke(plugin, "open", bytes) : bytes;
      const doc = new TextFile(decodeText(data));
      if (active) {
        file.current = doc;
        originalMindText.current = doc.text;
        savedText.current = doc.text;
        setText(doc.text);
        setReady(true);
      }
    }
    open().catch((e) => {
      if (active) setError(String(e));
    });
    return () => {
      active = false;
      live.current = false;
    };
  }, [bytes, plugin]);
  function mark(v: boolean) {
    setModified(v);
    dirty(v);
  }
  function edit(value: string) {
    file.current.edit(value);
    setText(value);
    mark(value !== savedText.current);
  }
  async function encoded() {
    if (file.current.text === savedText.current) return original.current;
    const data = utf8.encode(file.current.serialize());
    return plugin.wasm ? invoke(plugin, "serialize", data) : data;
  }
  async function run(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (live.current) notify(String(e));
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function persist() {
    const submitted = file.current.text;
    const data = await encoded();
    if (!live.current) return;
    await save(data);
    if (live.current) {
      original.current = data;
      savedText.current = submitted;
      mark(file.current.text !== submitted);
    }
  }
  const isMind = id === "com.wenote.mind.json";
  function saveChanges() {
    if (modified || file.current.text !== savedText.current) void run(persist);
  }
  const exportCurrent = () => run(async () => output(name, await encoded()));
  const name = path.split("/").at(-1)!;
  return (
    <section
      className={isMind ? "plugin-document mind-plugin-document" : "plugin-document"}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          e.stopPropagation();
          if (id === "com.wenote.mind.json" && e.target instanceof HTMLElement && e.target.isContentEditable) e.target.blur();
          if (ready && (modified || file.current.text !== savedText.current) && caps.includes("serialize"))
            void run(persist);
        }
      }}
    >
      {saveHost && ready && caps.includes("serialize") && createPortal(
        <button className="save-button" disabled={busy || !modified} onClick={saveChanges}>
          {modified ? "保存" : "已保存"}
        </button>, saveHost,
      )}
      <div inert={busy}>
        {!isMind && <div className="toolbar">
          {ready && caps.includes("export") && (
            <button
              onClick={exportCurrent}
            >
              导出当前文件
            </button>
          )}
          {(!ready || !caps.includes("export")) && (
            <button onClick={() => run(() => output(name, original.current))}>
              下载原文件
            </button>
          )}
        </div>}
        {error ? (
          <p role="alert">{error}</p>
        ) : ready ? (
          isMind ? (
            <Suspense fallback="正在载入导图…"><MindCanvas source={originalMindText.current} change={edit}
              exportFile={caps.includes("export") ? exportCurrent : undefined} /></Suspense>
          ) : (
            <label>
              {plugin.manifest.name}
              <textarea
                aria-label={plugin.wasm ? "插件文档" : plugin.manifest.name}
                value={text}
                readOnly={!caps.includes("edit")}
                onChange={(e) => edit(e.target.value)}
              />
            </label>
          )
        ) : (
          <p>正在打开文件…</p>
        )}
      </div>
    </section>
  );
}
