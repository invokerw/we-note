import { PortableImport, type ImportJob } from "./PortableImport";
import { useEffect, useState, useMemo } from "react";
import { request, type Note } from "./api";
export type Hit = Pick<Note, "file_id" | "path">;
type Job = {
  mode?: "online" | "portable";
  job_id: string;
  scope: string;
  status: string;
  created_at: string;
};
export async function download(
  token: string,
  path: string,
  name: string,
  method = "GET",
) {
  const blob = await (await request(token, path, method)).blob();
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export type ResourceClient = {
  json: (path: string) => Promise<any>;
  previewImport: (file: File) => Promise<ImportJob>;
  confirmImport: (id: string, folder: string) => Promise<ImportJob>;
  cancelImport: (id: string) => Promise<void>;
  createExport: (scope: string, portable: boolean) => Promise<void>;
  save: (
    kind: "asset" | "export",
    id: string,
    name: string,
  ) => Promise<string | void>;
};
export function LibraryResources({
  base,
  token,
  onImported,
  viewFolder,
}: {
  base: string;
  token: string;
  onImported: () => Promise<void>;
  viewFolder: (folder: string) => void;
}) {
  const client = useMemo<ResourceClient>(
    () => ({
      json: async (route) => (await request(token, base + route)).json(),
      previewImport: async (file) =>
        (await request(token, base + "/imports", "POST", file)).json(),
      confirmImport: async (id, folder) =>
        (
          await request(token, `${base}/imports/${id}/confirm`, "POST", {
            folder,
          })
        ).json(),
      cancelImport: async (id) => {
        await request(token, `${base}/imports/${id}`, "DELETE");
      },
      createExport: async (scope, portable) => {
        await request(
          token,
          base + "/exports",
          "POST",
          portable ? { scope, mode: "portable" } : { scope },
        );
      },
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
      key={base}
      client={client}
      onImported={onImported}
      viewFolder={viewFolder}
    />
  );
}
const scopes: Record<string, string> = {
  notes: "仅笔记",
  all: "完整笔记库",
};
export function Resources({
  client,
  onImported,
  viewFolder,
  unavailable,
}: {
  client: ResourceClient;
  onImported?: () => Promise<void>;
  viewFolder: (folder: string) => Promise<void> | void;
  unavailable?: boolean;
}) {
  const [message, notify] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]),
    [scope, setScope] = useState("all"),
    [portable, setPortable] = useState(false),
    [revision, refresh] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const json = client.json;
    async function load() {
      const result: Job[] = await json("/exports");
      if (live) {
        setJobs(result);
        if (result.some((j) => j.status === "pending"))
          timer = setTimeout(() => refresh((n) => n + 1), 650);
      }
    }
    timer = setTimeout(
      () =>
        load().catch((e) => {
          if (live) notify(String(e));
        }),
      0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, revision]);
  return (
    <>
      <article>
        <h3>导出</h3>
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
            notify("");
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
                    .then((path) => {
                      if (path) notify("已保存到 " + path);
                    })
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
        {message && <p role="status">{message}</p>}
      </article>
      <PortableImport
        client={client}
        unavailable={unavailable}
        onImported={onImported}
        viewFolder={viewFolder}
      />
    </>
  );
}
