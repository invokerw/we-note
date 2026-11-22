import type { MarkdownIO } from "./markdown/Markdown";
import { boardText } from "./markdown/Whiteboard";
import { initialBytes, asMarkdown, openMap } from "./plugins/xmind";
import { decodeText, unpack, utf8, type ExportFile } from "./plugins/archive";

export const marker = ".wenote-folder.json";
const markerBytes = utf8.encode('{"wenote":"directory","version":1}');
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
  空白文档: "未命名.txt",
  从模板新建: "会议记录.md",
  表格: "表格.md",
  Markdown: "未命名.md",
  脑图: "未命名.xmind",
  流程图: "流程图.md",
  白板: "白板.md",
  文件夹: "新建文件夹",
} as const;
export type Format = keyof typeof formats;
export const templates = {
  会议记录: "## 与会人员\n\n\n## 议题\n\n\n## 行动项\n\n- [ ] ",
  周报: "## 本周进展\n\n\n## 下周计划\n\n",
  任务清单: "- [ ] ",
};
export function newContent(
  format: Format,
  path: string,
  template: keyof typeof templates,
) {
  if (format === "白板") return utf8.encode(boardText([]));
  if (format === "文件夹") return markerBytes;
  if (format === "从模板新建")
    return utf8.encode(
      "# " +
        entryName(path).replace(/\.md$/i, "") +
        "\n\n" +
        templates[template] +
        "\n",
    );
  if (format === "表格")
    return utf8.encode(
      "| 项目 | 负责人 | 状态 |\n| --- | --- | --- |\n|  |  |  |\n",
    );
  if (format === "流程图")
    return utf8.encode(
      "```mermaid\nflowchart TD\n    A[开始] --> B[结束]\n```\n",
    );
  return initialBytes(path);
}
export function wordText(bytes: Uint8Array) {
  const doc = unpack(bytes, 64 << 20, 5000)["word/document.xml"];
  if (!doc) throw Error("请选择 .docx 格式的 Word 文档");
  const xml = new DOMParser().parseFromString(
    decodeText(doc),
    "application/xml",
  );
  if (xml.querySelector("parsererror")) throw Error("Word 文档内容无效");
  return utf8.encode(
    Array.from(xml.getElementsByTagNameNS("*", "p"), (p) =>
      Array.from(p.getElementsByTagNameNS("*", "t"), (t) => t.textContent).join(
        "",
      ),
    ).join("\n\n"),
  );
}
export function printableText(path: string, bytes: Uint8Array) {
  return /\.xmind$/i.test(path)
    ? openMap(bytes).sheets.map(asMarkdown).join("\n\n")
    : decodeText(bytes);
}
