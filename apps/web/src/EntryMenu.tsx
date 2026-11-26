import type { NoteStars } from "./StarredNotes";
import { PhoneSheet } from "./PhoneUI";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  entryName,
  isFolder,
  containsEntry,
  type EntryIO,
} from "./libraryEntries";
import { EntryDialog, type EntryCommand } from "./EntryDialog";

type Menu = {
  path: string;
  x: number;
  y: number;
  trigger: HTMLElement;
  background: boolean;
};
const creationItems = [
  "Markdown",
  "思维导图",
  "上传文件",
  "上传文件夹",
] as const;
function MenuPanel({
  label,
  anchor,
  child,
  onKeyDown,
  children,
}: {
  label: string;
  anchor: { x: number; y: number; left?: number };
  child?: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    const clamp = (v: number, max: number) => Math.max(4, Math.min(v, max - 4));
    const x =
      child && anchor.x + width > innerWidth
        ? (anchor.left ?? anchor.x) - width
        : anchor.x;
    el.style.left = clamp(x, innerWidth - width) + "px";
    el.style.top = clamp(anchor.y, innerHeight - height) + "px";
  }, [anchor, child]);
  return (
    <div
      className="entry-menu"
      role="menu"
      aria-label={label}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
export function EntryMenus({
  io,
  stars,
  phone = false,
  paths,
  children,
  onChange,
}: {
  io?: EntryIO;
  stars: NoteStars;
  phone?: boolean;
  paths: string[];
  children: ReactNode;
  onChange: (src: string, dst: string) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null),
    [sub, setSub] = useState<{
      label: string;
      x: number;
      y: number;
      left: number;
    } | null>(null),
    [command, setCommand] = useState<EntryCommand | null>(null);
  const hold = useRef<{ id: number; x: number; y: number } | null>(null),
    suppress = useRef(false),
    returnTo = useRef<HTMLElement | null>(null);
  function cancelHold() {
    if (hold.current) clearTimeout(hold.current.id);
    hold.current = null;
  }
  function close(focus = false) {
    setMenu(null);
    setSub(null);
    if (focus) returnTo.current?.focus({ preventScroll: true });
  }
  function show(row: HTMLElement, x: number, y: number) {
    if (!io) return;
    cancelHold();
    const background = row.hasAttribute("data-library-background");
    const trigger =
      background || row.matches("button")
        ? row
        : row.querySelector<HTMLElement>(".folder-name,.entry")!;
    returnTo.current = trigger;
    setSub(null);
    setMenu({ path: row.dataset.libraryPath!, trigger, x, y, background });
  }
  function rowOf(target: EventTarget | null) {
    return target instanceof Element
      ? target.closest<HTMLElement>("[data-library-path]")
      : null;
  }
  function fromButton(row: HTMLElement, button: Element) {
    const r = button.getBoundingClientRect();
    show(row, r.left, r.bottom);
  }
  useEffect(() => () => cancelHold(), []);
  useEffect(() => {
    if (!menu) return;
    menu.trigger
      .closest("[data-library-path]")
      ?.setAttribute("data-context", "true");
    if (phone)
      return () =>
        menu.trigger
          .closest("[data-library-path]")
          ?.removeAttribute("data-context");
    document
      .querySelector<HTMLButtonElement>(".entry-menu button")
      ?.focus({ preventScroll: true });
    const outside = (e: Event) => {
      if (!(e.target instanceof Element && e.target.closest(".entry-menu")))
        close();
    };
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close(true);
      } else if (e.key === "Tab") close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      menu.trigger
        .closest("[data-library-path]")
        ?.removeAttribute("data-context");
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [menu, phone]);
  function action(label: string) {
    if (!menu || !io) return;
    setCommand({
      label,
      source: menu.path,
      expected: Object.fromEntries(
        Object.entries(io.revisions).filter(([p]) =>
          containsEntry(menu.path, p),
        ),
      ),
    });
    close();
  }
  function branch(label: string, button: HTMLElement) {
    const r = button.getBoundingClientRect();
    setSub({ label, x: r.right + 2, y: r.top - 4, left: r.left - 2 });
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowRight" && buttons[i]?.hasAttribute("aria-haspopup")) {
      branch(buttons[i].textContent!.trim(), buttons[i]);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(".entry-menu:last-child button")
          ?.focus(),
      );
    } else if (e.key === "ArrowLeft" && sub) {
      document
        .querySelector<HTMLButtonElement>('.entry-menu [aria-expanded="true"]')
        ?.focus();
      setSub(null);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      const next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (i + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) %
              buttons.length;
      buttons[next]?.focus();
    } else return;
    e.preventDefault();
  }
  function item(label: string, nested = false) {
    return (
      <button
        key={label}
        role="menuitem"
        aria-label={label}
        aria-haspopup={nested ? "menu" : undefined}
        aria-expanded={nested ? sub?.label === label : undefined}
        onPointerEnter={(e) => {
          if (!phone && e.pointerType === "mouse") {
            if (nested) branch(label, e.currentTarget);
            else if (e.currentTarget.closest('[aria-label="项目操作"]'))
              setSub(null);
          }
        }}
        onClick={(e) =>
          nested ? branch(label, e.currentTarget) : action(label)
        }
      >
        {label}
      </button>
    );
  }
  const starItem = menu && (
    <button role="menuitem" disabled={!stars.ready} onPointerEnter={() => setSub(null)}
      onClick={() => { stars.toggle(menu.path); close(true); }}>
      {stars.has(menu.path) ? "取消加星" : "加星"}
    </button>
  );
  const subItems =
    sub?.label === "新建"
      ? [...creationItems]
      : ["项目信息", ...(menu?.path ? ["复制路径"] : [])];
  return (
    <div
      className="entry-events"
      onContextMenu={(e) => {
        const row = rowOf(e.target);
        if (!io || !row) return;
        e.preventDefault();
        if (hold.current) suppress.current = true;
        show(row, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        const row = rowOf(e.target);
        if (
          row &&
          io &&
          (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        ) {
          e.preventDefault();
          fromButton(row, e.target as Element);
        }
      }}
      onPointerDown={(e) => {
        suppress.current = false;
        cancelHold();
        const row = rowOf(e.target);
        if (!io || !row || e.pointerType === "mouse" || e.button !== 0) return;
        const { clientX: x, clientY: y } = e;
        hold.current = {
          x,
          y,
          id: window.setTimeout(() => {
            suppress.current = true;
            show(row, x, y);
          }, 520),
        };
      }}
      onPointerMove={(e) => {
        if (
          hold.current &&
          Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 8
        )
          cancelHold();
      }}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onClickCapture={(e) => {
        // Android may retarget the release click to a newly opened sheet.
        if (suppress.current && (phone || rowOf(e.target)) && e.detail !== 0) {
          suppress.current = false;
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        const el = e.target as Element;
        const row = rowOf(el);
        if (row && el.closest(".entry-more")) {
          e.stopPropagation();
          fromButton(row, el.closest("button")!);
        }
      }}
    >
      {children}
      {menu && phone && (
        <PhoneSheet
          title={sub?.label || entryName(menu.path)}
          close={() => close(true)}
          back={
            sub
              ? () => setSub(null)
              : undefined
          }
        >
          <div
            className={
              sub?.label === "新建"
                ? "phone-choices creation-grid"
                : "phone-choices"
            }
            role="menu"
            aria-label={sub?.label || "项目操作"}
          >
            {sub ? (
              subItems.map((label) => item(label))
            ) : (
              <>
                {item("新建", true)}
                {menu.path && !menu.background && (
                  <>
                    {item("重命名")}
                    {item("移动到")}
                    {item("复制")}
                    {!isFolder(menu.path) && (
                      <>
                        {starItem}
                        {item("下载")}
                        {item("导出为PDF")}
                      </>
                    )}
                  </>
                )}
                {item("更多", true)}
                {menu.path && !menu.background && item("删除")}
              </>
            )}
          </div>
        </PhoneSheet>
      )}
      {menu &&
        !phone &&
        createPortal(
          <>
            <MenuPanel label="项目操作" anchor={menu} onKeyDown={key}>
              {item("新建", true)}
              {menu.path && !menu.background && (
                <>
                  <hr />
                  {item("删除")}
                  {item("重命名")}
                  {item("移动到")}
                  {item("复制")}
                  {!isFolder(menu.path) && (
                    <>
                      <hr />
                      {starItem}
                      {item("下载")}
                      {item("导出为PDF")}
                    </>
                  )}
                </>
              )}
              <hr />
              {item("更多", true)}
            </MenuPanel>
            {sub && (
              <MenuPanel label={sub.label} anchor={sub} child onKeyDown={key}>
                {subItems.map((label) => item(label))}
              </MenuPanel>
            )}
          </>,
          menu.trigger.closest("dialog[open]") || document.body,
        )}
      {command && io && (
        <EntryDialog
          command={command}
          io={io}
          paths={paths}
          onChange={onChange}
          close={() => {
            setCommand(null);
            returnTo.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
