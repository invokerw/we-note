import { useEffect, useState, type Ref } from "react";
import type { Hit } from "./Resources";

export function NoteInfoToggle({
  id,
  expanded,
  toggle,
}: {
  id: string;
  expanded: boolean;
  toggle: () => void;
}) {
  return (
    <button
      className="metadata-toggle"
      aria-label="笔记信息"
      aria-controls={id}
      aria-expanded={expanded}
      title={expanded ? "收起笔记信息" : "展开笔记信息"}
      onClick={toggle}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="16" height="14" rx="2" />
        <path d="M11.5 3v14M14 7h2M14 10h2" />
      </svg>
    </button>
  );
}

export function NoteInfoPanel({
  id,
  metadata,
  load,
  open,
}: {
  id: string;
  metadata: Ref<HTMLDivElement>;
  load: () => Promise<Hit[]>;
  open: (hit: Hit) => void;
}) {
  const [links, setLinks] = useState<Hit[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLinks(null);
    setError("");
    load()
      .then((hits) => {
        if (active) setLinks(hits);
      })
      .catch((err) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [load]);
  return (
    <aside className="metadata-panel" id={id} aria-label="笔记信息">
      <div ref={metadata} />
      <section className="panel-backlinks" aria-label="反向链接">
        <h2>反向链接</h2>
        {error ? (
          <p role="alert">{error}</p>
        ) : links === null ? (
          <p role="status">正在加载…</p>
        ) : links.length ? (
          <ul>
            {links.map((hit) => (
              <li key={hit.file_id}>
                <button onClick={() => open(hit)}>{hit.path}</button>
              </li>
            ))}
          </ul>
        ) : (
          <p>没有笔记链接到此处。</p>
        )}
      </section>
    </aside>
  );
}
