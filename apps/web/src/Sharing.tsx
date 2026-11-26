import { download } from "./Resources";
import { ShareSaveDialog } from "./ShareSaveDialog";
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
  vault_id: string;
  id: string;
  title: string;
  expires: number;
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

export function prepareNoteLink(token: string, vault: string, path: string, days: number) {
  return prepareLink(token, {
    vault_id: vault,
    paths: [path],
    allow_import: true,
    allow_download: true,
    duration_days: days,
  });
}

export function Sharing({ token, vaults }: { token: string; vaults: Vault[] }) {
  const [links, setLinks] = useState<Link[]>([]);
  const { message, busy, run } = useAction();
  const endpoint = "/api/v1/share-links";
  useEffect(() => {
    let open = true;
    void run(async () => {
      const response = await request(token, endpoint);
      const active: Link[] = await response.json();
      if (open) setLinks(active);
    });
    return () => { open = false; };
  }, [token]);

  useEffect(() => {
    const next = links.reduce((first, link) => link.expires ? Math.min(first, link.expires) : first, Infinity);
    if (!Number.isFinite(next)) return;
    // Older clients could set arbitrary expiry dates beyond the browser timer limit.
    const delay = Math.min(next * 1000 - Date.now(), 2_147_483_647);
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setLinks(current => current.filter(link => !link.expires || link.expires * 1000 > now));
    }, Math.max(0, delay));
    return () => clearTimeout(timer);
  }, [links]);

  async function stop(link: Link) {
    if (!confirm(`停止分享「${link.title}」？已保存的副本可继续使用。`)) return;
    await request(token, `${endpoint}/${link.id}`, "DELETE");
    setLinks(current => current.filter(item => item.id !== link.id));
  }
  const groups = new Map<string, Link[]>();
  for (const link of links) {
    const group = groups.get(link.vault_id);
    if (group) group.push(link);
    else groups.set(link.vault_id, [link]);
  }
  return (
    <article className="security-panel share-list">
      {message && <p role="status">{message}</p>}
      {!busy && !message && !links.length && <p>暂无有效分享</p>}
      {Array.from(groups, ([vault, items]) => (
        <section key={vault}>
          <h3>{vaults.find(item => item.id === vault)?.name ?? vault}</h3>
          <ul>{items.map(link => (
            <li key={link.id}>
              <div>
                <strong>{link.title}</strong>
                <p>{link.expires ? `${new Date(link.expires * 1000).toLocaleString()} 到期` : "永久有效"}</p>
                {link.password_required && <small>有密码</small>}
              </div>
              <button disabled={busy} onClick={() => run(() => stop(link))}>停止分享</button>
            </li>
          ))}</ul>
        </section>
      ))}
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
  const { message, setMessage, busy, run } = useAction();
  const path = "/s/" + entry.id + "/";
  const file =
    snap?.files.find((f) => f.version_id === selected) || snap?.files[0];
  const version = file?.version_id;
  const canPreview = file && !/\.xmind$/i.test(file.path);

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
            {snap.allow_import && !savedURL && (
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
          {saving && snap.allow_import && (
            <ShareSaveDialog
              token={token}
              login={login}
              importPath={path + "import"}
              close={() => setSaving(false)}
              saved={(vault, files, folder) => {
                if (files[0])
                  setSavedURL(
                    "/?" +
                      new URLSearchParams({ vault, note: files[0].file_id }),
                  );
                setSaving(false);
                const previous =
                  snap.files.length === 1 &&
                  files[0] &&
                  files[0].path !==
                    [folder, file?.path.split("/").at(-1)]
                      .filter(Boolean)
                      .join("/");
                setMessage(
                  previous
                    ? `此笔记已保存过，首次保存位置为 ${files[0].path}`
                    : "已保存到我的笔记",
                );
              }}
            />
          )}
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
    </main>
  );
}
