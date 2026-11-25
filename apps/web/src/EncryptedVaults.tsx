import { useEffect, useRef, useState } from "react";
import { base64 } from "./api";
import { fromBase64, browserExport, type ExportFile } from "./plugins/archive";

type Entry = { path: string; body: string; binary: boolean };
type Contents = { name: string; files: Entry[] };
type Header = { id: string; revision: number; updated_at: string };
type Envelope = Header & { iv: string; ciphertext: string };
type Payload = { base_revision: number; iv: string; ciphertext: string };
export type EncryptedIO = (id?: string, payload?: Payload) => Promise<any>;
const utf8 = new TextEncoder();
const shortIDAlphabet = "0123456789abcdefghjkmnpqrstvwxyz";
function newVaultID() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => shortIDAlphabet[b & 31]).join("");
}
async function seal(
  contents: Contents,
  key: CryptoKey,
  id: string,
  revision: number,
): Promise<Payload> {
  const bytes = utf8.encode(JSON.stringify(contents));
  if (bytes.byteLength + 16 > 16 << 20) throw Error("整库密文超过 16 MiB");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    parameters(id, revision + 1, iv),
    key,
    bytes,
  );
  return {
    base_revision: revision,
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(sealed)),
  };
}
function parameters(id: string, revision: number, iv: Uint8Array<ArrayBuffer>) {
  return {
    name: "AES-GCM",
    iv,
    additionalData: utf8.encode(`wenote-encrypted-v1/${id}/${revision}`),
    tagLength: 128,
  };
}
async function unlock(raw: string) {
  const bytes = fromBase64(raw.trim());
  if (bytes.length !== 32) throw Error("恢复密钥必须为 32 字节");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
function validContents(value: unknown): value is Contents {
  const c = value as Contents;
  return (
    !!c &&
    typeof c.name === "string" &&
    Array.isArray(c.files) &&
    c.files.every(
      (f) =>
        f &&
        typeof f.path === "string" &&
        typeof f.body === "string" &&
        typeof f.binary === "boolean",
    )
  );
}
export default function EncryptedVaults({
  io,
  dirty,
  exportFile = browserExport,
}: {
  io: EncryptedIO;
  dirty?: (changed: boolean) => void;
  exportFile?: ExportFile;
}) {
  const [rows, setRows] = useState<Header[]>([]),
    [id, setId] = useState(""),
    [revision, setRevision] = useState(0),
    [contents, setContents] = useState<Contents>(),
    [index, select] = useState(0),
    [raw, setRaw] = useState(""),
    [recovery, setRecovery] = useState(""),
    [stored, setStored] = useState(false),
    [modified, setModified] = useState(false),
    [message, notify] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<Payload | null>(null);
  const key = useRef<CryptoKey | null>(null);
  async function run(f: () => Promise<void>) {
    setBusy(true);
    notify("");
    try {
      await f();
    } catch (e) {
      notify(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let live = true;
    io()
      .then((items) => {
        if (live) setRows(items);
      })
      .catch((e) => {
        if (live) notify(String(e));
      });
    return () => {
      live = false;
      key.current = null;
    };
  }, [io]);
  useEffect(() => {
    dirty?.(modified);
    const warn = (e: BeforeUnloadEvent) => {
      if (modified) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      dirty?.(false);
      window.removeEventListener("beforeunload", warn);
    };
  }, [modified, dirty]);
  function edit(next: Contents) {
    pending.current = null;
    setContents(next);
    setModified(true);
  }
  function lock() {
    if (modified && !confirm("放弃未保存的加密库编辑？")) return;
    key.current = null;
    pending.current = null;
    setContents(undefined);
    setRaw("");
    setRecovery("");
    setStored(false);
    setModified(false);
    setId("");
    notify("");
  }
  async function create() {
    const secret = base64(crypto.getRandomValues(new Uint8Array(32)));
    key.current = await unlock(secret);
    setRecovery(secret);
    setRaw("");
    setStored(false);
    setId(newVaultID());
    setRevision(0);
    select(0);
    edit({ name: "未命名加密库", files: [] });
  }
  async function open() {
    const k = await unlock(raw);
    const env: Envelope = await io(id);
    let next: unknown;
    try {
      const data = await crypto.subtle.decrypt(
        parameters(id, env.revision, fromBase64(env.iv)),
        k,
        fromBase64(env.ciphertext),
      );
      next = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw Error("解锁失败，请检查恢复密钥和所选笔记库");
    }
    if (!validContents(next)) throw Error("无法读取加密库格式");
    key.current = k;
    setContents(next);
    setRevision(env.revision);
    setRaw("");
    select(0);
    setModified(false);
  }
  async function save() {
    if (!contents || !key.current || (!revision && !stored)) return;
    let candidate = id;
    let head: Header;
    for (let attempt = 1; ; attempt++) {
      pending.current ??= await seal(contents, key.current, candidate, revision);
      try {
        head = await io(candidate, pending.current);
        break;
      } catch (err) {
        const taken =
          err === "VAULT_ID_TAKEN" ||
          (err as { code?: string } | null)?.code === "VAULT_ID_TAKEN";
        if (revision || !taken) throw err;
        candidate = newVaultID();
        setId(candidate);
        pending.current = null;
        if (attempt >= 8) throw Error("暂时无法分配笔记库 ID，请重试");
      }
    }
    pending.current = null;
    setRevision(head.revision);
    setModified(false);
    setRecovery("");
    setRows((old) => [head, ...old.filter((r) => r.id !== head.id)]);
    notify("加密库已保存");
  }
  function add(path: string, body: string, binary: boolean) {
    if (!contents) return;
    if (!path.trim() || contents.files.some((f) => f.path === path))
      throw Error("请使用未占用的文件名");
    select(contents.files.length);
    edit({ ...contents, files: [...contents.files, { path, body, binary }] });
  }
  const file = contents?.files[index];
  return (
    <article className="security-panel">
      <h1>端到端加密笔记库</h1>
      {contents ? (
        <fieldset disabled={busy}>
          <label>
            库名称
            <input
              value={contents.name}
              onChange={(e) => edit({ ...contents, name: e.target.value })}
            />
          </label>
          {recovery && (
            <>
              <label>
                恢复密钥
                <input
                  readOnly
                  value={recovery}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <p>在另一台设备解锁需要这把密钥。请先离线保存。</p>
              <label>
                <input
                  type="checkbox"
                  checked={stored}
                  onChange={(e) => setStored(e.target.checked)}
                />
                我已保存恢复密钥
              </label>
            </>
          )}
          <p>
            版本 {revision} · {modified ? "有未保存的修改" : "已保存"}
          </p>
          <div className="secure-actions">
            <button
              onClick={() => {
                const p = prompt("加密笔记名称", "笔记.md");
                if (p) void run(async () => add(p, "", false));
              }}
            >
              新建加密笔记
            </button>
            <label>
              导入文件
              <input
                type="file"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f)
                    void run(async () => {
                      if (f.size > 16 << 20) throw Error("文件超过加密库容量");
                      const bytes = new Uint8Array(await f.arrayBuffer());
                      if (/\.(md|txt|json)$/i.test(f.name)) {
                        try {
                          const text = new TextDecoder("utf-8", {
                            fatal: true,
                            ignoreBOM: true,
                          }).decode(bytes);
                          add(f.name, text, false);
                          return;
                        } catch (err) {
                          if (!(err instanceof TypeError)) throw err;
                        }
                      }
                      add(f.name, base64(bytes), true);
                    });
                }}
              />
            </label>
          </div>
          {contents.files.length > 0 && (
            <label>
              库内文件
              <select
                value={index}
                onChange={(e) => select(Number(e.target.value))}
              >
                {contents.files.map((f, i) => (
                  <option key={f.path} value={i}>
                    {f.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          {file && (
            <>
              {!file.binary && (
                <label>
                  加密笔记正文
                  <textarea
                    rows={12}
                    value={file.body}
                    onChange={(e) =>
                      edit({
                        ...contents,
                        files: contents.files.map((f, i) =>
                          i === index ? { ...f, body: e.target.value } : f,
                        ),
                      })
                    }
                  />
                </label>
              )}
              <button
                onClick={() =>
                  run(() =>
                    exportFile(
                      file.path.split(/[\\/]/).pop() || "note",
                      file.binary
                        ? fromBase64(file.body)
                        : utf8.encode(file.body),
                    ),
                  )
                }
              >
                导出当前文件明文
              </button>
            </>
          )}
          <button
            disabled={!modified || (!revision && !stored)}
            onClick={() => run(save)}
          >
            加密并保存
          </button>
          <button onClick={lock}>锁定笔记库</button>
        </fieldset>
      ) : (
        <fieldset disabled={busy}>
          <button onClick={() => run(create)}>新建加密笔记库</button>
          {rows.length > 0 && (
            <>
              <label>
                选择加密库
                <select value={id} onChange={(e) => setId(e.target.value)}>
                  <option value="">选择笔记库</option>
                  {rows.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} · v{r.revision}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                恢复密钥
                <input
                  type="password"
                  autoComplete="off"
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                />
              </label>
              <button disabled={!id || !raw} onClick={() => run(open)}>
                解锁笔记库
              </button>
            </>
          )}
        </fieldset>
      )}
      <p role="status">{message}</p>
    </article>
  );
}
