import { unzipSync, type Unzipped } from "fflate";

export const noteLimit = 16 << 20;
export const utf8 = new TextEncoder();
export function decodeText(data: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    data,
  );
}
export function unpack(
  data: Uint8Array,
  maxBytes: number,
  maxEntries: number,
): Unzipped {
  let size = 0;
  const names = new Set<string>();
  return unzipSync(data, {
    filter(entry) {
      if (entry.compression === 0 && entry.size !== entry.originalSize)
        throw Error("无效的 ZIP 条目大小");
      size += entry.originalSize;
      const parts = entry.name.replace(/\/$/, "").split("/");
      if (
        names.has(entry.name) ||
        parts.some(
          (p) =>
            !p ||
            [".", "..", "__proto__", "constructor", "prototype"].includes(p),
        ) ||
        /[\\\x00]/.test(entry.name)
      )
        throw Error("ZIP 条目名称无效或重复");
      names.add(entry.name);
      if (size > maxBytes || names.size > maxEntries)
        throw Error("ZIP 展开后超过限制");
      return true;
    },
  });
}
export function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export type ExportFile = (name: string, bytes: Uint8Array) => Promise<void>;
export const browserExport: ExportFile = async (name, data) => {
  const a = document.createElement("a");
  a.download = name;
  a.href = URL.createObjectURL(new Blob([new Uint8Array(data)]));
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
