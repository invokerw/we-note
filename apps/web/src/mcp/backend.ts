import { base64, request, type Note } from "../api";
import { fail } from "./content";

export type Entry = {
  id: string;
  path: string;
  version: string;
  hash: string;
  confirmedVersion?: string;
  conflict?: boolean;
};
export type Action = {
  formatKey: string;
  key: string;
  type: "create" | "update" | "move" | "delete";
  id: string;
  path: string;
  from: string;
  text?: string;
  hash: string;
};
export interface Backend {
  native: boolean;
  list(): Promise<Entry[]>;
  read(entry: Entry): Promise<string>;
  apply(action: Action, base?: Entry): Promise<Entry & { revision?: number }>;
}
export function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return fail("INVALID_TEXT", "正文使用不支持的编码");
  }
}
export function webBackend(token: string, vault: string): Backend {
  const files = `/api/v1/vaults/${encodeURIComponent(vault)}/files`;
  return {
    native: false,
    async list() {
      const data = await (await request(token, files)).json();
      return data.files.map((f: Note) => ({
        id: f.file_id,
        path: f.path,
        version: f.current_version_id,
        hash: f.current_content_hash ?? "",
      }));
    },
    async read(e) {
      const r = await request(
        token,
        `${files}/${encodeURIComponent(e.id)}/content`,
      );
      if (r.headers.get("X-Version-Id") !== e.version)
        fail("FILE_VERSION_CONFLICT", "读取期间版本已改变");
      return decode(new Uint8Array(await r.arrayBuffer()));
    },
    async apply(a, base) {
      const create = a.type === "create";
      const url = create
        ? files
        : `${files}/${encodeURIComponent(base!.id)}${a.type === "update" ? "/content" : ""}`;
      const method = {
        create: "POST",
        update: "PUT",
        move: "PATCH",
        delete: "DELETE",
      }[a.type];
      const args = {
        base_version_id: base?.version,
        base_path: base?.path,
        path: create || a.type === "move" ? a.path : undefined,
        content:
          a.text === undefined
            ? undefined
            : base64(new TextEncoder().encode(a.text)),
      };
      const r = await (
        await request(token, url, method, args, { "Idempotency-Key": a.key })
      ).json();
      return {
        id: r.file_id,
        path: r.path,
        version: r.version_id,
        hash: r.content_hash,
        revision: r.vault_revision,
      };
    },
  };
}
export type LocalCall = <T>(
  action: string,
  args?: Record<string, unknown>,
) => Promise<T>;
export function nativeBackend(call: LocalCall): Backend {
  return {
    native: true,
    async list() {
      return call<Entry[]>("mcp_catalog");
    },
    async read(e) {
      const r = await call<{ hash: string; data: string }>("read_bytes", {
        path: e.path,
      });
      if (r.hash !== e.version) fail("FILE_VERSION_CONFLICT", "笔记已改变");
      return decode(Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
    },
    async apply(a, base) {
      if (a.type === "create" || a.type === "update") {
        const hash = await call<string>("save_bytes", {
          path: a.path,
          base: base?.hash ?? null,
          data: base64(new TextEncoder().encode(a.text!)),
        });
        return { id: base?.id ?? a.path, path: a.path, hash, version: hash };
      }
      await call("change_entry", {
        operation: a.type,
        source: a.from,
        destination: a.type === "move" ? a.path : "",
        expected: { [a.from]: base!.hash },
      });
      return {
        id: a.path,
        path: a.path,
        hash: base!.hash,
        version: base!.hash,
      };
    },
  };
}
