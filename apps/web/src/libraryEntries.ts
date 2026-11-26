import { isMindMap, mindSuffix } from "./plugins/mindFile";
import type { MarkdownIO } from "./markdown/Markdown";
import { type ExportFile } from "./plugins/archive";

export const marker = ".wenote-folder.json";
// Match both name and content so existing user-authored JSON remains visible.
export function entryPath(path: string, hash?: string) {
  return path.endsWith("/" + marker) &&
    hash ===
      "sha256:62837e3e3cc858e7102d86bce9f026008296ae23e621644486d155744e372496"
    ? parentFolder(path)
    : path;
}
export function isFolder(path: string) {
  return !path || path.endsWith("/");
}
export function entryName(path: string) {
  return path.replace(/\/$/, "").split("/").at(-1) || "我的文件夹";
}
export function parentFolder(path: string) {
  const p = path.replace(/\/$/, "");
  return p.slice(0, p.lastIndexOf("/") + 1);
}
export function containsEntry(source: string, path: string) {
  return source === path || (isFolder(source) && path.startsWith(source));
}
export type Change = "move" | "copy" | "delete";
export type EntryIO = {
  revisions: Record<string, string>;
  write: (path: string, bytes: Uint8Array) => Promise<void>;
  read: (path: string) => Promise<Uint8Array>;
  change: (
    op: Change,
    src: string,
    dst: string,
    expected: Record<string, string>,
  ) => Promise<void>;
  refresh: () => Promise<void>;
  openCreated: (path: string) => Promise<void>;
  output: ExportFile;
  image: MarkdownIO["image"];
  print: (name: string) => void | Promise<void>;
};
export const formats = {
  Markdown: "未命名.md",
  思维导图: "未命名.mind.json",
} as const;
export type Format = keyof typeof formats;
export async function newContent(path: string) {
  if (isMindMap(path)) {
    const { default: MindElixir } = await import("mind-elixir");
    return new TextEncoder().encode(JSON.stringify(MindElixir.new(entryName(path).slice(0, -mindSuffix.length) || "中心主题")));
  }
  return new Uint8Array();
}
