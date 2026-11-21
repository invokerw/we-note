import { TextFile } from "./markdown/textFile";
import { useEffect, useRef, useState } from "react";
import { Document, modes, type Mode } from "./markdown/Markdown";
import { resolvePath, linkTarget } from "./markdown/document";
import { download, type Hit } from "./Resources";
import { base64, Note, request, uploadAsset, Version } from "./api";

type Props = {
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
function AssetImage({
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
  const source = useRef(new TextFile("")),
    saved = useRef("");
  const assetPicker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    request(token, path + "/content")
      .then(async (r) => {
        const buf = new Uint8Array(await r.arrayBuffer());
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
    setBusy(true);
    try {
      await f();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const value = source.current.serialize();
    const out = await (
      await request(token, path + "/content", "PUT", {
        base_version_id: base,
        content: base64(new TextEncoder().encode(value)),
      })
    ).json();
    if (!alive.current) return;
    setBase(out.version_id);
    saved.current = text;
    dirty(false);
    await changed();
    notify("已保存新版本");
  }
  const selection = useRef<[number, number]>([0, 0]);
  const [links, setLinks] = useState<Hit[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function insert(files: File[]) {
    const [start, end] = selection.current;
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
    edit(text.slice(0, start) + inserted + text.slice(end));
    selection.current = [start + inserted.length, start + inserted.length];
    setMode("edit");
  }
  const editing = mode === "edit" || mode === "live";
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
      onPasteCapture={(e) => {
        const dropped = Array.from(e.clipboardData.files);
        if (editing && dropped.length) {
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
        if (editing && (e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          if (!busy && base) run(save);
        }
      }}
    >
      <div className="crumb">{note.path}</div>
      <h1>{title}</h1>
      <div className="toolbar">
        <nav>
          {[
            ...modes.filter(
              ([m]) => note.format === "md" || m === "read" || m === "edit",
            ),
            ["history", "历史"],
          ].map(([key, label]) => (
            <button
              disabled={busy}
              key={key}
              className={mode === key ? "on" : ""}
              onClick={() =>
                run(async () => {
                  if (key === "history") {
                    const data = await (
                      await request(token, path + "/versions")
                    ).json();
                    setVersions(data.versions);
                    setHistory("");
                  }
                  setMode(key);
                })
              }
            >
              {label}
            </button>
          ))}
        </nav>
        {mode === "read" && (
          <button
            disabled={busy || !base}
            onClick={() =>
              run(() =>
                download(token, path + "/versions/" + base + "/content", title),
              )
            }
          >
            下载原文件
          </button>
        )}
        {editing && (
          <>
            <button
              disabled={busy || !base}
              onClick={() => assetPicker.current?.click()}
            >
              插入附件
            </button>
            <button
              className="primary"
              disabled={busy || !base}
              onClick={() => run(save)}
            >
              保存
            </button>
          </>
        )}
      </div>
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
      {mode === "history" ? (
        <section>
          <ul>
            {versions.map((v) => (
              <li key={v.version_id}>
                <button
                  onClick={() =>
                    run(async () =>
                      setHistory(
                        await (
                          await request(
                            token,
                            path + "/versions/" + v.version_id + "/content",
                          )
                        ).text(),
                      ),
                    )
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
      ) : (
        <div inert={!base || busy}>
          <Document
            markdown={note.format === "md"}
            text={text}
            edit={edit}
            mode={mode as Mode}
            setMode={setMode}
            select={(a, b) => {
              selection.current = [a, b];
            }}
            io={{
              image: (src, alt) => (
                <AssetImage src={src} alt={alt} token={token} origin={origin} />
              ),
              link: navigate,
            }}
          />
        </div>
      )}
      <details
        className="backlinks"
        onToggle={(e) => {
          if (e.currentTarget.open)
            run(async () =>
              setLinks(
                await (
                  await request(
                    token,
                    `/api/v1/vaults/${vault}/links/backlinks?file_id=${note.file_id}`,
                  )
                ).json(),
              ),
            );
        }}
      >
        <summary>反向链接</summary>
        {links.length ? (
          links.map((f) => (
            <button key={f.file_id} onClick={() => open(f.file_id)}>
              {f.path}
            </button>
          ))
        ) : (
          <p>没有笔记链接到此处。</p>
        )}
      </details>
    </article>
  );
}
