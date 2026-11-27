import { useEffect, useLayoutEffect, useRef, useState } from "react";

type Draft = {
  id: string;
  scope: string;
  base: string;
  text: string;
  updated: number;
};
let database: Promise<IDBDatabase> | undefined;
function openDrafts() {
  if (!database)
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("wenote-note-drafts", 1);
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore("drafts", { keyPath: "id" })
          .createIndex("scope", "scope");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        database = undefined;
        reject(request.error);
      };
    });
  return database;
}
async function load(scope: string): Promise<Draft[]> {
  const db = await openDrafts();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction("drafts")
      .objectStore("drafts")
      .index("scope")
      .getAll(scope);
    req.onsuccess = () =>
      resolve((req.result as Draft[]).sort((a, b) => b.updated - a.updated));
    req.onerror = () => reject(req.error);
  });
}
async function update(apply: (store: IDBObjectStore) => void) {
  const db = await openDrafts();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    apply(tx.objectStore("drafts"));
  });
}
export function useNoteDraft(
  scope: string,
  base: string,
  report: (s: string) => void,
) {
  const [id] = useState(() =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
      n.toString(16).padStart(8, "0"),
    ).join(""),
  );
  const [pending, setPending] = useState<Draft[]>([]);
  const notice = useRef(report);
  notice.current = report;
  const error = (e: unknown) =>
    notice.current(`本机草稿存储失败，请手动保存。${String(e)}`);
  // An active editor owns its draft. Other tabs offer recovery only after it closes.
  useEffect(() => {
    if (!navigator.locks) return;
    let release!: () => void;
    const closed = new Promise<void>((resolve) => {
      release = resolve;
    });
    void navigator.locks
      .request(`wenote-draft:${id}`, () => closed)
      .catch(error);
    return release;
  }, [id]);
  useEffect(() => {
    if (!scope || !base) return;
    let live = true;
    load(scope)
      .then(async (rows) => {
        const locks = await navigator.locks?.query();
        const active = new Set(locks?.held?.map((lock) => lock.name));
        if (live)
          setPending(
            rows.filter(
              (row) => row.id !== id && !active.has(`wenote-draft:${row.id}`),
            ),
          );
      })
      .catch(error);
    return () => {
      live = false;
    };
  }, [scope, !!base, id]);
  function write(text: string | null) {
    if (!scope || !base) return;
    void update((store) => {
      if (text === null) store.delete(id);
      else store.put({ id, scope, base, text, updated: Date.now() });
    }).catch(error);
  }
  async function decide(restore?: (text: string) => void) {
    const draft = pending[0];
    if (!draft) return;
    try {
      await update((store) => {
        if (restore) store.put({ ...draft, id, base, updated: Date.now() });
        // Another open tab can still be editing its own draft.
        const read = store.get(draft.id);
        read.onsuccess = () => {
          if (
            read.result?.text === draft.text &&
            read.result?.base === draft.base
          )
            store.delete(draft.id);
        };
      });
      restore?.(draft.text);
      setPending((rows) =>
        restore ? [] : rows.filter((row) => row.id !== draft.id),
      );
    } catch (e) {
      error(e);
    }
  }
  return { pending: pending[0], write, decide };
}
export function DraftDialog({
  draft,
  current,
  base,
  restore,
  discard,
}: {
  draft: Draft;
  current: string;
  base: string;
  restore: () => void;
  discard: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="recovery-dialog"
      aria-label="恢复本地草稿"
      onCancel={(e) => e.preventDefault()}
    >
      <h2>恢复本地草稿</h2>
      {draft.base !== base && (
        <p>其他设备已保存新版本。请核对两份正文后再恢复。</p>
      )}
      <div className="recovery-columns">
        <section>
          <h3>已保存版本</h3>
          <pre>{current}</pre>
        </section>
        <section>
          <h3>本地草稿</h3>
          <pre>{draft.text}</pre>
        </section>
      </div>
      <footer>
        <button onClick={discard}>放弃这份草稿</button>
        <button onClick={restore}>恢复到编辑器</button>
      </footer>
    </dialog>
  );
}
