import { useEffect, useMemo, useReducer } from "react";

export type NoteStars = {
  ready: boolean;
  has: (path: string) => boolean;
  toggle: (path: string) => void;
};

export function useNoteStars(
  scope: string | undefined,
  identify: (path: string) => string | undefined,
  notify: (message: string) => void,
) {
  // A separate key per note lets different windows update distinct notes independently.
  const prefix = scope && `wenote-star:${scope}:`;
  const [revision, refresh] = useReducer(n => n + 1, 0);
  const ids = useMemo(() => {
    const result = new Set<string>();
    if (!prefix) return result;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix)) result.add(key.slice(prefix.length));
      }
    } catch {
      // Storage may be blocked. Report this if the user tries to mark a note.
    }
    return result;
  }, [prefix, revision]);
  useEffect(() => {
    function changed(event: StorageEvent) {
      if (prefix && (!event.key || event.key.startsWith(prefix))) refresh();
    }
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [prefix]);

  function toggle(path: string) {
    const id = identify(path);
    if (!prefix || !id) return;
    try {
      if (ids.has(id)) localStorage.removeItem(prefix + id);
      else localStorage.setItem(prefix + id, "1");
      refresh();
    } catch {
      notify("无法保存加星状态，请检查本地存储是否可用。");
    }
  }

  // Native notebooks identify local files by path, including files first created offline.
  function changePaths(source: string, destination?: string) {
    if (!prefix) return;
    try {
      for (const id of ids) {
        if (id !== source && !(source.endsWith("/") && id.startsWith(source))) continue;
        if (destination) localStorage.setItem(prefix + destination + id.slice(source.length), "1");
        localStorage.removeItem(prefix + id);
      }
    } catch {
      notify("文件操作已完成，但无法更新本地加星记录。");
    }
    refresh();
  }
  return { ready: !!prefix, has: (path: string) => ids.has(identify(path) ?? ""), toggle, changePaths };
}

export function StarButton({ stars, path }: { stars: NoteStars; path: string }) {
  const marked = stars.has(path);
  const label = marked ? "取消加星" : "加星";
  return (
    <button type="button" className="note-star" aria-label={label} title={label}
      aria-pressed={marked} disabled={!stars.ready}
      onMouseDown={event => event.preventDefault()} onClick={() => stars.toggle(path)}>
      <span aria-hidden="true">{marked ? "★" : "☆"}</span>
    </button>
  );
}
