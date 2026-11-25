import { multipart, multipartThreshold } from "./multipart";
export type Vault = { id: string; name: string };
export type Note = {
  file_id: string;
  path: string;
  format: string;
  updated_at?: string;
  current_content_size?: number;
  current_version_id: string;
  current_content_hash?: string;
};
export type Version = {
  version_id: string;
  created_at: string;
  vault_revision: number;
};
export type Share = {
  share_id: string;
  sender: string;
  recipient: string;
  status: string;
  snapshot: { files: { path: string }[]; assets?: { name: string }[] };
};
type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
};
export function rememberSession(s: Session) {
  sessionStorage.setItem("wenote-session", s.access_token);
  sessionStorage.setItem(
    "wenote-renewal",
    JSON.stringify({
      refresh_token: s.refresh_token,
      expires_at: s.expires_at,
    }),
  );
}
let pending: Promise<string> | undefined;
async function accessToken(original: string) {
  const info = JSON.parse(sessionStorage.getItem("wenote-renewal") || "null");
  if (!info || Date.parse(info.expires_at) > Date.now() + 60000)
    return sessionStorage.getItem("wenote-session") || original;
  if (!pending)
    pending = (async () => {
      const response = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: info.refresh_token }),
      });
      if (!response.ok) throw Error("会话已过期，请重新登录");
      const next = await response.json();
      rememberSession(next);
      return next.access_token as string;
    })().finally(() => {
      pending = undefined;
    });
  return pending;
}
export async function request(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = "Bearer " + (await accessToken(token));
  const raw = body instanceof Blob;
  if (body !== undefined && !raw) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["Idempotency-Key"] = crypto.randomUUID();
  const response = await fetch(path, {
    method,
    headers: { ...headers, ...extraHeaders },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    const e = await response.json().catch(() => ({}));
    const error = new Error(
      e.error?.code === "FILE_VERSION_CONFLICT"
        ? "文件已有新版本。请保留当前草稿，查看新版本后再保存。"
        : e.error?.message || e.message || `请求失败 (${response.status})`,
    );
    throw Object.assign(error, { code: e.error?.code });
  }
  return response;
}
export function base64(data: Uint8Array) {
  let s = "";
  for (let i = 0; i < data.length; i += 8192)
    s += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(s);
}
export const pictureTypes = "image/png,image/jpeg,image/gif,image/webp";
export function checkPicture(file: File) {
  if (!pictureTypes.split(",").includes(file.type)) throw Error("请选择 PNG、JPEG、GIF 或 WebP 图片");
}
export async function uploadAsset(
  token: string,
  vault: string,
  note: string,
  file: File,
  progress?: (message: string) => void,
) {
  checkPicture(file);
  const path = `/api/v1/vaults/${vault}/assets`;
  if (file.size >= multipartThreshold) {
    const user = await (await request(token, "/api/v1/me")).json();
    return multipart(
      file,
      [location.origin, vault, note, user.id],
      {
        create: async (meta, key) =>
          (
            await request(token, path + "/uploads", "POST", { ...meta, file_id:note }, {
              "Idempotency-Key": key,
            })
          ).json(),
        parts: async (id) =>
          (await request(token, `${path}/${id}/parts`)).json(),
        put: async (id, n, range, hash, data) => {
          await request(
            token,
            `${path}/${id}/parts/${n}`,
            "PUT",
            new Blob([data]),
            { "Content-Range": range, "X-Part-Hash": hash },
          );
        },
        assemble: async (id) => {
          await request(token, `${path}/${id}/assemble`, "POST");
        },
      },
      progress,
    );
  }
  const data = await file.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hash =
    "sha256:" +
    Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const asset = await (
    await request(token, path + "/uploads", "POST", {
      file_id: note,
      name: file.name,
      media_type: file.type || "application/octet-stream",
      content_hash: hash,
      content_size: file.size,
    })
  ).json();
  await request(token, path + "/" + asset.asset_id + "/complete", "POST", file);
  return asset.canonical_url as string;
}
