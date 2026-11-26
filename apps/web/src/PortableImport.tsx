import { useEffect, useLayoutEffect, useState, useRef } from "react";
import type { ResourceClient } from "./Resources";

export type ImportJob = {
  id: string;
  status: "preview" | "completed";
  folder: string;
  files: string[];
  assets: number;
  unused: number;
  conflicts: string[] | null;
  warnings: string[];
  exported: string;
  completed?: string;
  prior?: string;
};

function ImportPreview({
  job,
  vaultName,
  offline,
  progress,
  message,
  dismiss,
  cancel,
  confirm,
}: {
  job: ImportJob;
  vaultName: string;
  offline: boolean;
  progress: string;
  message: string;
  dismiss: () => void;
  cancel: () => void;
  confirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="entry-dialog import-preview"
      aria-labelledby="import-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!progress) dismiss();
      }}
    >
      <h2 id="import-preview-title">导入预览</h2>
      <div className="import-preview-content">
        <p>
          {job.files.length} 篇笔记 · {job.assets} 个资源文件
        </p>
        <dl>
          <dt>目标笔记库</dt>
          <dd>{vaultName}</dd>
          <dt>目标目录</dt>
          <dd>{job.folder || "库根目录"}</dd>
          <dt>导出时间</dt>
          <dd>{new Date(job.exported).toLocaleString()}</dd>
        </dl>
        {job.prior && <p>此包曾导入本库 · {job.prior}</p>}
        {!!job.conflicts?.length && (
          <details open>
            <summary>同名路径 · 整包将放入「{job.folder}」</summary>
            <ul>
              {job.conflicts.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </details>
        )}
        {job.unused > 0 && <p>含 {job.unused} 个未引用的资源文件。</p>}
        {!!job.warnings.length && (
          <details open>
            <summary>需核对的链接</summary>
            <ul>
              {job.warnings.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
          </details>
        )}
        <details>
          <summary>笔记目录</summary>
          <ul>
            {job.files.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      </div>
      {progress && <p role="status">{progress}</p>}
      {message && <p role="alert">{message}</p>}
      {offline && <p role="status">连接服务器并登录当前库后可继续。</p>}
      <footer>
        {offline && (
          <button disabled={!!progress} onClick={dismiss}>
            返回设置
          </button>
        )}
        <button disabled={!!progress || offline} onClick={cancel}>
          取消导入
        </button>
        <button
          className="primary"
          disabled={!!progress || offline}
          onClick={confirm}
        >
          确认导入
        </button>
      </footer>
    </dialog>
  );
}

export function PortableImport({
  client,
  vaultName,
  unavailable,
  onImported,
  viewFolder,
}: {
  client: ResourceClient;
  vaultName: string;
  unavailable?: boolean;
  onImported?: () => Promise<void>;
  viewFolder: (folder: string) => Promise<void> | void;
}) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [previewId, setPreviewId] = useState("");
  const preview = jobs.find(
    (job) => job.id === previewId && job.status === "preview",
  );
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const changed = useRef(0);
  const disabled = unavailable || !online;
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, []);
  useEffect(() => {
    let live = true;
    const revision = changed.current;
    if (!disabled)
      client
        .json("/imports")
        .then((list) => {
          if (live && changed.current === revision) setJobs(list);
        })
        .catch((e) => {
          if (live) setMessage(String(e));
        });
    return () => {
      live = false;
    };
  }, [client, disabled]);
  function update(job: ImportJob) {
    changed.current++;
    setJobs((old) => [job, ...old.filter((item) => item.id !== job.id)]);
  }
  async function run(label: string, action: () => Promise<void>) {
    setMessage("");
    setProgress(label);
    try {
      await action();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setProgress("");
    }
  }
  return (
    <section aria-label="导入离线便携包">
      <h3>导入</h3>
      <p>选择通过「完整笔记库 → 离线便携」导出的 ZIP。</p>
      {disabled && <p role="status">连接服务器并登录当前库后可导入。</p>}
      <label>
        选择 ZIP{" "}
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={!!progress || disabled}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file)
              void run("正在上传并校验…", async () => {
                if (file.size > 256 * 1024 * 1024)
                  throw Error("ZIP 最大为 256 MiB");
                const job = await client.previewImport(file);
                update(job);
                setPreviewId(job.id);
              });
          }}
        />
      </label>
      {!preview && progress && <p role="status">{progress}</p>}
      {!preview && message && <p role="status">{message}</p>}
      {jobs.map((job) => (
        <article key={job.id}>
          <h4>{job.status === "preview" ? "待确认导入" : "导入完成"}</h4>
          <p>
            {job.files.length} 篇笔记 · {job.assets} 个资源文件 ·{" "}
            {job.folder || "库根目录"}
          </p>
          <p>
            {job.completed ? "导入时间" : "导出时间"} ·{" "}
            {new Date(job.completed || job.exported).toLocaleString()}
          </p>
          {job.status === "preview" ? (
            <button
              disabled={!!progress}
              onClick={() => {
                setMessage("");
                setPreviewId(job.id);
              }}
            >
              查看导入预览
            </button>
          ) : (
            <button
              disabled={!!progress}
              onClick={() =>
                run("正在打开…", async () => {
                  await viewFolder(job.folder);
                })
              }
            >
              查看笔记
            </button>
          )}
        </article>
      ))}
      {preview && (
        <ImportPreview
          job={preview}
          vaultName={vaultName}
          offline={!!disabled}
          progress={progress}
          message={message}
          dismiss={() => {
            setMessage("");
            setPreviewId("");
          }}
          cancel={() =>
            run("正在取消…", async () => {
              await client.cancelImport(preview.id);
              changed.current++;
              setJobs((old) => old.filter((job) => job.id !== preview.id));
              setPreviewId("");
            })
          }
          confirm={() =>
            run("正在导入…", async () => {
              const result = await client.confirmImport(
                preview.id,
                preview.folder,
              );
              update(result);
              if (result.status === "completed") {
                setPreviewId("");
                await onImported?.();
              } else setMessage("目标目录已变化，请核对后再次确认。");
            })
          }
        />
      )}
    </section>
  );
}
