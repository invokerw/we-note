import { format, convert } from "./formats";
import type { Action, Backend, Entry } from "./backend";
import { changeMap, changeText, fail, nodes, validText } from "./content";
import type { Call } from "./tools";

export type Snapshot = {
  id: string;
  path: string;
  version: string;
  hash: string;
  text?: string;
  remote?: Entry;
  deleted?: boolean;
  conflict?: string;
};
type Result = Record<string, unknown>;
type Receipt = {
  fingerprint: string;
  result: Result;
  error?: { code: string; message: string };
};
type Pending = { action: Action; receipt: string; attempted?: boolean };
export type State = {
  docs: Snapshot[];
  queue: Pending[];
  receipts: Record<string, Receipt>;
};
export const empty = (): State => ({ docs: [], queue: [], receipts: {} });
function portable(path: string) {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  if (
    bytes(path) > 2048 ||
    /[\\:*?"<>|\u0000-\u001f\u007f]/.test(path) ||
    path
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          bytes(s) > 255 ||
          /[. ]$/.test(s) ||
          /^(?:\.git|\.wenote)$/i.test(s) ||
          /^(?:con|aux|prn|nul|conin\$|conout\$|lpt[1-9]|com[1-9])(?:\.|$)/i.test(
            s,
          ),
      )
  )
    fail("INVALID_PATH", "请选择可移植的相对路径");
  return path.normalize("NFC");
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  return value;
}
export async function digest(text: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return (
    "sha256:" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}
function paginate<T>(items: T[], limit: number, key: string, cursor?: string) {
  let offset = 0;
  if (cursor) {
    try {
      const [scope, at] = JSON.parse(cursor);
      if (scope !== key || !Number.isSafeInteger(at) || at < 0) throw Error();
      offset = at;
    } catch {
      fail("INVALID_CURSOR", "请重新查询");
    }
  }
  return {
    items: items.slice(offset, offset + limit),
    next_cursor:
      offset + limit < items.length
        ? JSON.stringify([key, offset + limit])
        : undefined,
  };
}
const offline = (err: unknown) =>
  !(err as { status?: number; code?: string })?.status &&
  !(err as { code?: string })?.code &&
  (err instanceof TypeError || !navigator.onLine);
export interface Context {
  scope: string;
  vault: string;
  backend: Backend;

  active(): boolean;
  dirty(path: string): Promise<boolean>;
  changed(path: string, previous?: string, deleted?: boolean): void;
}
export interface Journal {
  load(): Promise<State>;
  save(s: State): Promise<void>;
  lock<T>(fn: () => Promise<T>): Promise<T>;
}
export class Library {
  context: Context;
  journal: Journal;
  constructor(context: Context, journal: Journal) {
    this.context = context;
    this.journal = journal;
  }
  check() {
    if (!this.context.active())
      fail("ACCESS_DENIED", "连接已关闭或笔记库已切换");
  }
  async flush(state: State, fresh?: { key: string; previous?: Snapshot }) {
    const { backend } = this.context;
    const blocked = new Set<string>();
    for (const item of [...state.queue]) {
      this.check();
      const a = item.action,
        doc = state.docs.find((d) => d.id === a.id)!;
      if (blocked.has(doc.id) || doc.conflict) continue;
      if (format(a.path)?.key !== a.formatKey) {
        doc.conflict = "处理文件的插件已禁用或更换版本";
        state.receipts[item.receipt].result.sync_status = "conflict";
        await this.journal.save(state);
        continue;
      }
      if (
        (await this.context.dirty(a.from)) ||
        (await this.context.dirty(a.path))
      ) {
        blocked.add(doc.id);
        continue;
      }
      let remote: Entry & { revision?: number };
      const recovering = backend.native && item.attempted;
      if (backend.native && !item.attempted) {
        item.attempted = true;
        await this.journal.save(state);
      }
      this.check();
      try {
        // The notebook write may have finished just before the WebView closed.
        let saved: Entry | undefined;
        if (recovering) {
          const files = await backend.list();
          const target = files.find((f) => f.path === a.path);
          if (a.type === "delete" && !target) saved = doc.remote;
          if (
            a.type !== "delete" &&
            target?.hash === a.hash &&
            (a.type !== "move" || !files.some((f) => f.path === a.from))
          )
            saved = target;
        }
        remote = saved ?? (await backend.apply(a, doc.remote));
      } catch (err) {
        const status = (err as { status?: number })?.status ?? 0;
        if (
          !backend.native &&
          (offline(err) || status === 429 || status >= 500)
        )
          break;
        // A busy notebook, an unavailable server, or a transient transport failure can be retried.
        if (backend.native && /正在同步/.test(String(err))) break;
        // The remote may have committed before the reply was lost. A later flush uses the same key.
        if (!backend.native && !(err as { code?: string }).code) throw err;
        const problem = {
          code: (err as { code?: string }).code ?? "FILE_VERSION_CONFLICT",
          message: String(err),
        };
        if (fresh?.key === item.receipt) {
          state.queue.splice(state.queue.indexOf(item), 1);
          if (fresh.previous)
            state.docs.splice(state.docs.indexOf(doc), 1, fresh.previous);
          else state.docs.splice(state.docs.indexOf(doc), 1);
          state.receipts[item.receipt].error = problem;
          await this.journal.save(state);
          fail(problem.code, problem.message);
        }
        doc.conflict = problem.message;
        state.receipts[item.receipt].result.sync_status = "conflict";
        await this.journal.save(state);
        blocked.add(doc.id);
        continue;
      }
      doc.remote = remote;
      state.queue.splice(state.queue.indexOf(item), 1);
      const reply = state.receipts[item.receipt].result;
      if (!backend.native)
        Object.assign(reply, {
          sync_status: "synced",
          remote_version_id: remote.version,
          vault_revision: remote.revision,
        });
      await this.journal.save(state);
      this.context.changed(a.path, a.from, a.type === "delete");
    }
  }
  async refresh(state: State) {
    const { backend } = this.context;
    let catalog: Entry[];
    try {
      catalog = await backend.list();
    } catch (err) {
      if (!backend.native && offline(err)) return false;
      throw err;
    }
    const existing = new Map(
      state.docs.filter((d) => d.remote).map((d) => [d.remote!.id, d]),
    );
    const pending = new Set(state.queue.map((item) => item.action.id));
    const live = new Set<string>();
    for (const e of catalog) {
      if (!format(e.path)) continue;
      live.add(e.id);
      const old =
        existing.get(e.id) ??
        (backend.native
          ? state.docs.find((d) => d.path === e.path && !d.deleted)
          : undefined);
      if (old && pending.has(old.id)) continue;
      if (
        old &&
        old.remote?.version === e.version &&
        old.path === e.path &&
        !old.deleted
      ) {
        old.remote = e;
        continue;
      }
      const next: Snapshot = {
        id: old?.id ?? (backend.native ? crypto.randomUUID() : e.id),
        path: e.path,
        version: e.version,
        hash: e.hash,
        remote: e,
      };
      if (old)
        Object.assign(old, next, {
          text: undefined,
          deleted: false,
          conflict: undefined,
        });
      else state.docs.push(next);
    }
    state.docs = state.docs.filter(
      (d) => !d.remote || live.has(d.remote.id) || pending.has(d.id),
    );
    return true;
  }
  async body(doc: Snapshot) {
    if (doc.text === undefined) {
      if (!doc.remote) fail("NOT_CACHED", "本机尚未缓存该文件");
      try {
        doc.text = await this.context.backend.read(doc.remote);
      } catch (err) {
        if (offline(err)) fail("NOT_CACHED", "本机尚未缓存该文件");
        throw err;
      }
    }
    return validText(
      await convert(doc.path, "open", doc.text),
      format(doc.path)?.kind === "mindmap" ? 16 << 20 : 65536,
    );
  }
  async cacheVault() {
    return this.journal.lock(async () => {
      this.check();
      const state = await this.journal.load();
      if (!(await this.refresh(state))) fail("OFFLINE", "请联网后缓存笔记库");
      let count = 0,
        skipped = 0;
      for (const doc of state.docs) {
        this.check();
        if (doc.deleted || !format(doc.path)) continue;
        try {
          await this.body(doc);
          count++;
        } catch (err) {
          if (
            ![
              "NOTE_TOO_LARGE",
              "INVALID_TEXT",
              "INVALID_FORMAT",
              "INVALID_MINDMAP",
            ].includes((err as { code: string }).code)
          )
            throw err;
          skipped++;
        }
      }
      this.check();
      await this.journal.save(state);
      return `已缓存 ${count} 篇，跳过 ${skipped} 篇`;
    });
  }
  async conflicts() {
    this.check();
    const state = await this.journal.load();
    return state.docs
      .filter((d) => d.conflict)
      .map((d) => ({
        id: d.id,
        path: d.path,
        version: d.version,
        text: d.text,
        reason: d.conflict,
      }));
  }
  async acceptStored(id: string, version: string) {
    await this.journal.lock(async () => {
      this.check();
      const s = await this.journal.load();
      const d = s.docs.find((d) => d.id === id);
      if (!d?.conflict || d.version !== version)
        fail("FILE_VERSION_CONFLICT", "请重新加载冲突");
      // Explicitly discard the queued local edits. Keep their receipts to prevent duplicate submissions.
      s.queue = s.queue.filter((item) => item.action.id !== id);
      if (d.remote) {
        d.path = d.remote.path;
        d.hash = d.remote.hash;
        d.version = d.remote.version;
        d.text = undefined;
        d.conflict = undefined;
        d.deleted = false;
      } else s.docs = s.docs.filter((doc) => doc !== d);
      await this.refresh(s);
      this.check();
      await this.journal.save(s);
      this.context.changed(d.path);
    });
  }
  run(call: Call, connection: string, write: boolean): Promise<Result> {
    return this.journal.lock(async () => {
      this.check();
      const state = await this.journal.load();
      const writing = "operation_id" in call.args;
      if (writing && !write) fail("ACCESS_DENIED", "此连接只允许读取");
      const key =
        "operation_id" in call.args
          ? JSON.stringify([connection, call.args.operation_id])
          : "";
      const fingerprint = writing
        ? await digest(JSON.stringify(sorted(call)))
        : "";
      if (key && state.receipts[key]) {
        if (state.receipts[key].fingerprint !== fingerprint)
          fail("IDEMPOTENCY_KEY_REUSED", "操作 ID 已用于其他请求");
        const failure = state.receipts[key].error;
        if (failure) fail(failure.code, failure.message);
        await this.flush(state);
        this.check();
        return state.receipts[key].result;
      }
      if (write) await this.flush(state);
      const online = await this.refresh(state);
      this.check();
      const docs = state.docs.filter((d) => !d.deleted && format(d.path));
      const find = (id: string) =>
        docs.find((d) => d.id === id) ??
        fail("NOT_FOUND", "文件不存在或格式未启用");
      if (call.name === "search_notes") {
        const { query, kind: filter, limit = 20, cursor } = call.args;
        const term = query.toLowerCase();
        const hits = [];
        for (const d of docs) {
          if (filter && format(d.path)?.kind !== filter) continue;
          let match = d.path.toLowerCase().includes(term);
          if (!match && (online || d.text !== undefined)) {
            try {
              const raw = await this.body(d);
              match =
                format(d.path)?.kind === "mindmap"
                  ? nodes(raw).some((n) => n.topic.toLowerCase().includes(term))
                  : raw.toLowerCase().includes(term);
            } catch (err) {
              if (
                ![
                  "INVALID_MINDMAP",
                  "INVALID_FORMAT",
                  "INVALID_TEXT",
                  "NOTE_TOO_LARGE",
                  "NOT_CACHED",
                ].includes((err as { code: string }).code)
              )
                throw err;
            }
          }
          if (match)
            hits.push({
              file_id: d.id,
              path: d.path,
              kind: format(d.path)?.kind,
            });
        }
        hits.sort(
          (a, b) =>
            a.path.localeCompare(b.path) || a.file_id.localeCompare(b.file_id),
        );
        await this.journal.save(state);
        return {
          ...paginate(
            hits,
            limit,
            JSON.stringify([this.context.scope, query, filter]),
            cursor,
          ),
          cached_only: !online,
        };
      }
      if (call.name === "read_note" || call.name === "read_mindmap_nodes") {
        const d = find(call.args.file_id);
        const raw = await this.body(d);
        const model = format(d.path)?.kind;
        const result: Result = {
          file_id: d.id,
          path: d.path,
          version_id: d.version,
          content_hash: d.hash,
          kind: model,
          sync_status:
            d.conflict || d.remote?.conflict
              ? "conflict"
              : state.queue.some((i) => i.action.id === d.id) ||
                  (this.context.backend.native && !d.remote?.confirmedVersion)
                ? "pending"
                : "synced",
          remote_version_id:
            d.remote?.confirmedVersion ??
            (!this.context.backend.native ? d.remote?.version : undefined),
        };
        if (call.name === "read_mindmap_nodes") {
          if (model !== "mindmap")
            fail("UNSUPPORTED_FORMAT", "请选择 .mind.json 文件");
          const { node_id, query = "", limit = 50, cursor } = call.args;
          const all = nodes(raw);
          if (node_id && !all.some((n) => n.node_id === node_id))
            fail("NODE_NOT_FOUND", "节点不存在");
          const rows = all.filter(
            (n) =>
              (!node_id ||
                n.node_id === node_id ||
                n.ancestors.includes(node_id)) &&
              [n.topic, n.note, ...n.tags].some((t) =>
                t.toLowerCase().includes(query.toLowerCase()),
              ),
          );
          const page = paginate(
            rows,
            limit,
            JSON.stringify([d.id, d.version, node_id, query]),
            cursor,
          );
          Object.assign(result, {
            nodes: page.items,
            next_cursor: page.next_cursor,
          });
        } else if (model === "mindmap") {
          const rows = nodes(raw);
          Object.assign(result, {
            root_node_id: rows[0].node_id,
            root_topic: rows[0].topic,
            node_count: rows.length,
          });
        } else result.text = raw;
        await this.journal.save(state);
        this.check();
        return result;
      }
      const create = call.name === "create_note";
      const doc = create ? undefined : find(call.args.file_id);
      const dest = portable(
        call.name === "create_note"
          ? call.args.path
          : call.name === "move_note"
            ? call.args.new_path
            : doc!.path,
      );
      const formatInfo = format(dest);
      const model = formatInfo?.kind;
      if (
        !model ||
        !formatInfo ||
        (doc && format(doc.path)?.key !== formatInfo.key) ||
        model !== (create ? call.args.kind : format(doc!.path)?.kind)
      )
        fail("UNSUPPORTED_FORMAT", "文件扩展名或处理器不匹配");
      if (
        doc &&
        "base_path" in call.args &&
        (doc.path !== call.args.base_path ||
          doc.version !== call.args.base_version_id ||
          doc.conflict ||
          doc.remote?.conflict)
      )
        fail("FILE_VERSION_CONFLICT", "请先处理冲突并重新读取");
      if (
        (await this.context.dirty(doc?.path ?? dest)) ||
        (await this.context.dirty(dest))
      )
        fail("EDITOR_DIRTY", "请先保存未提交的编辑");
      const folded = dest.toLowerCase();
      if (
        (create || call.name === "move_note") &&
        state.docs.some((d) => {
          const path = d.path.toLowerCase();
          return (
            !d.deleted &&
            d !== doc &&
            (path === folded ||
              path.startsWith(folded + "/") ||
              folded.startsWith(path + "/"))
          );
        })
      )
        fail("PATH_CONFLICT", "目标路径已存在");
      let text: string | undefined;
      const extra: Result = {};
      switch (call.name) {
        case "create_note":
          if (model === "mindmap") {
            extra.root_node_id = crypto.randomUUID();
            text = JSON.stringify({
              nodeData: { id: extra.root_node_id, topic: call.args.root_topic },
            });
          } else text = validText(call.args.text!);
          break;
        case "edit_note":
          if (model === "mindmap")
            fail("UNSUPPORTED_FORMAT", "导图请使用节点工具");
          text = changeText(await this.body(doc!), call.args.edit);
          break;
        case "edit_mindmap":
          if (model !== "mindmap") fail("UNSUPPORTED_FORMAT", "请选择导图");
          {
            const result = changeMap(
              await this.body(doc!),
              call.args.operations,
            );
            const { text: body, ...detail } = result;
            text = body;
            Object.assign(extra, detail);
          }
          break;
      }
      if (text !== undefined)
        text = validText(await convert(dest, "serialize", text), 16 << 20);
      if (
        dest.toLowerCase().endsWith(".md") &&
        text &&
        Array.from(
          text.matchAll(
            /\/assets\/[\w-]+\/([\w-]+)\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{16,64}\b/g,
          ),
        ).some((m) => m[1] !== this.context.vault)
      )
        fail("CROSS_VAULT_ASSET", "正文包含其他笔记库的图片");
      const hash = text === undefined ? doc!.hash : await digest(text);
      const next: Snapshot = {
        ...doc,
        id: doc?.id ?? crypto.randomUUID(),
        path: dest,
        hash,
        version: crypto.randomUUID(),
        text: text ?? doc?.text,
        deleted: call.name === "delete_note",
      };
      const action: Action = {
        id: next.id,
        formatKey: formatInfo.key,
        key: crypto.randomUUID(),
        type: create
          ? "create"
          : call.name === "move_note"
            ? "move"
            : next.deleted
              ? "delete"
              : "update",
        path: dest,
        from: doc?.path ?? dest,
        text,
        hash,
      };
      const previous = doc ? { ...doc } : undefined;
      if (doc) Object.assign(doc, next);
      else state.docs.push(next);
      const result: Result = {
        file_id: next.id,
        path: dest,
        version_id: next.version,
        content_hash: hash,
        sync_status: "pending",
        ...(next.deleted ? { trashed: true } : {}),
        ...extra,
      };
      state.receipts[key] = { fingerprint, result };
      state.queue.push({ action, receipt: key });
      this.check();
      await this.journal.save(state);
      await this.flush(state, { key, previous });
      this.check();
      return result;
    });
  }
}
