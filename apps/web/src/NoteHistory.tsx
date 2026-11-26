import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { request, type Version } from "./api";
import { browserExport, decodeText } from "./plugins/archive";
import "./noteHistory.css";

type Preview = { id: string; bytes: Uint8Array; text: string | null };
const displayTime = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Shanghai",
});

function BinarySource({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [page, setPage] = useState(0);
  const pageSize = 256;
  const start = page * pageSize, end = Math.min(start + pageSize, bytes.length);
  const rows = [];
  for (let offset = start; offset < end; offset += 16) {
    const hex = Array.from(bytes.subarray(offset, offset + 16), b => b.toString(16).padStart(2, "0")).join(" ");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex}`);
  }
  return <>
    <div className="history-binary-tools"><span>原始字节 · {bytes.length.toLocaleString()} B</span>
      <button onClick={() => browserExport(name, bytes)}>下载原文件</button>
    </div>
    <pre>{rows.join("\n")}</pre>
    {bytes.length > pageSize && <div className="history-binary-tools">
      <button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{page + 1} / {Math.ceil(bytes.length / pageSize)}</span>
      <button disabled={end === bytes.length} onClick={() => setPage(page + 1)}>下一页</button>
    </div>}
  </>;
}

export function NoteHistory({ token, path, name, draft, restore, close }: {
  token: string; path: string; name: string; draft: boolean;
  restore: (id: string, bytes: Uint8Array) => Promise<void>; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<Version[]>();
  const [canRestore, setCanRestore] = useState(false);
  const [selected, select] = useState("");
  const [detail, setDetail] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const version = versions?.find(v => v.version_id === selected);
  const current = versions?.[0]?.version_id;
  const loaded = preview?.id === selected ? preview : undefined;

  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    let active = true;
    request(token, path + "/versions").then(r => r.json()).then(data => {
      if (!active) return;
      setVersions(data.versions);
      setCanRestore(data.can_restore);
      select(data.versions[0]?.version_id ?? "");
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [path, token]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setError("");
    request(token, `${path}/versions/${selected}/content`).then(r => r.arrayBuffer()).then(buffer => {
      if (!active) return;
      const bytes = new Uint8Array(buffer);
      let text = null;
      try { text = decodeText(bytes); } catch { /* Preserve binary source for download and restore. */ }
      setPreview({ id: selected, bytes, text });
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [path, token, selected]);

  async function restoreSelected() {
    if (!loaded || draft || saving) return;
    setSaving(true);
    setError("");
    try { await restore(loaded.id, loaded.bytes); close(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setSaving(false); }
  }
  return <dialog ref={dialog} className="note-history" aria-label="历史版本"
    onCancel={event => { event.preventDefault(); if (!saving) close(); }}>
    <header><div><h2>历史版本</h2><span title={name}>{name}</span></div>
      <button type="button" className="history-close" aria-label="关闭历史版本" disabled={saving} onClick={close}>×</button>
    </header>
    <div className="history-body" data-detail={detail}>
      <nav aria-label="版本列表">
        {versions?.map(v => <button type="button" key={v.version_id} aria-pressed={v.version_id === selected} disabled={saving}
          onClick={() => { select(v.version_id); setDetail(true); }}>
          <strong>版本 {v.vault_revision}</strong> {v.version_id === current && <small>当前</small>}
          <time dateTime={v.created_at}>{displayTime.format(new Date(v.created_at))}</time>
        </button>)}
        {!versions && !error && <p>正在加载版本…</p>}
        {versions?.length === 0 && <p>暂无历史版本</p>}
      </nav>
      <section aria-label="版本原文">
        <div className="history-preview-head"><button className="history-back" disabled={saving} onClick={() => setDetail(false)}>‹ 版本列表</button>
          {version && <strong>版本 {version.vault_revision} 原文</strong>}
        </div>
        {loaded ? loaded.text !== null ? <pre>{loaded.text || "（空文档）"}</pre> : <BinarySource key={loaded.id} name={name} bytes={loaded.bytes} />
          : selected && !error && <p role="status">正在读取原文…</p>}
      </section>
    </div>
    <footer><div>{error ? <span role="alert">{error}</span> : !canRestore ? "" : draft ? "有未保存的修改。请先返回正文保存，再恢复版本。" : "恢复会创建一个新版本。"}</div>
      {canRestore && <button className="history-restore" disabled={!loaded || selected === current || draft || saving} onClick={restoreSelected}>{saving ? "正在恢复…" : "恢复此版本"}</button>}
    </footer>
  </dialog>;
}
