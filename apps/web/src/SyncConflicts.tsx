import { changedRange } from "./markdown/textFile";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type Preview = {
  target: string;
  local: string | null;
  remote: string | null;
  local_hash: string;
  remote_hash: string;
};
export function SyncConflicts({
  invoke,
  close,
  changed,
}: {
  invoke: <T>(action: string, args?: Record<string, unknown>) => Promise<T>;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<Record<string, string>>();
  const [copy, select] = useState("");
  const [preview, setPreview] = useState<Preview>();
  const [side, setSide] = useState("local");
  const [text, edit] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    let live = true;
    invoke<Record<string, string>>("conflicts")
      .then((rows) => {
        if (live) setItems(rows);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [invoke]);
  async function open(key: string) {
    setBusy(true);
    setError("");
    try {
      const data = await invoke<Preview>("conflict_preview", { copy: key });
      setPreview(data);
      select(key);
      edit(data.remote ?? data.local ?? "");
      setSide("local");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function resolve(choice: "remote" | "local" | "merged") {
    if (!preview || busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("resolve_conflict", {
        copy,
        choice,
        remote_hash: preview.remote_hash,
        local_hash: preview.local_hash,
        text,
      });
      setItems((rows) =>
        Object.fromEntries(
          Object.entries(rows ?? {}).filter(([key]) => key !== copy),
        ),
      );
      setPreview(undefined);
      select("");
      await changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const difference = useMemo(
    () =>
      preview?.local != null && preview.remote != null
        ? changedRange(preview.local, preview.remote)
        : null,
    [preview],
  );
  function compare(side: "local" | "remote") {
    const value = preview?.[side];
    if (value == null)
      return side === "remote" && !preview?.remote_hash
        ? "已删除"
        : "二进制文件";
    if (!difference) return value;
    const end = side === "local" ? difference.oldEnd : difference.newEnd;
    return (
      <>
        {value.slice(0, difference.start)}
        <mark>{value.slice(difference.start, end)}</mark>
        {value.slice(end)}
      </>
    );
  }
  return (
    <dialog
      ref={dialog}
      className="recovery-dialog"
      aria-label="同步冲突"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <h2>同步冲突</h2>
      {preview ? (
        <>
          <h3>{preview.target}</h3>
          <div className="conflict-switch">
            <button onClick={() => setSide("local")}>本地副本</button>
            <button onClick={() => setSide("remote")}>原笔记</button>
          </div>
          <div className="recovery-columns" data-side={side}>
            <section data-side="local">
              <h4>本地副本</h4>
              <pre>{compare("local")}</pre>
            </section>
            <section data-side="remote">
              <h4>原笔记</h4>
              <pre>{compare("remote")}</pre>
            </section>
          </div>
          {preview.local !== null &&
            (!preview.remote_hash || preview.remote !== null) && (
              <label>
                合并正文
                <textarea value={text} onChange={(e) => edit(e.target.value)} />
              </label>
            )}
          <footer>
            <button disabled={busy} onClick={() => resolve("local")}>
              采用本地副本
            </button>
            <button disabled={busy} onClick={() => resolve("remote")}>
              保留原笔记
            </button>
            {preview.local !== null &&
              (!preview.remote_hash || preview.remote !== null) && (
                <button disabled={busy} onClick={() => resolve("merged")}>
                  保存合并结果
                </button>
              )}
          </footer>
        </>
      ) : items ? (
        Object.keys(items).length ? (
          <ul>
            {Object.entries(items).map(([key, target]) => (
              <li key={key}>
                <button disabled={busy} onClick={() => open(key)}>
                  {target} · {key}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>没有待处理冲突。</p>
        )
      ) : (
        !error && <p>正在读取冲突…</p>
      )}
      {error && (
        <p role="alert">
          {error} {copy && <button onClick={() => open(copy)}>重新读取</button>}
        </p>
      )}
      <button disabled={busy} onClick={close}>
        关闭
      </button>
    </dialog>
  );
}
