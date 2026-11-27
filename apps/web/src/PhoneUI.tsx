import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const handsetQuery =
  "(max-width: 720px), (max-width: 960px) and (max-height: 540px)";
export function useAndroidPhone(android: boolean) {
  const [compact, setCompact] = useState(
    () => matchMedia(handsetQuery).matches,
  );
  useEffect(() => {
    if (!android) return;
    const m = matchMedia(handsetQuery);
    const update = () => setCompact(m.matches);
    update();
    m.addEventListener("change", update);
    return () => m.removeEventListener("change", update);
  }, [android]);
  return android && compact;
}
export function useAndroidBack(enabled: boolean, back: () => void) {
  const latest = useRef(back);
  latest.current = back;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const listener = window.__TAURI__.app.onBackButtonPress(() => {
      if (!active) return;
      if (!window.dispatchEvent(new Event('wenote-assistant-back', {cancelable: true}))) return;
      const modal = Array.from(
        document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
      ).at(-1);
      if (modal) {
        modal.dispatchEvent(new Event("cancel", { cancelable: true }));
        return;
      }
      latest.current();
    });
    return () => {
      active = false;
      void listener.then((l) => l.unregister());
    };
  }, [enabled]);
}
const icons = {
  share: "M12 15V3 M8 7l4-4 4 4 M6 10H4v11h16V10h-2",
  notes: "M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4",
  folder: "M3 7V5h6l2 2h10v12H3z",
  new: "M12 5v14 M5 12h14",
  back: "m14 5-7 7 7 7",
  trash: "M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  more: "M5 12h.1 M12 12h.1 M19 12h.1",
  sort: "M4 7h16 M4 12h11 M4 17h6",
};
export function PhoneIcon({ name }: { name: keyof typeof icons }) {
  return (
    <svg
      aria-hidden="true"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.5 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={icons[name]} />
    </svg>
  );
}
export function PhoneSheet({
  title,
  children,
  close,
  back,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  back?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null),
    id = useId();
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  return createPortal(
    <dialog
      ref={dialog}
      className="phone-sheet"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        (back || close)();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientY < r.top || e.clientX < r.left || e.clientX > r.right)
            close();
        }
      }}
    >
      <header>
        {back && (
          <button aria-label="返回上级菜单" onClick={back}>
            <PhoneIcon name="back" />
          </button>
        )}
        <h2 tabIndex={-1} ref={heading} id={id}>
          {title}
        </h2>
      </header>
      {children}
      <button className="sheet-cancel" onClick={close}>
        取消
      </button>
    </dialog>,
    document.body,
  );
}
