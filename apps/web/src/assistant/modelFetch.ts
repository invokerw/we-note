// Pi accepts a fetch implementation. The native client streams via IPC so model endpoints need no CORS headers.
type Packet =
  | { type: "headers"; status: number; content: string }
  | { type: "data"; bytes: number[] }
  | { type: "end" };
export function modelFetch(base: string, key: string): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url),
      root = new URL(base);
    const suffix = url.pathname.slice(root.pathname.replace(/\/$/, "").length);
    const listing =
      suffix === "/models" &&
      req.method === "GET" &&
      (!url.search || /^\?client_version=\d+\.\d+\.\d+$/.test(url.search));
    const chat =
      ["/chat/completions", "/responses"].includes(suffix) &&
      req.method === "POST" &&
      !url.search;
    if (
      url.hash ||
      url.username ||
      url.password ||
      url.origin !== root.origin ||
      !url.pathname.startsWith(root.pathname.replace(/\/$/, "")) ||
      !(listing || chat)
    )
      throw Error("模型请求地址与配置不符");
    const headers = new Headers({
      ...(listing ? {} : { "Content-Type": "application/json" }),
      Accept: listing ? "application/json" : "text/event-stream",
    });
    if (key) headers.set("Authorization", `Bearer ${key}`);
    const core = window.__TAURI__?.core;
    if (!core) {
      try {
        return await fetch(req, {
          headers,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
      } catch (error) {
        if (req.signal.aborted || !(error instanceof TypeError)) throw error;
        const hint =
          root.origin === window.location.origin
            ? "请检查模型服务地址和网络连接。"
            : `请检查网络，并确认网关允许来自 ${window.location.origin} 的跨域请求（CORS）。也可以在 WeNote 桌面客户端使用相同的模型配置直连。`;
        throw new Error(`浏览器无法连接模型服务 ${root.origin}。${hint}`);
      }
    }
    const body = await req.text(),
      id = crypto.randomUUID();
    req.signal.throwIfAborted();
    const Channel = (
      core as typeof core & {
        Channel: new () => { onmessage: (p: Packet) => void };
      }
    ).Channel;
    return new Promise<Response>((resolve, reject) => {
      const channel = new Channel();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const data = new ReadableStream<Uint8Array>({
        start(c) {
          stream = c;
        },
      });
      const abort = () => {
        void core.invoke("model_cancel", { id }).catch(() => {});
      };
      req.signal.addEventListener("abort", abort, { once: true });
      channel.onmessage = (p) => {
        if (p.type === "headers")
          resolve(
            new Response(data, {
              status: p.status,
              headers: { "Content-Type": p.content },
            }),
          );
        else if (p.type === "end") stream.close();
        else stream.enqueue(Uint8Array.from(p.bytes));
      };
      core
        .invoke("model_stream", { id, url: req.url, key, body, channel })
        .catch((err) => {
          stream.error(err);
          reject(Error(String(err)));
        })
        .finally(() => req.signal.removeEventListener("abort", abort));
    });
  };
}
