import EncryptedVaults, { type EncryptedIO } from "./EncryptedVaults";
import { PluginEditor, MarkdownExport } from "./plugins/PluginEditor";
import { fromBase64, type ExportFile } from "./plugins/archive";
import { usesPluginEditor } from "./plugins/registry";
import { initialBytes } from "./plugins/xmind";
import Manager from "./plugins/Manager";
import { TextFile } from "./markdown/textFile";
import { useEffect, useRef, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Document, type Mode } from "./markdown/Markdown";
import { resolvePath, linkTarget } from "./markdown/document";
import { Resources, type ResourceClient, type Hit } from "./Resources";
import { multipart, multipartThreshold } from "./multipart";
import { base64 } from "./api";
import { containsEntry, entryPath, type EntryIO } from "./libraryEntries";
import { LibraryPanes, NoteHeading, usePanes } from "./LibraryUI";
import "./style.css";

type Binding = {
  android?: boolean;
  vault: string;
  access: () => Promise<string>;
};
declare global {
  interface Window {
    __TAURI__: {
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
    if (/^https:\/\/[^/]+\/assets\/asset_[\w-]+$/.test(src)) {
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
  const [view, setView] = useState("笔记"),
    [newPath, setNewPath] = useState<string | null>(null),
    [links, setLinks] = useState<Hit[]>([]);
  const [pluginBytes, setPluginBytes] = useState<Uint8Array | null>(null),
    [pluginDirty, setPluginDirty] = useState(false);
  const source = useRef(new TextFile("")),
    selection = useRef<[number, number]>([0, 0]),
    picker = useRef<HTMLInputElement>(null);
  const vault = binding.vault,
    dirty = pluginDirty || text !== saved,
    editing = mode === "live" || mode === "edit" || mode === "split";
  const leave = () => !dirty || confirm("放弃尚未保存的编辑？");
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
      blob: async (id) => {
        const r = await local<{ type: string; data: string }>(vault, "asset", {
          id,
          token: await binding.access(),
        });
        return new Blob(
          [Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))],
          { type: r.type },
        );
      },
      save: async (kind, id) => {
        const dest = await local<string>(vault, "download", {
          kind,
          id,
          token: await binding.access(),
        });
        notify("已保存到 " + dest);
      },
    }),
    [binding],
  );
  async function backlinks() {
    const id = await local<string | null>(vault, "file_id", { path });
    setLinks(
      id
        ? await client.json(
            "/links/backlinks?file_id=" + encodeURIComponent(id),
          )
        : [],
    );
  }
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
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function open(p: string, discardConfirmed = false) {
    if (!discardConfirmed && p === path && view === "笔记") {
      panes.setPane("doc");
      return;
    }
    if (!discardConfirmed && !leave()) return;
    const special = usesPluginEditor(p);
    const result = await local<{ text?: string; data?: string; hash: string }>(
      vault,
      special ? "read_bytes" : "read",
      { path: p },
    );
    setPluginBytes(special ? fromBase64(result.data!) : null);
    setPluginDirty(false);
    source.current = new TextFile(result.text || "");
    setText(source.current.text);
    setSaved(source.current.text);
    setBase(result.hash);
    choose(p);
    panes.setPane("doc");
    setView("笔记");
    setLinks([]);
    selection.current = [0, 0];
    setMode("read");
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
      if (affected) {
        if (operation === "delete") {
          choose("");
          setPluginBytes(null);
          setText("");
          setSaved("");
          setLinks([]);
        } else await open(destination + path.slice(source.length), true);
      }
    },
    refresh: load,
    output,
    image: (src, alt) => <LocalImage binding={binding} src={src} alt={alt} />,
    openCreated: async (p) => {
      if (!dirty) await open(p, true);
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
  async function save() {
    const raw = source.current.serialize();
    const hash = await local<string>(vault, "save", { path, base, text: raw });
    setBase(hash);
    setSaved(text);
    await load();
    notify("已保存到本地目录");
  }
  function edit(next: string) {
    source.current.edit(next);
    setText(next);
  }
  async function attach(input: File[]) {
    const token = await binding.access();
    const links = [];
    for (const f of input) {
      const transfer = async <T,>(
        step: string,
        args: Record<string, unknown> = {},
      ) =>
        local<T>(vault, "transfer", {
          token: await binding.access(),
          request: { step, ...args },
        });
      const url =
        f.size >= multipartThreshold
          ? await multipart(
              f,
              [
                localStorage.getItem("origin") || "",
                vault,
                (await transfer<{ id: string }>("user")).id,
              ],
              {
                create: (meta, key) => transfer("create", { meta, key }),
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
              token,
              name: f.name,
              media: f.type || "application/octet-stream",
              data: base64(new Uint8Array(await f.arrayBuffer())),
            });
      links.push(
        (f.type.startsWith("image/") ? "!" : "") +
          "[" +
          f.name.replace(/[\\\[\]\r\n]/g, "_") +
          "](" +
          url +
          ")",
      );
    }
    const [start, end] = selection.current;
    const value = "\n" + links.join("\n") + "\n";
    edit(text.slice(0, start) + value + text.slice(end));
    selection.current = [start + value.length, start + value.length];
    if (mode !== "split") setMode("edit");
  }
  return (
    <div
      className="layout local-layout"
      data-pane={panes.pane}
      data-columns={panes.columns}
      onPasteCapture={(e) => {
        if (
          !pluginBytes &&
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
      <LibraryPanes
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
        tools={
          <>
            {" "}
            {["笔记", "搜索", "附件", "导出", "插件"].map((v) => (
              <button
                key={v}
                className={v === view ? "on" : ""}
                aria-current={v === view ? "page" : undefined}
                disabled={busy}
                onClick={() => {
                  if (
                    (v === "笔记" && v === view && path) ||
                    (v !== view && (pluginBytes || v === "插件"))
                  ) {
                    if (!leave()) return;
                    choose("");
                    setPluginBytes(null);
                    setPluginDirty(false);
                    setSaved(text);
                  }
                  setView(v);
                  panes.setPane(v === "笔记" ? "list" : "doc");
                }}
              >
                {v}
              </button>
            ))}
          </>
        }
        account={
          <button
            disabled={busy}
            onClick={() => {
              if (leave()) close();
            }}
          >
            返回同步
          </button>
        }
        listActions={
          <>
            {" "}
            <label className="file-action">
              导入笔记
              <input
                type="file"
                accept=".md,.txt,.json,.xmind"
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
      <main className="workspace">
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
                  data: base64(initialBytes(newPath)),
                });
                await open(newPath, true);
                setMode("edit");
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
        {view === "插件" ? (
          <Manager />
        ) : view !== "笔记" ? (
          <Resources
            key={view}
            client={client}
            view={view}
            open={(h) => run(() => open(h.path))}
            notify={notify}
          />
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
                  path={path}
                  mode={mode}
                  change={pluginBytes ? undefined : setMode}
                  markdown={/\.md$/i.test(path)}
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
                  save={
                    !pluginBytes && (
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
                      <button
                        onClick={() =>
                          panes.setColumns(panes.columns === 1 ? 3 : 1)
                        }
                      >
                        {panes.columns === 1 ? "退出专注" : "专注模式"}
                      </button>
                      {!pluginBytes && /\.md$/i.test(path) && (
                        <MarkdownExport
                          path={path}
                          source={() => source.current.serialize()}
                          output={output}
                          notify={notify}
                        />
                      )}
                    </>
                  }
                />
                {pluginBytes ? (
                  <PluginEditor
                    key={path}
                    path={path}
                    bytes={pluginBytes}
                    save={savePlugin}
                    output={output}
                    dirty={setPluginDirty}
                    notify={notify}
                  />
                ) : (
                  <>
                    <input
                      type="file"
                      hidden
                      ref={picker}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) run(() => attach([f]));
                        e.target.value = "";
                      }}
                    />
                    <div className="document-body" inert={busy}>
                      <Document
                        key={path}
                        attach={() => picker.current?.click()}
                        markdown={/\.md$/i.test(path)}
                        text={text}
                        edit={edit}
                        mode={mode}
                        setMode={setMode}
                        select={(a, b) => {
                          selection.current = [a, b];
                        }}
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
                                await client.save(
                                  "asset",
                                  new URL(href).pathname.split("/").at(-1)!,
                                  "附件",
                                );
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
                )}
                <details
                  className="backlinks"
                  onToggle={(e) => {
                    if (e.currentTarget.open) run(backlinks);
                  }}
                >
                  <summary>反向链接</summary>
                  {links.length ? (
                    links.map((h) => (
                      <button
                        key={h.file_id}
                        onClick={() => run(() => open(h.path))}
                      >
                        {h.path}
                      </button>
                    ))
                  ) : (
                    <p>没有笔记链接到此处。</p>
                  )}
                </details>
              </>
            )}
          </article>
        )}
      </main>
    </div>
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

window.addEventListener("open-encrypted", (event) => {
  const { access, origin, android } = (
    event as CustomEvent<Binding & { origin: string }>
  ).detail;
  const settings = document.querySelector("body > main") as HTMLElement;
  settings.hidden = true;
  const io: EncryptedIO = async (id, envelope) =>
    window.__TAURI__.core.invoke("encrypted_vault", {
      origin,
      token: await access(),
      id: id ?? null,
      envelope: envelope ?? null,
    });
  let dirty = false;
  const changed = (value: boolean) => {
    dirty = value;
  };
  const output: ExportFile = async (name, bytes) => {
    const payload = { name, data: base64(bytes) };
    if (android) {
      await window.__TAURI__.core.invoke("mobile_control", {
        action: "exportDocument",
        payload,
      });
    } else {
      await window.__TAURI__.core.invoke("export_decrypted_file", payload);
    }
  };
  root.render(
    <div className="local-workspace">
      <button
        onClick={() => {
          if (dirty && !confirm("放弃未保存的加密库编辑？")) return;
          root.render(null);
          settings.hidden = false;
        }}
      >
        返回同步设置
      </button>
      <EncryptedVaults io={io} dirty={changed} exportFile={output} />
    </div>,
  );
});
