import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { digest, Library } from "./library";
import { draftLock, journal } from "./journal";
import { dispatch, type Grant } from "./protocol";
import { tools, readOnly } from "./tools";
import type { Backend } from "./backend";

type Packet = { generation: string; sequence: number; message: unknown };
type Api = { request(message: unknown, token: string): Promise<unknown> };
type BrowserTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (args: unknown) => Promise<unknown>;
};
type BrowserRegistry = {
  registerTool: (tool: BrowserTool, options?: { signal: AbortSignal }) => void;
  unregisterTool?: (name: string) => void;
};
const core = () =>
  window.__TAURI__?.core as
    | (Window["__TAURI__"]["core"] & {
        Channel: new () => { onmessage: (p: Packet) => void };
      })
    | undefined;
declare global {
  interface Window {
    weNoteMCP?: Api;
  }
}
type Props = {
  scope: string;
  vault: string;
  desktop: boolean;
  backend: Backend;
  dirty: (path: string) => boolean;
  dirtyPath: string;
  changed: (path: string, previous?: string, deleted?: boolean) => void;
};
function stored(key: string): Grant[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value : value?.id ? [value] : [];
  } catch {
    return [];
  }
}
export function useMcp(props: Props) {
  const current = useRef(props);
  current.current = props;
  const key = "wenote-mcp-grant:" + props.scope;
  const [revision, reload] = useState(0),
    [urls, address] = useState<Record<string, string>>({}),
    [error, status] = useState("");
  const hosts = useRef(
    new Map<string, { library: Library; api: Api; stop: () => void }>(),
  );
  const grants = useMemo(() => stored(key), [key, revision]);
  useEffect(() => {
    const change = (e: StorageEvent) => {
      if (e.key === key) reload((n) => n + 1);
    };
    window.addEventListener("storage", change);
    return () => window.removeEventListener("storage", change);
  }, [key]);
  useLayoutEffect(() => {
    if (!props.dirtyPath || !props.scope || !navigator.locks) return;
    const controller = new AbortController();
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    void navigator.locks
      .request(
        draftLock(props.scope, props.dirtyPath),
        { mode: "shared", signal: controller.signal },
        () => wait,
      )
      .catch(() => {});
    return () => {
      release();
      controller.abort();
    };
  }, [props.scope, props.dirtyPath]);
  useEffect(
    () => () => {
      for (const host of hosts.current.values()) host.stop();
      hosts.current.clear();
    },
    [key, props.desktop],
  );
  useEffect(() => {
    status("");
    for (const [id, host] of hosts.current)
      if (!grants.some((g) => g.id === id)) {
        host.stop();
        hosts.current.delete(id);
      }
    if (!props.scope || !grants.length) return;
    function start(auth: Grant) {
      let live = true;
      const generation = crypto.randomUUID();
      const scope = props.scope;
      const active = () =>
        live &&
        current.current.scope === scope &&
        stored(key).some((g) => g.id === auth.id);
      const library = new Library(
        {
          scope,
          vault: props.vault,
          backend: props.backend,
          active,
          async dirty(path) {
            return (
              current.current.dirty(path) ||
              !!(await navigator.locks.query()).held?.some(
                (x) => x.name === draftLock(scope, path),
              )
            );
          },
          changed(path, previous, deleted) {
            if (active()) current.current.changed(path, previous, deleted);
          },
        },
        journal(scope),
      );
      const request = (m: unknown) =>
        dispatch(m, auth, active, (c) => library.run(c, auth.id, auth.write));
      const api: Api = {
        async request(m, token) {
          if (typeof token !== "string" || (await digest(token)) !== auth.hash)
            throw Error("ACCESS_DENIED");
          return request(m);
        },
      };
      const registry = (
        navigator as Navigator & { modelContext?: BrowserRegistry }
      ).modelContext;
      const names: string[] = [];
      const controller = new AbortController();
      if (auth.browserTools && registry?.registerTool) {
        try {
          for (const t of tools.filter((t) => auth.write || readOnly(t.name))) {
            const name = "wenote_" + t.name;
            registry.registerTool(
              {
                name,
                description: t.description,
                inputSchema: t.inputSchema,
                execute: async (args) => {
                  const reply = await request({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: t.name, arguments: args },
                  });
                  return reply && "result" in reply ? reply.result : reply;
                },
              },
              { signal: controller.signal },
            );
            names.push(name);
          }
        } catch (e) {
          status(String(e));
        }
      }
      const native = props.desktop ? core() : undefined;
      if (native) {
        const channel = new native.Channel();
        channel.onmessage = async (p) => {
          if (p.generation === generation) {
            const result = await request(p.message);
            await native.invoke("mcp_reply", {
              generation,
              sequence: p.sequence,
              result,
            });
          }
        };
        const open = (port: number) =>
          native.invoke<string>("mcp_open", {
            generation,
            port,
            tokenHash: auth.hash,
            channel,
          });
        void open(Number(localStorage.getItem(key + auth.id + ":port")) || 0)
          .then((endpoint) => {
            if (!active()) {
              void native.invoke("mcp_close", { generation });
              return;
            }
            address((all) => ({ ...all, [auth.id]: endpoint }));
            localStorage.setItem(
              key + auth.id + ":port",
              new URL(endpoint).port,
            );
          })
          .catch((e) => {
            if (active()) status(String(e));
          });
      }
      const flush = () => {
        if (active() && auth.write)
          void library.journal
            .lock(async () => {
              if (active()) await library.flush(await library.journal.load());
            })
            .catch((e) => {
              if (active()) status(String(e));
            });
      };
      flush();
      window.addEventListener("online", flush);
      window.addEventListener("focus", flush);
      const stop = () => {
        live = false;
        window.removeEventListener("online", flush);
        window.removeEventListener("focus", flush);
        controller.abort();
        for (const name of names) {
          try {
            registry?.unregisterTool?.(name);
          } catch {
            /* Already unregistered by signal. */
          }
        }
        if (native) void native.invoke("mcp_close", { generation });
      };
      return { library, api, stop };
    }
    for (const grant of grants)
      if (!hosts.current.has(grant.id))
        hosts.current.set(grant.id, start(grant));
    const gateway: Api = {
      async request(message, token) {
        if (typeof token !== "string") throw Error("ACCESS_DENIED");
        const hash = await digest(token);
        const match = grants.find((g) => g.hash === hash);
        const host = match && hosts.current.get(match.id);
        if (!host) throw Error("ACCESS_DENIED");
        return host.api.request(message, token);
      },
    };
    window.weNoteMCP = gateway;
    return () => {
      if (window.weNoteMCP === gateway) delete window.weNoteMCP;
    };
  }, [key, grants, props.scope, props.vault, props.desktop]);
  async function change(update: (grants: Grant[]) => Grant[]) {
    await navigator.locks.request(key, () => {
      if (!props.scope || current.current.scope !== props.scope)
        throw Error("笔记库已切换");
      localStorage.setItem(key, JSON.stringify(update(stored(key))));
      reload((n) => n + 1);
    });
  }
  async function enable(name: string, write: boolean, browserTools: boolean) {
    const token = crypto.randomUUID() + crypto.randomUUID();
    const grant = {
      id: crypto.randomUUID(),
      hash: await digest(token),
      name,
      write,
      browserTools,
    };
    await change((grants) => {
      if (browserTools && grants.some((g) => g.browserTools))
        throw Error("当前页面已为浏览器助手授权");
      return [...grants, grant];
    });
    return { id: grant.id, value: token };
  }
  async function revoke(id: string) {
    await change((grants) => grants.filter((g) => g.id !== id));
    localStorage.removeItem(key + id + ":port");
  }
  const library = () =>
    hosts.current.get((grants.find((g) => g.write) ?? grants[0])?.id)?.library;
  return {
    grants,
    enable,
    revoke,
    urls,
    error,
    library,
    available: !!props.scope,
  };
}
export function McpPanel({
  connection,
}: {
  connection: ReturnType<typeof useMcp>;
}) {
  const [adding, setAdding] = useState(false),
    [name, setName] = useState("本机助手"),
    [write, setWrite] = useState(false),
    [browserTools, setBrowserTools] = useState(false);
  const [secret, setSecret] = useState({ id: "", value: "" }),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [conflicts, setConflicts] = useState<
    Awaited<ReturnType<Library["conflicts"]>>
  >([]);
  const refresh = async () =>
    setConflicts((await connection.library()?.conflicts()) ?? []);
  const handle = (action: () => Promise<void>) =>
    void action().catch((e) => setError(String(e)));
  useEffect(() => {
    handle(refresh);
  }, [connection.grants]);
  if (!connection.available) return <p>请先打开笔记库。</p>;
  return (
    <section>
      <h3>MCP 连接</h3>
      {connection.grants.map((grant) => (
        <fieldset key={grant.id}>
          <legend>{grant.name}</legend>
          <p>{grant.write ? "可编辑" : "只读"}</p>
          {connection.urls[grant.id] ? (
            <p>
              连接地址 <code>{connection.urls[grant.id]}</code>，请求头使用{" "}
              <code>Authorization: Bearer</code> 加连接令牌。
            </p>
          ) : (
            <p>
              当前应用使用 <code>window.weNoteMCP.request(message, token)</code>
              。
            </p>
          )}
          {secret.id === grant.id && (
            <label>
              连接令牌（仅此次显示）
              <input
                readOnly
                value={secret.value}
                onFocus={(e) => e.target.select()}
              />
            </label>
          )}
          <button
            onClick={() =>
              handle(async () => {
                await connection.revoke(grant.id);
                if (secret.id === grant.id) setSecret({ id: "", value: "" });
              })
            }
          >
            撤销连接
          </button>
        </fieldset>
      ))}
      {adding || !connection.grants.length ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handle(async () => {
              setError("");
              setSecret(
                await connection.enable(name.trim(), write, browserTools),
              );
              setAdding(false);
              setWrite(false);
              setBrowserTools(false);
            });
          }}
        >
          <label>
            连接名称
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={write}
              onChange={(e) => setWrite(e.target.checked)}
            />
            允许新建、修改和移入回收站
          </label>
          {"modelContext" in navigator &&
            !connection.grants.some((g) => g.browserTools) && (
              <label>
                <input
                  type="checkbox"
                  checked={browserTools}
                  onChange={(e) => setBrowserTools(e.target.checked)}
                />
                允许当前浏览器的 WebMCP 助手使用此授权
              </label>
            )}
          <button disabled={!name.trim()}>授权当前笔记库</button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)}>添加连接</button>
      )}
      {connection.grants.length > 0 &&
        connection.library() &&
        !connection.library()!.context.backend.native && (
          <button
            onClick={() =>
              handle(async () =>
                setNotice(await connection.library()!.cacheVault()),
              )
            }
          >
            缓存本库可编辑文件
          </button>
        )}
      {connection.grants.some((g) => g.write) && (
        <>
          <button
            onClick={() =>
              handle(async () => {
                await refresh();
                setNotice("已刷新同步冲突");
              })
            }
          >
            查看同步冲突
          </button>
          {conflicts.map((item) => (
            <div key={item.id}>
              <p>
                {item.path} · {item.reason}
              </p>
              <details>
                <summary>查看待同步内容</summary>
                <pre>{item.text ?? "文件路径操作"}</pre>
              </details>
              <button
                onClick={() =>
                  handle(async () => {
                    if (
                      confirm("放弃此文件待同步的 MCP 修改并使用已保存版本？")
                    ) {
                      await connection
                        .library()
                        ?.acceptStored(item.id, item.version);
                      await refresh();
                    }
                  })
                }
              >
                使用已保存版本
              </button>
            </div>
          ))}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {(error || connection.error) && (
        <p role="alert">{error || connection.error}</p>
      )}
    </section>
  );
}
