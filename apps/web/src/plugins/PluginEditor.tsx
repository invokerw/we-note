import { useEffect, useRef, useState } from "react";
import { TextFile } from "../markdown/textFile";
import { decodeText, utf8, type ExportFile } from "./archive";
import { handler, invoke } from "./registry";
import { JsonEditor, jsonTree } from "./JsonEditor";
import { MapEditor } from "./MapEditor";
import {
  asMarkdown,
  fromMarkdown,
  openMap,
  writeMap,
  type Workbook,
} from "./xmind";

export function MarkdownExport({
  path,
  source,
  output,
  notify,
}: {
  path: string;
  source: () => string;
  output: ExportFile;
  notify: (msg: string) => void;
}) {
  if (handler("export.xmind")?.manifest.id !== "com.wenote.xmind") return null;
  return (
    <button
      onClick={async () => {
        try {
          const name = path.split("/").at(-1)!.replace(/\.md$/i, "");
          await output(name + ".xmind", writeMap(fromMarkdown(source(), name)));
        } catch (e) {
          notify(String(e));
        }
      }}
    >
      导出 XMind
    </button>
  );
}
export function PluginEditor({
  path,
  bytes,
  save,
  output,
  dirty,
  notify,
}: {
  path: string;
  bytes: Uint8Array;
  save: (bytes: Uint8Array) => Promise<void>;
  output: ExportFile;
  dirty: (v: boolean) => void;
  notify: (msg: string) => void;
}) {
  const [plugin] = useState(() => handler(path));
  const caps = plugin?.manifest.capabilities || [],
    id = plugin?.manifest.id;
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [text, setText] = useState(""),
    [book, setBook] = useState<Workbook | null>(null),
    [index, switchSheet] = useState(0),
    [modified, setModified] = useState(false);
  const file = useRef(new TextFile("")),
    savedText = useRef(""),
    original = useRef(bytes),
    live = useRef(true),
    locked = useRef(false);
  useEffect(() => {
    let active = true;
    live.current = true;
    async function open() {
      if (!plugin) return;
      if (id === "com.wenote.xmind") {
        const map = openMap(bytes);
        if (active) setBook(map);
      } else {
        const data = plugin.wasm ? await invoke(plugin, "open", bytes) : bytes;
        const doc = new TextFile(decodeText(data));
        if (active) {
          file.current = doc;
          savedText.current = doc.text;
          setText(doc.text);
        }
      }
      if (active) setReady(true);
    }
    open().catch((e) => {
      if (active) setError(String(e));
    });
    return () => {
      active = false;
      live.current = false;
    };
  }, [bytes, plugin, id]);
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
    if (!modified) return original.current;
    if (book) return writeMap(book);
    if (id === "com.wenote.json") jsonTree(text);
    const data = utf8.encode(file.current.serialize());
    return plugin?.wasm ? invoke(plugin, "serialize", data) : data;
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
    const data = await encoded();
    if (!live.current) return;
    await save(data);
    if (live.current) {
      original.current = data;
      savedText.current = text;
      mark(false);
    }
  }
  const name = path.split("/").at(-1)!;
  return (
    <section
      className="plugin-document"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          e.stopPropagation();
          if (ready && modified && caps.includes("serialize"))
            void run(persist);
        }
      }}
    >
      <div inert={busy}>
        <div className="toolbar">
          {ready && caps.includes("serialize") && (
            <button
              className="primary"
              disabled={!modified}
              onClick={() => run(persist)}
            >
              保存
            </button>
          )}
          {ready && caps.includes("export") && (
            <button
              onClick={() => run(async () => output(name, await encoded()))}
            >
              导出当前文件
            </button>
          )}
          {book && (
            <button
              onClick={() =>
                run(async () =>
                  output(
                    name.replace(/\.xmind$/i, ".md"),
                    utf8.encode(asMarkdown(book.sheets[index])),
                  ),
                )
              }
            >
              导出 Markdown
            </button>
          )}
          {(!ready || !caps.includes("export")) && (
            <button onClick={() => run(() => output(name, original.current))}>
              下载原文件
            </button>
          )}
        </div>
        {!plugin ? (
          <p>此格式的插件已禁用，可在「插件」中启用。</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : ready ? (
          book ? (
            <MapEditor
              book={book}
              index={index}
              switchSheet={switchSheet}
              edit={(b) => {
                setBook(b);
                mark(true);
              }}
            />
          ) : id === "com.wenote.json" ? (
            <JsonEditor text={text} edit={edit} />
          ) : (
            <label>
              {plugin.manifest.name}
              <textarea
                aria-label="插件文档"
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
