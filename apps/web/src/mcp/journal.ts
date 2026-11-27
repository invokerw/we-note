import { empty, type Journal, type State } from "./library";
let db: Promise<IDBDatabase> | undefined;
function open() {
  return (db ??= new Promise<IDBDatabase>((ok, no) => {
    const r = indexedDB.open("wenote-client-mcp", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("vaults");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => {
      db = undefined;
      no(r.error);
    };
  }));
}
export function journal(scope: string): Journal {
  return {
    async load() {
      const d = await open();
      return new Promise<State>((ok, no) => {
        const r = d.transaction("vaults").objectStore("vaults").get(scope);
        r.onsuccess = () => ok(r.result ?? empty());
        r.onerror = () => no(r.error);
      });
    },
    async save(s) {
      const d = await open();
      await new Promise<void>((ok, no) => {
        const tx = d.transaction("vaults", "readwrite");
        tx.oncomplete = () => ok();
        tx.onabort = () => no(tx.error);
        tx.objectStore("vaults").put(s, scope);
      });
    },
    async lock(fn) {
      if (!navigator.locks)
        throw Error("请使用 HTTPS 或本机安全上下文，以启用跨窗口写入保护");
      return await navigator.locks.request(`wenote:mcp:${scope}`, fn);
    },
  };
}
export function draftLock(scope: string, path: string) {
  return `wenote:mcp:draft:${JSON.stringify([scope, path])}`;
}
