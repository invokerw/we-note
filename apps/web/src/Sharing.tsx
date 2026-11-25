import { download } from "./Resources";
import { MarkdownView } from "./markdown/Markdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { base64, request, type Vault } from "./api";

type Asset = {
  canonical_url: string;
  reference_urls?: string[];
  asset_id: string;
  name: string;
  media_type: string;
  status: string;
};
type Link = {
  id: string;
  title: string;
  expires: number;
  downloads: number;
  max_downloads: number;
  revoked: boolean;
  password_required: boolean;
  allow_download: boolean;
  allow_import: boolean;
};
function useAction() {
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(f: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await f();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return { message, setMessage, busy, run };
}
function prepareLink(token: string, options: Record<string, unknown>) {
  const key = crypto.randomUUID();
  const secret = base64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(secret),
    );
    const token_hash = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const link = await (
      await request(
        token,
        "/api/v1/share-links",
        "POST",
        { ...options, token_hash },
        { "Idempotency-Key": key },
      )
    ).json();
    return `${location.origin}/#share=${link.id}.${secret}`;
  };
}

export function prepareNoteLink(token: string, vault: string, path: string) {
  return prepareLink(token, {
    vault_id: vault,
    paths: [path],
    allow_import: true,
    allow_download: true,
    expires: Math.floor(Date.now() / 1000) + 7 * 86400,
  });
}

export function Sharing({ token, vault, manage = false }: { token: string; vault: string; manage?: boolean }) {
  const [links, setLinks] = useState<Link[]>([]),
    [url, setUrl] = useState("");
  const { message, setMessage, busy, run } = useAction();
  const endpoint = "/api/v1/share-links";
  const pending = useRef<{
    form: string;
    create: () => Promise<string>;
  } | null>(null);
  async function refresh() {
    setLinks(
      await (
        await request(
          token,
          endpoint + "?vault_id=" + encodeURIComponent(vault),
        )
      ).json(),
    );
  }
  useEffect(() => {
    void run(async () => {
      if (manage) await refresh();
    });
  }, [token, vault, manage]);
  return (
    <article className="security-panel">
      {!manage && <><h1>批量分享</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void run(async () => {
            const selection = {
              vault_id: vault,
              paths: String(form.get("paths"))
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
            };
            const options = {
              ...selection,
              expires: Math.floor(
                new Date(String(form.get("expires"))).getTime() / 1000,
              ),
              password: form.get("password"),
              max_downloads: Number(form.get("max")),
              allow_download: form.has("download"),
              allow_import: form.has("import"),
            };
            const fields = JSON.stringify(options);
            if (pending.current?.form !== fields) {
              pending.current = {
                form: fields,
                create: prepareLink(token, options),
              };
            }
            setUrl(await pending.current.create());
            pending.current = null;
          });
        }}
      >
        <fieldset disabled={busy}>
          <label>
            文件或目录，每行一个
            <textarea name="paths" rows={3} placeholder="项目/会议记录" />
          </label>
              <label>
                分享密码（可选）
                <input
                  name="password"
                  type="password"
                  maxLength={512}
                  autoComplete="new-password"
                />
              </label>
              <label>
                有效期至
                <input
                  type="datetime-local"
                  required
                  name="expires"
                  defaultValue={new Date(
                    Date.now() +
                      7 * 86400000 -
                      new Date().getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)}
                />
              </label>
              <label>
                下载和导入次数上限（0 为不限）
                <input
                  type="number"
                  name="max"
                  min="0"
                  defaultValue="0"
                  required
                />
              </label>
              <label>
                <input type="checkbox" name="download" defaultChecked />
                允许下载 ZIP
              </label>
              <label>
                <input type="checkbox" name="import" />
                允许导入笔记库
              </label>
          <button>生成分享链接</button>
        </fieldset>
      </form>
      {url && (
        <label>
          复制分享地址
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
        </label>
      )}
      </>}
      <p role="status">{message}</p>
      {manage && <><h4>已创建的链接</h4>{!busy && !message && !links.length && <p>暂无分享链接</p>}
      {links.map((l) => (
        <section key={l.id} className="share">
          <strong>{l.title}</strong><p>{new Date(l.expires * 1000).toLocaleString()} 到期</p>
          <p>
            {l.password_required ? "有密码 · " : ""}已用 {l.downloads} /{" "}
            {l.max_downloads || "不限"} 次 ·{" "}
            {l.revoked
              ? "已撤销"
              : l.expires * 1000 <= Date.now()
                ? "已过期"
                : l.max_downloads && l.downloads >= l.max_downloads
                  ? "次数已用完"
                  : "有效"}
          </p>
          {!l.revoked && (
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  if (!confirm(`撤销「${l.title}」的分享链接？已保存的副本可继续使用。`)) return;
                  await request(token, endpoint + "/" + l.id, "DELETE");
                  if (url.includes(l.id)) setUrl("");
                  await refresh();
                })
              }
            >
              撤销链接
            </button>
          )}
        </section>
      ))}</>}
    </article>
  );
}

