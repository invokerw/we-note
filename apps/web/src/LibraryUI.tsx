import { MatchText, SearchField, useDocumentMatches, useRecentSearches } from "./LibrarySearch";
import { markdownModes, type MarkdownMode } from "./markdown/modes";
import { AppShell } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { PhoneIcon, PhoneSheet } from "./PhoneUI";
import { EntryMenus } from "./EntryMenu";
import {
  entryName,
  isFolder,
  parentFolder,
  type EntryIO,
} from "./libraryEntries";
import {
  useCallback,
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

const textModes = [["read", "预览模式"], ["edit", "源码"]] as const;
export function NoteHeading({
  path,
  mode,
  change,
  markdown,
  save,
  share,
  more,
  busy,
  handset,
  endAction,
}: {
  endAction?: ReactNode;
  handset?: {
    back: () => void;
    edit: () => void;
    finish: () => void;
    dirty: boolean;
  };
  path: string;
  mode: string;
  change?: (mode: MarkdownMode | "edit") => void;
  markdown: boolean;
  save?: ReactNode;
  share?: { label: string; run: () => void };
  more: ReactNode;
  busy: boolean;
}) {
  const [sheet, setSheet] = useState<"modes" | "more" | null>(null);
  const modes = markdown ? markdownModes : textModes;
  if (handset)
    return (
      <header className="phone-head phone-document-head">
        <button aria-label="返回笔记列表" onClick={handset.back}>
          <PhoneIcon name="back" />
        </button>
        <h1 title={path}>{entryName(path)}</h1>
        {change && (
          <button
            className="phone-edit"
            disabled={busy}
            onClick={() =>
              mode === "read" && !handset.dirty
                ? handset.edit()
                : handset.finish()
            }
          >
            {mode === "read" ? (handset.dirty ? "保存" : "编辑") : "完成"}
          </button>
        )}
        {endAction}
        <button aria-label="更多操作" onClick={() => setSheet("more")}><PhoneIcon name="more" /></button>
        {sheet && (
          <PhoneSheet
            title={sheet === "modes" ? "编辑模式" : "更多操作"}
            close={() => setSheet(null)}
            back={sheet === "modes" ? () => setSheet("more") : undefined}
          >
            <div className="phone-choices">
              {sheet === "modes" ? (
                modes.map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={mode === id}
                    onClick={() => {
                      change?.(id);
                      setSheet(null);
                    }}
                  >
                    {label}
                  </button>
                ))
              ) : (
                <>
                  {change && <button onClick={() => setSheet("modes")}>编辑模式</button>}
                  <div onClick={() => setSheet(null)}>
                    {share && <button onClick={share.run} disabled={busy}>{share.label}</button>}
                    {more}
                  </div>
                </>
              )}
            </div>
          </PhoneSheet>
        )}
      </header>
    );
  return (
    <header className="document-head">
      <h1 title={path}>{path.split("/").at(-1)}</h1>
      <div className="head-actions">
        {save}
        {change && (
          <Popup
            label="编辑模式"
            icon={
              <span className="mode-label">
                <i className="mode-icon" aria-hidden="true" />
                {modes.find(([id]) => id === mode)?.[1] ?? "编辑模式"}
                <span aria-hidden="true">⌄</span>
              </span>
            }
          >
            {modes.map(([id, label]) => (
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
        {endAction}
      </div>
    </header>
  );
}

export function usePanes() {
  const [query, search] = useState("");
  const [folder, setFolder] = useState<string | null>(null),
    [pane, setPane] = useState<"nav" | "list" | "doc">("list"),
    [columns, setColumns] = useState(() => {
      try {
        const stored = Number(localStorage.getItem("wenote-workspace-columns"));
        return [1, 2].includes(stored) ? stored : 3;
      } catch {
        return 3;
      }
    });
  const beforeFocus = useRef(3);
  const chooseColumns = useCallback((next: number) => {
    if (next !== 1) beforeFocus.current = next;
    try {
      localStorage.setItem("wenote-workspace-columns", String(next));
      if (next !== 1) localStorage.setItem("wenote-workspace-expanded", String(next));
    } catch { /* Storage can be disabled in a private browser. */ }
    setColumns(next);
  }, []);
  function toggleFocus() {
    if (columns !== 1) return chooseColumns(1);
    let previous = beforeFocus.current;
    try {
      if (localStorage.getItem("wenote-workspace-expanded") === "2") previous = 2;
    } catch { /* Use the layout remembered for this session. */ }
    chooseColumns(previous);
  }
  function browse(dir: string | null) {
    search("");
    setFolder(dir);
    setPane("list");
  }
  return { query, search, folder, browse, pane, setPane, columns, setColumns: chooseColumns, toggleFocus };
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
        data-library-path={node.prefix}
        className={"folder-row" + (active === node.prefix ? " current" : "")}
      >
        {node.children.size ? (
          <button
            type="button"
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
          type="button"
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
export function FolderTree({ paths, active, select, includeRoot = true }: {
  paths: string[];
  active: string | null;
  select: (path: string) => void;
  includeRoot?: boolean;
}) {
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
  return <ul className="folders">{includeRoot
    ? <FolderRows node={tree} active={active} select={select} />
    : Array.from(tree.children.values(), child => <FolderRows key={child.prefix} node={child} active={active} select={select} />)}
  </ul>;
}
export function LibraryPanes({
  paths,
  dates,
  sizes,
  active,
  open,
  panes,
  vault,
  create,
  trash,
  avatar,
  searchContent,
  historyKey,
  allNotes,
  listActions,
  entries,
  busy = false,
  libraryTitle,
  phone = false,
}: {
  phone?: boolean;
  paths: string[];
  dates?: Map<string, string>;
  sizes?: Map<string, number | undefined>;
  active: string;
  open: (path: string) => void;
  panes: Panes;
  vault?: ReactNode;
  create: ReactNode;
  trash: { active: boolean; open: () => void; disabled?: boolean; list: ReactNode };
  avatar: ReactNode;
  searchContent: (query: string) => Promise<string[]>;
  historyKey: string;
  allNotes?: () => boolean;
  listActions?: ReactNode;
  entries?: EntryIO;
  busy?: boolean;
  libraryTitle: string;
}) {
  const { folder, pane, columns, setPane, setColumns } = panes;
  const { query, search } = panes;
  const tablet = useMediaQuery("(min-width: 721px) and (max-width: 1023px)") && !phone;
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog || !tablet || pane !== "nav") return;
    dialog.showModal();
    return () => dialog.close();
  }, [tablet, pane]);
  const [reverse, sort] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  function pickFolder(path: string | null) {
    if (trash.active && path !== null && allNotes && !allNotes()) return;
    panes.browse(path);
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        if (trash.active && allNotes && !allNotes()) return;
        setColumns(3);
        setPane("list");
        requestAnimationFrame(() => input.current?.focus());
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setColumns, setPane, allNotes, trash.active]);
  const q = query.trim().toLocaleLowerCase();
  const history = useRecentSearches(historyKey);
  const [currentOnly, setCurrentOnly] = useState(false);
  const [result, setResult] = useState<{ query: string; hits: Set<string>; error?: string }>();
  useDocumentMatches(query,active);
  useEffect(() => {
    if (!q) {setResult(undefined);return;}
    let live = true;
    const timer = setTimeout(async () => {
      try {const paths = await searchContent(q); if (live) setResult({query:q,hits:new Set(paths)});}
      catch(e) {if(live) setResult({query:q,hits:new Set(),error:String(e)});}
    },150);
    return () => {live = false;clearTimeout(timer);};
  },[q,searchContent]);
  const { directories, notes } = useMemo(() => {
    const counts = new Map<string, number>();
    const notes: string[] = [];
    for (const path of paths) {
      if (q) {
        if (currentOnly && folder && !path.startsWith(folder)) continue;
        const lowerPath = path.toLocaleLowerCase();
        if (!isFolder(path) && (lowerPath.includes(q) || (result?.query === q && result.hits.has(path)))) notes.push(path);
        let slash = path.indexOf("/");
        while (slash >= 0) {
          const dir = path.slice(0, slash + 1);
          if ((!currentOnly || !folder || (dir.startsWith(folder) && dir !== folder)) && entryName(dir).toLocaleLowerCase().includes(q)) counts.set(dir,(counts.get(dir) || 0) + (isFolder(path) ? 0 : 1));
          slash = path.indexOf("/",slash+1);
        }
        continue;
      }
      if (folder !== null) {
        if (!path.startsWith(folder)) continue;
        const end = path.indexOf("/", folder.length);
        if (end !== -1) {
          const dir = path.slice(0, end + 1);
          counts.set(dir, (counts.get(dir) || 0) + (isFolder(path) ? 0 : 1));
          continue;
        }
      }
      if (!isFolder(path)) notes.push(path);
    }
    const collator = new Intl.Collator("zh-CN", { numeric: true });
    const compare = (a: string, b: string) =>
      (reverse ? -1 : 1) * collator.compare(a, b);
    return {
      directories: Array.from(counts).sort(([a], [b]) => compare(a, b)),
      notes: notes.sort(compare),
    };
  }, [paths, q, folder, reverse, currentOnly, result]);
  const sidebar = (
    <AppShell.Navbar className="sidebar" aria-label="笔记库目录">
      {phone ? (
        <header className="phone-head">
          <button aria-label="返回笔记列表" onClick={() => setPane("list")}><PhoneIcon name="back" /></button>
          <h1>笔记库目录</h1>
        </header>
      ) : avatar}
      {vault}
      {!phone && create}
      <div className="side-files">
        <button aria-label="全部笔记" className={"all-notes" + (!trash.active && folder === null ? " current" : "")}
          onClick={() => { if (!allNotes || allNotes()) pickFolder(null); }}>
          ▦　全部笔记
        </button>
        <FolderTree paths={paths} active={trash.active ? null : folder} select={pickFolder} />
        <button className={"sidebar-trash" + (trash.active ? " current" : "")} aria-current={trash.active ? "page" : undefined}
          disabled={trash.disabled} onClick={trash.open}><PhoneIcon name="trash" />回收站</button>
      </div>
      {phone && <div className="phone-library-actions">{listActions}</div>}
      {!phone && (
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
      )}
    </AppShell.Navbar>
  );
  return (
    <EntryMenus
      paths={paths}
      phone={phone}
      io={busy ? undefined : entries}
      onChange={(src, dst) => {
        if (!src) pickFolder(dst);
        else if (folder !== null && folder.startsWith(src))
          pickFolder(dst ? dst + folder.slice(src.length) : parentFolder(src));
      }}
    >
      {!phone && columns < 3 && (
        <button className="restore-layout" onClick={() => columns === 1 ? panes.toggleFocus() : setColumns(3)}>
          {columns === 1 ? "退出专注" : "展开目录"}
        </button>
      )}
      {!phone && (
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
      )}
      {phone && pane === "list" && (
        <nav className="phone-tabs" aria-label="笔记库导航">
          <button
            aria-current={!trash.active && folder === null ? "page" : undefined}
            onClick={() => {if(!allNotes || allNotes()) pickFolder(null);}}
          >
            <PhoneIcon name="notes" />
            笔记
          </button>
          <button
            className="phone-new"
            aria-label="新建"
            data-phone-create
            data-library-path={folder || ""}
            disabled={busy || !entries}
          >
            <i>
              <PhoneIcon name="new" />
            </i>
            新建
          </button>
          <button
            aria-current={folder !== null ? "page" : undefined}
            onClick={() => pickFolder("")}
          >
            <PhoneIcon name="folder" />
            文件夹
          </button>
        </nav>
      )}
      {tablet ? (
        <dialog ref={drawer} className="directory-drawer" aria-label="笔记库目录" onCancel={() => setPane("list")}>
          <button type="button" onClick={() => setPane("list")}>关闭目录</button>
          {sidebar}
        </dialog>
      ) : sidebar}
      <section className="note-list-pane" aria-label="笔记列表">
        {phone && (
          <header className="phone-head phone-library-head">
            {avatar}
            {!trash.active && folder && (
              <button
                aria-label="上一级目录"
                onClick={() => pickFolder(parentFolder(folder))}
              >
                <PhoneIcon name="back" />
              </button>
            )}
            <h1>
              {trash.active ? "回收站" : q
                ? "搜索结果"
                : folder === null
                  ? "全部笔记"
                  : entryName(folder)}
            </h1>
            <button aria-label="打开笔记库目录" onClick={() => setPane("nav")}>
              <PhoneIcon name="folder" />
            </button>
          </header>
        )}
        {trash.active ? <>
          {!phone && <div className="list-title trash-list-title">
            {tablet && <button aria-label="打开目录" onClick={() => setPane("nav")}><PhoneIcon name="folder" /></button>}
            <h1>回收站</h1>
          </div>}
          {trash.list}
        </> : <><div className="list-search">
          {tablet && <button aria-label="打开目录" onClick={() => setPane("nav")}><PhoneIcon name="folder" /></button>}
          <SearchField input={input} query={query} change={search} folder={folder} currentOnly={currentOnly} setCurrentOnly={setCurrentOnly} history={history}/>
          <button
            title={reverse ? "切换为名称升序" : "切换为名称降序"}
            aria-label="切换排序"
            aria-pressed={reverse}
            onClick={() => sort(!reverse)}
          >
            {phone ? <PhoneIcon name="sort" /> : "⇅"}
          </button>
        </div>
        {!phone && (
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
        )}
        <div
          className="list-scroll"
          data-library-path={folder || ""}
          data-library-background
          tabIndex={-1}
        >
          {directories.map(([dir, count]) => (
            <div className="entry-row" key={dir} data-library-path={dir}>
              <button className="entry" onClick={() => {history.remember(query);pickFolder(dir);}}>
                <span>
                  <i className="folder-icon" />
                  <MatchText text={entryName(dir)} term={q}/>
                </span>
                <small>{count} 篇笔记</small>
              </button>
              {entries && <EntryMore name={dir} />}
            </div>
          ))}
          {notes.map((path) => (
            <div className="entry-row" key={path} data-library-path={path}>
              <button
                className={"entry" + (active === path ? " current" : "")}
                aria-label={path.split("/").at(-1)}
                title={path}
                disabled={busy}
                aria-current={active === path ? "page" : undefined}
                onClick={() => {history.remember(query);open(path);}}
              >
                <span>
                  <i className="file-icon" aria-hidden="true">
                    {path.split(".").at(-1)?.slice(0, 1).toUpperCase()}
                  </i>
                  <MatchText text={entryName(path)} term={q}/>
                </span>
                {phone ? (
                  (q || folder === null) &&
                  parentFolder(path) && (
                    <small><MatchText text={parentFolder(path).slice(0,-1)} term={q}/></small>
                  )
                ) : (
                  <small>
                    {dates?.get(path)?.slice(0, 10).replaceAll("-", ".") ||
                      libraryTitle}
                    {sizes?.get(path) !== undefined && `　${formatSize(sizes.get(path)!)}`}
                    {(q || folder === null) && path.includes("/")
                      ? <> · <MatchText text={parentFolder(path).slice(0,-1)} term={q}/></>
                      : ""}
                  </small>
                )}
              </button>
              {entries && <EntryMore name={path} />}
            </div>
          ))}
          {!notes.length && !directories.length && (
            <p className="list-empty">
              {q ? (result?.query !== q ? "正在搜索…" : result.error || "没有匹配的笔记") : "此处还没有笔记"}
            </p>
          )}
        </div>
        <footer>
          总共 {directories.length + notes.length} 项{!phone && listActions}
        </footer></>}
      </section>
    </EntryMenus>
  );
}
function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function EntryMore({ name }: { name: string }) {
  return (
    <button
      type="button"
      className="entry-more"
      aria-haspopup="menu"
      aria-label={(name.split("/").filter(Boolean).at(-1) || name) + " 的操作"}
    >
      •••
    </button>
  );
}
