import { useEffect, useState, useMemo } from "react";
import { request, type Note } from "./api";
export type Hit = Pick<Note, "file_id" | "path">;
type Asset = {
  asset_id: string;
  name: string;
  media_type: string;
  content_size: number;
};
type Job = {
  mode?: "online" | "portable";
  job_id: string;
  scope: string;
  status: string;
  created_at: string;
};
export async function download(token: string, path: string, name: string) {
  const blob = await (await request(token, path)).blob();
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export type ResourceClient = {
  json: (path: string) => Promise<any>;
  createExport: (scope: string, portable: boolean) => Promise<void>;
  blob: (id: string) => Promise<Blob>;
  save: (kind: "asset" | "export", id: string, name: string) => Promise<void>;
};
export function LibraryResources({
  view,
  base,
  token,
  open,
  notify,
}: {
  view: string;
  base: string;
  token: string;
  open: (id: string) => void;
  notify: (s: string) => void;
}) {
  const client = useMemo<ResourceClient>(
    () => ({
      json: async (route) => (await request(token, base + route)).json(),
      createExport: async (scope, portable) => {
        await request(
          token,
          base + "/exports",
          "POST",
          portable ? { scope, mode: "portable" } : { scope },
        );
      },
      blob: async (id) => (await request(token, "/assets/" + id)).blob(),
      save: (kind, id, name) =>
        download(
          token,
          kind === "asset"
            ? "/assets/" + id
            : base + "/exports/" + id + "/download",
          name,
        ),
    }),
    [base, token],
  );
  return (
    <Resources
      view={view}
      client={client}
      open={(h) => open(h.file_id)}
      notify={notify}
    />
  );
}
function useAsset(src: string, client: ResourceClient) {
  const [entry, set] = useState({ src: "", url: "", error: "" });
  useEffect(() => {
    let live = true,
      url = "";
    client
      .blob(src)
      .then((b) => {
        if (live) {
          url = URL.createObjectURL(b);
          set({ src, url, error: "" });
        }
      })
      .catch((e) => {
        if (live) set({ src, url: "", error: String(e) });
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, client]);
  return entry.src === src ? entry : { url: "", error: "" };
}
function Preview({ asset, client }: { asset: Asset; client: ResourceClient }) {
  const { url, error } = useAsset(asset.asset_id, client);
  if (!url) return <p>{error || "正在加载…"}</p>;
  if (asset.media_type.startsWith("image/"))
    return <img src={url} alt={asset.name} />;
  if (asset.media_type.startsWith("audio/"))
    return <audio controls src={url} />;
  if (asset.media_type.startsWith("video/"))
    return <video controls src={url} />;
  if (asset.media_type === "application/pdf")
    return <iframe sandbox="" title={asset.name} src={url} />;
  return <p>下载后可用本地应用打开。</p>;
}
const scopes: Record<string, string> = {
  notes: "仅笔记",
  all: "完整笔记库",
};
export function Resources({
  view,
  client,
  open,
  notify,
}: {
  view: string;
  client: ResourceClient;
  open: (hit: Hit) => void;
  notify: (s: string) => void;
}) {
  const [q, query] = useState(""),
    [tag, setTag] = useState(""),
    [tags, setTags] = useState<Record<string, number>>({}),
    [hits, setHits] = useState<Hit[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [picked, pick] = useState(""),
    [jobs, setJobs] = useState<Job[]>([]),
    [scope, setScope] = useState("all"),
    [portable, setPortable] = useState(false),
    [revision, refresh] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const json = client.json;
    async function load() {
      if (view === "搜索") {
        const [results, counts] = await Promise.all([
          json("/search?" + new URLSearchParams({ q, tag })),
          json("/tags"),
        ]);
        if (live) {
          setHits(results);
          setTags(counts);
        }
      } else if (view === "附件") {
        const result = await json("/assets");
        if (live) setAssets(result);
      } else {
        const result: Job[] = await json("/exports");
        if (live) {
          setJobs(result);
          if (result.some((j) => j.status === "pending"))
            timer = setTimeout(() => refresh((n) => n + 1), 650);
        }
      }
    }
    timer = setTimeout(
      () =>
        load().catch((e) => {
          if (live) notify(String(e));
        }),
      view === "搜索" ? 120 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, client, q, tag, revision]);
  return (
    <article>
      <h1>{view}</h1>
      {view === "搜索" ? (
        <>
          <label>
            全文搜索
            <input
              type="search"
              value={q}
              onChange={(e) => query(e.target.value)}
              placeholder="输入正文或文件路径"
            />
          </label>
          <div className="taglist">
            <button aria-pressed={!tag} onClick={() => setTag("")}>
              全部标签
            </button>
            {Object.entries(tags).map(([t, n]) => (
              <button
                key={t}
                aria-pressed={tag === t}
                onClick={() => setTag(t)}
              >
                #{t} · {n}
              </button>
            ))}
          </div>
          <ul>
            {hits.map((h) => (
              <li key={h.file_id}>
                <button onClick={() => open(h)}>{h.path}</button>
              </li>
            ))}
          </ul>
          {!hits.length && <p>没有匹配的笔记。</p>}
        </>
      ) : view === "附件" ? (
        <>
          {assets.length === 0 && <p>笔记库中还没有附件。</p>}
          {assets.map((a) => (
            <section className="asset-row" key={a.asset_id}>
              <strong>{a.name}</strong>
              <small>
                {a.media_type} · {a.content_size} B
              </small>
              <button
                onClick={() => pick(picked === a.asset_id ? "" : a.asset_id)}
              >
                预览
              </button>
              <button
                onClick={() =>
                  client
                    .save("asset", a.asset_id, a.name)
                    .catch((e) => notify(String(e)))
                }
              >
                下载
              </button>
              {picked === a.asset_id && <Preview asset={a} client={client} />}
            </section>
          ))}
        </>
      ) : (
        <>
          <label>
            导出范围
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {Object.entries(scopes).map(([v, s]) => (
                <option key={v} value={v}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {scope === "all" && (
            <label>
              图片链接
              <select
                value={portable ? "portable" : "online"}
                onChange={(e) => setPortable(e.target.value === "portable")}
              >
                <option value="online">保留在线链接</option>
                <option value="portable">离线便携（使用包内图片）</option>
              </select>
            </label>
          )}
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await client.createExport(scope, scope === "all" && portable);
                refresh((n) => n + 1);
              } catch (e) {
                notify(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            创建导出
          </button>
          {jobs.map((j) => (
            <div className="row" key={j.job_id}>
              <span>
                {scopes[j.scope]}
                {j.mode === "portable" ? " · 离线便携" : ""} ·{" "}
                {new Date(j.created_at).toLocaleString()}
              </span>
              {j.status === "completed" ? (
                <button
                  onClick={() =>
                    client
                      .save(
                        "export",
                        j.job_id,
                        `wenote-${j.scope}${j.mode === "portable" ? "-portable" : ""}.zip`,
                      )
                      .catch((e) => notify(String(e)))
                  }
                >
                  下载 ZIP
                </button>
              ) : (
                <span>{j.status === "failed" ? "导出失败" : "正在打包…"}</span>
              )}
            </div>
          ))}
        </>
      )}
    </article>
  );
}
