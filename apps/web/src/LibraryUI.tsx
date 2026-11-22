import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export function Brand() {
  return (
    <span className="brand">
      <i aria-hidden="true" />
      WeNote
    </span>
  );
}

export function Cover() {
  return (
    <div className="cover-panel" aria-hidden="true">
      <Brand />
      <div className="folio">
        <i />
      </div>
    </div>
  );
}

export function Popup({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  const [shown, show] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  useEffect(() => {
    if (!shown) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) show(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        show(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [shown]);
  return (
    <div
      className="popup"
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) show(false);
      }}
    >
      <button
        ref={trigger}
        title={label}
        aria-label={label}
        aria-controls={id}
        aria-expanded={shown}
        onClick={() => show(!shown)}
      >
        {icon}
      </button>
      {shown && (
        <div
          className="popup-list"
          id={id}
          onClick={(e) => {
            if ((e.target as Element).closest("button")) {
              show(false);
              trigger.current?.focus();
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const modeLabels = {
  split: "分屏编辑",
  live: "所见所得",
  read: "预览模式",
  edit: "源码",
  map: "思维导图",
} as const;
export function NoteHeading({
  path,
  mode,
  change,
  markdown,
  save,
  share,
  more,
  busy,
}: {
  path: string;
  mode: string;
  change?: (mode: keyof typeof modeLabels) => void;
  markdown: boolean;
  save?: ReactNode;
  share?: { label: string; run: () => void };
  more: ReactNode;
  busy: boolean;
}) {
  return (
    <header className="document-head">
      <h1 title={path}>{path.split("/").at(-1)}</h1>
      <div className="head-actions">
        {save}
        {change && (
          <Popup
            label="编辑模式"
            icon={<i className="mode-icon" aria-hidden="true" />}
          >
            {(Object.entries(modeLabels) as [keyof typeof modeLabels, string][])
              .filter(([id]) => markdown || ["read", "edit"].includes(id))
              .map(([id, label]) => (
                <button
                  key={id}
                  aria-pressed={mode === id}
                  disabled={busy}
                  onClick={() => change(id)}
                >
                  {label}
                </button>
              ))}
          </Popup>
        )}
        {share && (
          <button
            className="share-action"
            aria-label={share.label}
            title={share.label}
            disabled={busy}
            onClick={share.run}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 20 20"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M8 5H3v12h13v-5M9 11l8-8m-6 0h6v6" />
            </svg>
          </button>
        )}
        <Popup label="更多操作" icon="•••">
          {more}
        </Popup>
      </div>
    </header>
  );
}

export function usePanes() {
  const [folder, setFolder] = useState<string | null>(null),
    [pane, setPane] = useState<"nav" | "list" | "doc">("list"),
    [columns, setColumns] = useState(3);
  function browse(dir: string | null) {
    setFolder(dir);
    setPane("list");
  }
  return { folder, browse, pane, setPane, columns, setColumns };
}
type Panes = ReturnType<typeof usePanes>;
type Folder = { prefix: string; children: Map<string, Folder> };
function FolderRows({
  node,
  active,
  select,
}: {
  node: Folder;
  active: string | null;
  select: (p: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const label = node.prefix.split("/").at(-2) || "我的文件夹";
  return (
    <li>
      <div
        className={"folder-row" + (active === node.prefix ? " current" : "")}
      >
        {node.children.size ? (
          <button
            aria-label={(expanded ? "折叠" : "展开") + label}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="indent" />
        )}
        <button
          className="folder-name"
          aria-current={active === node.prefix ? "location" : undefined}
          onClick={() => select(node.prefix)}
        >
          <i className="folder-icon" />
          {label}
        </button>
      </div>
      {expanded && !!node.children.size && (
        <ul>
          {Array.from(node.children.values(), (child) => (
            <FolderRows
              key={child.prefix}
              node={child}
              active={active}
              select={select}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
export function LibraryPanes({
  paths,
  dates,
  active,
  open,
  panes,
  vault,
  create,
  tools,
  account,
  listActions,
  busy = false,
  libraryTitle,
}: {
  paths: string[];
  dates?: Map<string, string>;
  active: string;
  open: (path: string) => void;
  panes: Panes;
  vault?: ReactNode;
  create: ReactNode;
  tools: ReactNode;
  account: ReactNode;
  listActions?: ReactNode;
  busy?: boolean;
  libraryTitle: string;
}) {
  const { folder, pane, columns, setPane, setColumns } = panes;
  const [query, search] = useState(""),
    [reverse, sort] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const tree = useMemo(() => {
    const root: Folder = { prefix: "", children: new Map() };
    for (const path of paths) {
      let node = root;
      for (const part of path.split("/").slice(0, -1)) {
        if (!node.children.has(part))
          node.children.set(part, {
            prefix: node.prefix + part + "/",
            children: new Map(),
          });
        node = node.children.get(part)!;
      }
    }
    return root;
  }, [paths]);
  const pickFolder = (p: string | null) => {
    search("");
    panes.browse(p);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setColumns(3);
        setPane("list");
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setColumns, setPane]);
  const q = query.trim().toLocaleLowerCase();
  const { directories, notes } = useMemo(() => {
    const counts = new Map<string, number>();
    const notes: string[] = [];
    for (const path of paths) {
      if (q) {
        if (path.toLocaleLowerCase().includes(q)) notes.push(path);
        continue;
      }
      if (folder !== null) {
        if (!path.startsWith(folder)) continue;
        const end = path.indexOf("/", folder.length);
        if (end !== -1) {
          const dir = path.slice(0, end + 1);
          counts.set(dir, (counts.get(dir) || 0) + 1);
          continue;
        }
      }
      notes.push(path);
    }
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    const compare = (a: string, b: string) =>
      (reverse ? -1 : 1) * collator.compare(a, b);
    return {
      directories: Array.from(counts).sort(([a], [b]) => compare(a, b)),
      notes: notes.sort(compare),
    };
  }, [paths, q, folder, reverse]);
  return (
    <>
      {columns < 3 && (
        <button className="restore-layout" onClick={() => setColumns(3)}>
          {columns === 1 ? "退出专注" : "展开目录"}
        </button>
      )}
      <nav className="mobile-bar" aria-label="工作区面板">
        {(
          [
            ["nav", "目录"],
            ["list", "列表"],
            ["doc", "正文"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            aria-pressed={pane === key}
            onClick={() => setPane(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      <aside className="sidebar">
        <Brand />
        {vault}
        {create}
        <div className="side-files">
          <button
            className={"all-notes" + (folder === null ? " current" : "")}
            onClick={() => pickFolder(null)}
          >
            ▦　全部笔记
          </button>
          <ul className="folders">
            <FolderRows node={tree} active={folder} select={pickFolder} />
          </ul>
        </div>
        <nav className="sections" aria-label="笔记库工具">
          {tools}
        </nav>
        <div className="account">{account}</div>
        <div className="layout-options" aria-label="面板布局">
          {[3, 2, 1].map((n) => (
            <button
              key={n}
              aria-label={["", "单栏布局", "双栏布局", "三栏布局"][n]}
              title={["", "单栏布局", "双栏布局", "三栏布局"][n]}
              aria-pressed={columns === n}
              onClick={() => {
                setColumns(n);
                setPane("doc");
              }}
            >
              <i data-cols={n} />
            </button>
          ))}
        </div>
      </aside>
      <section className="note-list-pane" aria-label="笔记列表">
        <div className="list-search">
          <input
            ref={input}
            type="search"
            aria-label="筛选笔记路径"
            placeholder="搜索笔记"
            title="搜索笔记（Ctrl / ⌘ + Shift + F）"
            value={query}
            onChange={(e) => search(e.target.value)}
          />
          <button
            title={reverse ? "切换为名称升序" : "切换为名称降序"}
            aria-label="切换排序"
            aria-pressed={reverse}
            onClick={() => sort(!reverse)}
          >
            ⇅
          </button>
        </div>
        <div className="list-title">
          {folder !== null && !q && (
            <button
              aria-label="上一级目录"
              onClick={() =>
                pickFolder(folder ? folder.replace(/[^/]+\/$/, "") : null)
              }
            >
              ‹
            </button>
          )}
          <strong>
            {q
              ? "搜索结果"
              : folder === null
                ? "全部笔记"
                : folder.split("/").at(-2) || "我的文件夹"}
          </strong>
        </div>
        <div className="list-scroll">
          {directories.map(([dir, count]) => (
            <button className="entry" key={dir} onClick={() => pickFolder(dir)}>
              <span>
                <i className="folder-icon" />
                {dir.split("/").at(-2)}
              </span>
              <small>{count} 篇笔记</small>
            </button>
          ))}
          {notes.map((path) => (
            <button
              className={"entry" + (active === path ? " current" : "")}
              key={path}
              aria-label={path.split("/").at(-1)}
              title={path}
              disabled={busy}
              aria-current={active === path ? "page" : undefined}
              onClick={() => open(path)}
            >
              <span>
                <i className="file-icon" aria-hidden="true">
                  {path.split(".").at(-1)?.slice(0, 1).toUpperCase()}
                </i>
                {path.split("/").at(-1)}
              </span>
              <small>
                {dates?.get(path)?.slice(0, 10).replaceAll("-", ".") ||
                  libraryTitle}
                {(q || folder === null) && path.includes("/")
                  ? " · " + path.slice(0, path.lastIndexOf("/"))
                  : ""}
              </small>
            </button>
          ))}
          {!notes.length && !directories.length && (
            <p className="list-empty">
              {q ? "没有匹配的笔记" : "此处还没有笔记"}
            </p>
          )}
        </div>
        <footer>
          总共 {directories.length + notes.length} 项{listActions}
        </footer>
      </section>
    </>
  );
}
