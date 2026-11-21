import { MarkdownView } from "./markdown/Markdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { base64, request, type Share, type Vault } from "./api";

type Asset = {
  canonical_url: string;
  asset_id: string;
  name: string;
  media_type: string;
  status: string;
};
type Link = {
  id: string;
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
export function Sharing({ token, vault }: { token: string; vault: string }) {
  const [assets, setAssets] = useState<Asset[]>([]),
    [links, setLinks] = useState<Link[]>([]),
    [url, setUrl] = useState(""),
    [kind, setKind] = useState("link");
  const { message, setMessage, busy, run } = useAction();
  const endpoint = "/api/v1/share-links";
  const pending = useRef<{ form: string; secret: string; key: string } | null>(
    null,
  );
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
      await refresh();
      setAssets(
        await (await request(token, `/api/v1/vaults/${vault}/assets`)).json(),
      );
    });
  }, [token, vault]);
  return (
    <article className="security-panel">
      <h1>分享管理</h1>
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
              asset_ids: form.getAll("asset"),
            };
            if (kind === "account") {
              await request(token, "/api/v1/shares", "POST", {
                ...selection,
                recipient: form.get("email"),
              });
              setMessage("快照已发送");
              return;
            }
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
                secret: base64(crypto.getRandomValues(new Uint8Array(32)))
                  .replaceAll("+", "-")
                  .replaceAll("/", "_")
                  .replace(/=+$/, ""),
                key: crypto.randomUUID(),
              };
            }
            const { secret, key } = pending.current;
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
                endpoint,
                "POST",
                { ...options, token_hash },
                { "Idempotency-Key": key },
              )
            ).json();
            setUrl(`${location.origin}/#share=${link.id}.${secret}`);
            pending.current = null;
            await refresh();
          });
        }}
      >
        <fieldset disabled={busy}>
          <label>
            分享方式
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setUrl("");
              }}
            >
              <option value="link">分享链接</option>
              <option value="account">账户收件箱</option>
            </select>
          </label>
          <label>
            文件或目录，每行一个
            <textarea name="paths" rows={3} placeholder="项目/会议记录" />
          </label>
          {assets.length > 0 && (
            <fieldset>
              <legend>同时分享附件</legend>
              {assets
                .filter((a) => a.status === "completed")
                .map((a) => (
                  <label key={a.asset_id}>
                    <input type="checkbox" name="asset" value={a.asset_id} />
                    {a.name}
                  </label>
                ))}
            </fieldset>
          )}
          {kind === "account" ? (
            <label>
              接收者邮箱
              <input type="email" required name="email" />
            </label>
          ) : (
            <>
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
            </>
          )}
          <button>
            {kind === "account" ? "发送到收件箱" : "生成分享链接"}
          </button>
        </fieldset>
      </form>
      {url && (
        <label>
          复制分享地址
          <input readOnly value={url} onFocus={(e) => e.target.select()} />
        </label>
      )}
      <p role="status">{message}</p>
      <h2>已创建的链接</h2>
      {links.map((l) => (
        <section key={l.id} className="share">
          <strong>{new Date(l.expires * 1000).toLocaleString()} 到期</strong>
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
      ))}
    </article>
  );
}

