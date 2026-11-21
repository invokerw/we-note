import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { base64, Note, request, uploadAsset, Version } from "./api";

type Props = {
  note: Note;
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
  const schema = useRef({ bom: false, crlf: false, saved: "" });
  const assetPicker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    request(token, path + "/content")
      .then(async (r) => {
        const buf = new Uint8Array(await r.arrayBuffer());
        const str = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        if (live) {
          const value = str.replace(/\r\n/g, "\n");
          schema.current = {
            bom: buf[0] === 239 && buf[1] === 187 && buf[2] === 191,
            crlf: str.includes("\r\n"),
            saved: value,
          };
          setText(value);
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
    setText(value);
    dirty(value !== schema.current.saved);
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
    let value = schema.current.crlf ? text.replace(/\n/g, "\r\n") : text;
    if (schema.current.bom) value = "\uFEFF" + value;
    const out = await (
      await request(token, path + "/content", "PUT", {
        base_version_id: base,
        content: base64(new TextEncoder().encode(value)),
      })
    ).json();
    setBase(out.version_id);
    schema.current.saved = text;
    dirty(false);
    await changed();
    notify("已保存新版本");
  }
  async function asset(file: File) {
    const url = await uploadAsset(token, vault, file);
    edit(
      text +
        "\n" +
        (file.type.startsWith("image/") ? "!" : "") +
        "[" +
        file.name.replace(/[[\]]/g, "") +
        "](" +
        url +
        ")\n",
    );
    setMode("edit");
  }
  const title = note.path.split("/").at(-1)!;
  return (
    <article>
      <div className="crumb">{note.path}</div>
      <h1>{title}</h1>
      <div className="toolbar">
        <nav>
          {[
            ["read", "阅读"],
            ["edit", "源码"],
            ["history", "历史"],
          ].map(([key, label]) => (
            <button
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
        {mode === "edit" && (
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
          if (f) run(() => asset(f));
          e.target.value = "";
        }}
      />
      {mode === "edit" ? (
        <textarea
          aria-label="笔记源码"
          className="source"
          disabled={!base || busy}
          value={text}
          onChange={(e) => edit(e.target.value)}
        />
      ) : mode === "history" ? (
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
      ) : note.format === "md" ? (
        <div className="reading">
          <Markdown
            components={{
              img: ({ src, alt }) => (
                <AssetImage
                  src={typeof src === "string" ? src : undefined}
                  alt={alt}
                  token={token}
                  origin={origin}
                />
              ),
              a: ({ href, children }) => (
                <a
                  href={href}
                  rel="noreferrer"
                  target="_blank"
                  onClick={(e) => {
                    if (href?.startsWith(origin + "/assets/")) {
                      e.preventDefault();
                      run(async () => {
                        const blob = await (
                          await request(token, new URL(href).pathname)
                        ).blob();
                        const link = document.createElement("a");
                        link.download = String(children || "附件");
                        link.href = URL.createObjectURL(blob);
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                      });
                    }
                  }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </Markdown>
        </div>
      ) : (
        <pre>{text}</pre>
      )}
    </article>
  );
}