type EventRow = {
  id: number;
  action: string;
  object_id: string;
  created_at: string;
};
export function Audit({ token }: { token: string }) {
  const [rows, setRows] = useState<EventRow[]>([]),
    [more, setMore] = useState(false);
  const { message, busy, run } = useAction();
  async function load(before = 0) {
    const data: EventRow[] = await (
      await request(
        token,
        "/api/v1/audit" + (before ? "?before=" + before : ""),
      )
    ).json();
    setMore(data.length === 100);
    setRows((prev) => (before ? [...prev, ...data] : data));
  }
  useEffect(() => {
    void run(() => load());
  }, [token]);
  return (
    <article className="security-panel">
      <h1>账户审计日志</h1>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>操作</th>
            <th>对象</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.created_at).toLocaleString()}</td>
              <td>{e.action}</td>
              <td>{e.object_id}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {more && (
        <button
          disabled={busy}
          onClick={() => run(() => load(rows.at(-1)!.id))}
        >
          更早记录
        </button>
      )}
      <p role="status">{message}</p>
    </article>
  );
}

export function readShareLocation() {
  const hash = location.hash.match(
    /^#share=(link_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/,
  );
  if (hash) {
    history.replaceState(null, "", "/?share=" + hash[1]);
    return { id: hash[1], secret: hash[2] };
  }
  const id = new URLSearchParams(location.search).get("share");
  return id && /^link_[0-9a-f]{32}$/.test(id) ? { id, secret: "" } : null;
}
type Manifest = {
  files: { path: string; version_id: string }[];
  assets: Asset[];
  allow_import: boolean;
  allow_download: boolean;
};
export function PublicShare({
  entry,
  token,
  login,
}: {
  entry: { id: string; secret: string };
  token: string;
  login: ReactNode;
}) {
  const [snap, setSnap] = useState<Manifest>();
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ version: string; text: string }>();
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedURL, setSavedURL] = useState("");
  const [vaults, setVaults] = useState<Vault[]>();
  const { message, setMessage, busy, run } = useAction();
  const path = "/s/" + entry.id + "/";
  const file =
    snap?.files.find((f) => f.version_id === selected) || snap?.files[0];
  const version = file?.version_id;
  const canPreview = file && /\.(md|txt|json)$/i.test(file.path);

  function report(error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === "NOT_FOUND" || code === "SHARE_SESSION_REQUIRED") {
      setSnap(undefined);
      setMessage(
        code === "NOT_FOUND"
          ? "分享链接已失效"
          : "请使用发送者提供的完整链接打开分享。",
      );
    } else setMessage(String(error));
  }
  async function refresh() {
    setSnap(await (await request("", path + "snapshot")).json());
  }
  async function unlock(pass: string) {
    if (entry.secret) {
      try {
        await request("", path + "session", "POST", {
          token: entry.secret,
          password: pass,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "PASSWORD_REQUIRED") {
          setLocked(true);
          if (pass) setMessage("请输入正确的分享密码");
          return;
        }
        throw error;
      }
    }
    setLocked(false);
    setPassword("");
    await refresh();
  }
  useEffect(() => {
    void run(() => unlock("").catch(report));
  }, [entry.id, entry.secret]);
  useEffect(() => {
    if (!snap) return;
    const check = () => {
      if (!document.hidden) refresh().catch(report);
    };
    const timer = setInterval(check, 15000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [!!snap]);
  useEffect(() => {
    if (!version || !canPreview) return;
    let live = true;
    request("", path + "files/" + version)
      .then((r) => r.json())
      .then((data) => {
        if (live) setPreview({ version, text: data.text });
      })
      .catch((error) => {
        if (live) report(error);
      });
    return () => {
      live = false;
    };
  }, [version, canPreview, path]);
  useEffect(() => {
    if (!token || !saving || !snap?.allow_import) return;
    let live = true;
    request(token, "/api/v1/vaults")
      .then((r) => r.json())
      .then((data) => {
        if (live) setVaults(data.vaults);
      })
      .catch((error) => {
        if (live) setMessage(String(error));
      });
    return () => {
      live = false;
    };
  }, [token, saving, snap?.allow_import]);
  async function save(fields: FormData) {
    let vault = String(fields.get("vault") || "");
    if (!vault) {
      const created: Vault = await (
        await request(token, "/api/v1/vaults", "POST", {
          name: String(fields.get("name")).trim(),
        })
      ).json();
      setVaults([created]);
      vault = created.id;
    }
    const { files } = await (
      await request(token, path + "import", "POST", {
        vault_id: vault,
        folder: fields.get("folder"),
      })
    ).json();
    if (files[0])
      setSavedURL(
        "/?" + new URLSearchParams({ vault, note: files[0].file_id }),
      );
    setSaving(false);
    setMessage("已保存到我的笔记");
  }
  const attachments = useRef<HTMLDetailsElement>(null);
  const assetFor = (url: string) =>
    snap?.assets.find(
      (a) => a.canonical_url === url || a.reference_urls?.includes(url),
    );
  return (
    <main className="public-share security-panel">
      <h1>{file?.path.split("/").at(-1) || "分享笔记"}</h1>
      {locked && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => unlock(password).catch(report));
          }}
        >
          <label>
            分享密码
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button disabled={busy}>打开分享</button>
        </form>
      )}
      {snap && (
        <>
          {snap.files.length > 1 && (
            <label>
              分享中的文件
              <select
                value={version}
                onChange={(e) => setSelected(e.target.value)}
              >
                {snap.files.map((f) => (
                  <option key={f.version_id} value={f.version_id}>
                    {f.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="share-actions">
            {snap.allow_import && !saving && !savedURL && (
              <button className="primary" onClick={() => setSaving(true)}>
                保存到我的笔记
              </button>
            )}
            {snap.allow_download && file && (
              <button
                disabled={busy}
                onClick={() =>
                  run(() =>
                    download(
                      "",
                      path + "files/" + file.version_id + "/download",
                      file.path.split("/").at(-1)!,
                      "POST",
                    ).catch(report),
                  )
                }
              >
                下载源文件
              </button>
            )}
            {snap.allow_download && snap.files.length !== 1 && (
              <form method="post" action={path + "download"}>
                <button>下载快照 ZIP</button>
              </form>
            )}
          </div>
          {saving &&
            snap.allow_import &&
            (!token
              ? login
              : vaults && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fields = new FormData(e.currentTarget);
                      void run(() => save(fields));
                    }}
                  >
                    {vaults.length ? (
                      <label>
                        目标笔记库
                        <select name="vault" required>
                          {vaults.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label>
                        新建笔记库
                        <input name="name" required defaultValue="我的笔记" />
                      </label>
                    )}
                    <label>
                      目标目录
                      <input name="folder" placeholder="笔记库根目录" />
                    </label>
                    <button disabled={busy}>确认保存</button>
                  </form>
                ))}
          {file && !canPreview && <p>此格式暂不支持在线预览。</p>}
          {file &&
            preview?.version === file.version_id &&
            (/\.md$/i.test(file.path) ? (
              <MarkdownView
                text={preview.text}
                io={{
                  image: (url, alt) => {
                    const asset = assetFor(url);
                    return asset ? (
                      <img src={path + "assets/" + asset.asset_id} alt={alt} />
                    ) : (
                      <span>{alt}</span>
                    );
                  },
                  link: (href) => {
                    const asset = assetFor(href);
                    if (asset) {
                      if (attachments.current) attachments.current.open = true;
                      document.getElementById(asset.asset_id)?.scrollIntoView();
                      return true;
                    }
                    return !/^https?:\/\//.test(href);
                  },
                }}
              />
            ) : (
              <pre>{preview.text}</pre>
            ))}
          {snap.assets.length > 0 && (
            <details ref={attachments}>
              <summary>随笔记分享的文件（{snap.assets.length}）</summary>
              {snap.assets.map((a) => (
                <figure key={a.asset_id} id={a.asset_id}>
                  <figcaption>{a.name}</figcaption>
                  {[
                    "image/png",
                    "image/jpeg",
                    "image/gif",
                    "image/webp",
                  ].includes(a.media_type) && (
                    <img
                      loading="lazy"
                      src={path + "assets/" + a.asset_id}
                      alt={a.name}
                    />
                  )}
                </figure>
              ))}
              {snap.allow_download && snap.files.length === 1 && (
                <form method="post" action={path + "download"}>
                  <button>下载快照 ZIP</button>
                </form>
              )}
            </details>
          )}
        </>
      )}
      <p role="status">{message || (busy && !snap ? "正在打开分享…" : "")}</p>
      {savedURL && (
        <p>
          <a href={savedURL}>打开已保存的笔记</a>
        </p>
      )}
      <a href="/">我的笔记库</a>
    </main>
  );
}
