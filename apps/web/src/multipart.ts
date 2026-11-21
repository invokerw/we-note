import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const multipartThreshold = 4 << 20;
export type AssetMetadata = {
  name: string;
  media_type: string;
  content_size: number;
  content_hash: string;
};
type Transport = {
  create(
    meta: AssetMetadata,
    key: string,
  ): Promise<{ asset_id: string; canonical_url: string; status: string }>;
  parts(
    id: string,
  ): Promise<{ part_size: number; completed_parts: number[]; status: string }>;
  put(
    id: string,
    index: number,
    range: string,
    hash: string,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<void>;
  assemble(id: string): Promise<void>;
};
export async function multipart(
  file: File,
  scope: string[],
  transport: Transport,
  progress?: (message: string) => void,
  checkpoint?: (slot: string, completedKey?: string) => Promise<string | null>,
) {
  if (file.size > 256 << 20) throw Error("附件超过 256 MiB");
  progress?.("正在校验附件…");
  const digest = sha256.create();
  for (let start = 0; start < file.size; start += multipartThreshold) {
    digest.update(
      new Uint8Array(
        await file.slice(start, start + multipartThreshold).arrayBuffer(),
      ),
    );
  }
  const meta = {
    name: file.name,
    media_type: file.type || "application/octet-stream",
    content_size: file.size,
    content_hash: "sha256:" + bytesToHex(digest.digest()),
  };
  const slot = "wenote-upload:" + JSON.stringify([...scope, meta]);
  const key = checkpoint
    ? await checkpoint(slot)
    : localStorage.getItem(slot) || crypto.randomUUID();
  if (!key) throw Error("无法保存上传任务");
  if (!checkpoint) localStorage.setItem(slot, key);
  const asset = await transport.create(meta, key);
  if (asset.status !== "completed") {
    const state = await transport.parts(asset.asset_id);
    const size = state.part_size;
    if (!Number.isSafeInteger(size) || size < 1 || size > 8 << 20)
      throw Error("服务返回的分片大小无效");
    const done = new Set(state.completed_parts);
    const count = Math.ceil(file.size / size);
    if (state.status !== "completed") {
      // Wait for both requests before returning an error so a retry cannot race old workers.
      for (let first = 0; first < count; first += 2) {
        const pending = [first, first + 1].filter(
          (n) => n < count && !done.has(n),
        );
        const results = await Promise.allSettled(
          pending.map(async (n) => {
            const start = n * size,
              end = Math.min(file.size, start + size);
            const data = new Uint8Array(
              await file.slice(start, end).arrayBuffer(),
            );
            await transport.put(
              asset.asset_id,
              n,
              `bytes ${start}-${end - 1}/${file.size}`,
              "sha256:" + bytesToHex(sha256(data)),
              data,
            );
            done.add(n);
          }),
        );
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
        progress?.(`已上传 ${done.size} / ${count} 片`);
      }
      await transport.assemble(asset.asset_id);
    }
  }
  if (checkpoint) await checkpoint(slot, key);
  else if (localStorage.getItem(slot) === key) localStorage.removeItem(slot);
  return asset.canonical_url;
}