type State = {
  file_id: string;
  source_file_id: string;
  source_path: string;
  path: string;
  base_source_version: string;
  base_local_version: string;
  local_version: string;
  source_version: string;
  local_deleted: boolean;
  Base?: string;
  Local?: string;
  Published?: string;
};
export function CopyUpdates({
  token,
  share,
  sent,
  changed,
}: {
  token: string;
  share: Share;
  sent: boolean;
  changed: () => Promise<void>;
}) {
  const { message, setMessage, busy, run } = useAction();
  const [copies, setCopies] = useState<State[]>(),
    [diff, setDiff] = useState<State>();
  const path = "/api/v1/shares/" + share.share_id;
  async function load() {
    setCopies(await (await request(token, path + "/copies")).json());
  }
  return (
    <div>
      {sent ? (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              await request(token, path + "/publish", "POST");
              setMessage("已发布当前文件版本");
            })
          }
        >
          发布来源更新
        </button>
      ) : (
        <button disabled={busy} onClick={() => run(load)}>
          查看来源与更新
        </button>
      )}
      {copies?.map((c) => (
        <div className="share" key={c.file_id}>
          <strong>{c.path}</strong>
          <p>
            来源 {share.sender} · {c.source_path}
          </p>
          <small>
            {c.source_file_id} · {c.base_source_version}
          </small>
          <p>
            {c.local_deleted
              ? "本地副本已移入回收站"
              : !c.source_version
                ? "来源文件已移除"
                : c.base_source_version === c.source_version
                  ? "已是发布版本"
                  : "来源有新版本"}
            {c.base_local_version !== c.local_version ? " · 本地已修改" : ""}
          </p>
          {c.source_version &&
            c.base_source_version !== c.source_version &&
            !c.local_deleted && (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setDiff(
                      await (
                        await request(token, path + "/copies/" + c.file_id)
                      ).json(),
                    ),
                  )
                }
              >
                对比版本
              </button>
            )}
        </div>
      ))}
      {diff && (
        <section className="copy-diff">
          <h3>{diff.path}</h3>
          {[
            ["上次导入", diff.Base, diff.base_local_version],
            ["本地内容", diff.Local, diff.local_version],
            ["来源更新", diff.Published, diff.source_version],
          ].map(([title, content, version]) => (
            <details key={title} open>
              <summary>{title}</summary>
              <pre>{content ?? version}</pre>
            </details>
          ))}
          <button disabled={busy} onClick={() => setDiff(undefined)}>
            保留本地内容
          </button>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await request(token, path + "/copies/" + diff.file_id, "POST", {
                  source_version: diff.source_version,
                  local_version: diff.local_version,
                });
                setDiff(undefined);
                await load();
                await changed();
                setMessage("副本已更新");
              })
            }
          >
            采用来源版本
          </button>
        </section>
      )}
      <span role="status">{message}</span>
    </div>
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
  const [snap, setSnap] = useState<Manifest>(),
    [preview, setPreview] = useState<{ path: string; text: string }>(),
    [password, setPassword] = useState(""),
    [vaults, setVaults] = useState<Vault[]>([]);
  const { message, setMessage, busy, run } = useAction();
  const path = "/s/" + entry.id + "/";
  async function refresh() {
    try {
      setSnap(await (await request("", path + "snapshot")).json());
    } catch (e) {
      setSnap(undefined);
      setPreview(undefined);
      throw e;
    }
  }
  useEffect(() => {
    if (!entry.secret) void run(refresh);
  }, [entry.id]);
  useEffect(() => {
    if (!token || !snap?.allow_import) return;
    request(token, "/api/v1/vaults")
      .then((r) => r.json())
      .then((x) => setVaults(x.vaults))
      .catch((e) => setMessage(String(e)));
  }, [token, snap?.allow_import]);
  useEffect(() => {
    if (!snap) return;
    const check = () => {
      if (!document.hidden) refresh().catch((e) => setMessage(String(e)));
    };
    const timer = setInterval(check, 15000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [!!snap]);
  return (
    <main className="public-share security-panel">
      <h1>分享快照</h1>
      {!snap ? (
        entry.secret ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await request("", path + "session", "POST", {
                  token: entry.secret,
                  password,
                });
                setPassword("");
                await refresh();
              });
            }}
          >
            <label>
              分享密码（如有）
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button disabled={busy}>打开分享</button>
          </form>
        ) : (
          <p>请使用发送者提供的完整链接打开分享。</p>
        )
      ) : (
        <>
          <h2>文件</h2>
          {snap.files.map((f) => (
            <div key={f.version_id}>
              {f.path}{" "}
              {!f.path.toLowerCase().endsWith(".xmind") && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await refresh();
                      const data = await (
                        await request("", path + "files/" + f.version_id)
                      ).json();
                      setPreview({ path: f.path, text: data.text });
                    })
                  }
                >
                  预览文本
                </button>
              )}
            </div>
          ))}
          {preview &&
            (preview.path.toLowerCase().endsWith(".md") ? (
              <MarkdownView
                text={preview.text}
                io={{
                  image: (url, alt) => {
                    const asset = snap.assets.find(
                      (a) => a.canonical_url === url,
                    );
                    return asset ? (
                      <img src={path + "assets/" + asset.asset_id} alt={alt} />
                    ) : (
                      <span>{alt}</span>
                    );
                  },
                  link: (href) => {
                    const asset = snap.assets.find(
                      (a) => a.canonical_url === href,
                    );
                    if (asset) {
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
          {snap.assets.map((a) => (
            <figure key={a.asset_id} id={a.asset_id}>
              <figcaption>{a.name}</figcaption>
              {["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
                a.media_type,
              ) && <img src={path + "assets/" + a.asset_id} alt={a.name} />}
            </figure>
          ))}
          {snap.allow_download && (
            <form method="post" action={path + "download"}>
              <button>下载快照 ZIP</button>
            </form>
          )}
          {snap.allow_import &&
            (token ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fields = new FormData(e.currentTarget);
                  void run(async () => {
                    await request(token, path + "import", "POST", {
                      vault_id: fields.get("vault"),
                      folder: fields.get("folder"),
                    });
                    setMessage("快照已导入");
                  });
                }}
              >
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
                <label>
                  目标目录
                  <input name="folder" />
                </label>
                <button disabled={busy || !vaults.length}>
                  导入到我的笔记库
                </button>
              </form>
            ) : (
              <details>
                <summary>登录并导入</summary>
                {login}
              </details>
            ))}
        </>
      )}
      <p role="status">{message}</p>
      <a href="/">我的笔记库</a>
    </main>
  );
}
