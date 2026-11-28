import type { Call } from "../mcp/tools";
import type { WebSource } from "./webAccess";
export type Proposal = {
  call: Call;
  path: string;
  summary: string;
  grant: string;
  status: "preview" | "sending" | "saved" | "discarded" | "failed";
  receipt?: string;
};
export type Line = {
  id?: string;
  summary?: string;
  feedback?: "like" | "dislike" | "default";
  interrupted?: boolean;
  role: "user" | "assistant" | "tool";
  text: string;
  path?: string;
  proposal?: Proposal;
  sources?: WebSource[];
};
export type Chat = {
  id: string;
  scope: string;
  title: string;
  updated: number;
  rev: number;
  draft: string;
  lines: Line[];
  refs: string[];
  all: boolean;
  contextStart: number;
  contextKey?: string;
};
export const newChat = (scope: string, path: string): Chat => ({
  id: crypto.randomUUID(),
  scope,
  title: "新对话",
  updated: Date.now(),
  rev: 0,
  draft: "",
  lines: [],
  refs: path ? [path] : [],
  all: false,
  contextStart: 0,
});
let database: Promise<IDBDatabase> | undefined;
function open() {
  return (database ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("wenote-assistant", 1);
    r.onupgradeneeded = () =>
      r.result
        .createObjectStore("threads", { keyPath: "id" })
        .createIndex("scope", "scope");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
export async function history(scope: string): Promise<Chat[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = db
      .transaction("threads")
      .objectStore("threads")
      .index("scope")
      .getAll(scope);
    r.onsuccess = () =>
      resolve((r.result as Chat[]).sort((a, b) => b.updated - a.updated));
    r.onerror = () => reject(r.error);
  });
}
export async function save(chat: Chat) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("threads", "readwrite"),
      store = tx.objectStore("threads"),
      r = store.get(chat.id);
    r.onsuccess = () => {
      if ((r.result?.rev ?? 0) !== chat.rev - 1) {
        tx.abort();
        return;
      }
      store.put(chat);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? Error("会话在其他窗口已更新，请刷新以读取最新记录"));
  });
}
export async function clearHistory(scope: string) {
  const db = await open();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("threads", "readwrite"),
      store = tx.objectStore("threads");
    const cursor = store.index("scope").openCursor(scope);
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (row) {
        row.delete();
        row.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
