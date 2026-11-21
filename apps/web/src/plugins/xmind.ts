import { zipSync, type Unzipped } from "fflate";
import { markdownHeadings, headingText } from "../markdown/document";
import { decodeText, noteLimit, unpack, utf8 } from "./archive";

type Style = { id?: string; properties?: Record<string, string> };
export type Topic = {
  id: string;
  title: string;
  class?: string;
  children?: Record<string, Topic[]>;
  notes?: { plain?: { content: string }; html?: unknown; ops?: unknown };
  style?: Style;
  summaries?: { id: string; range: string; topicId: string }[];
};
export type Sheet = {
  id: string;
  title: string;
  class?: string;
  rootTopic: Topic;
  relationships?: {
    id: string;
    title?: string;
    end1Id: string;
    end2Id: string;
    controlPoints?: Record<string, { angle: number; amount: number }>;
  }[];
};
export type Workbook = { entries: Unzipped; sheets: Sheet[] };
export function topic(title: string): Topic {
  return { id: crypto.randomUUID(), class: "topic", title };
}
export function workbook(title: string): Workbook {
  return {
    entries: {
      "metadata.json": utf8.encode(
        JSON.stringify({ creator: { name: "WeNote", version: "1" } }),
      ),
      "manifest.json": utf8.encode(
        JSON.stringify({
          "file-entries": { "content.json": {}, "metadata.json": {} },
        }),
      ),
    },
    sheets: [
      {
        id: crypto.randomUUID(),
        class: "sheet",
        title,
        rootTopic: topic(title),
      },
    ],
  };
}
export function topics(root: Topic): Topic[] {
  const out: Topic[] = [];
  const seen = new Set<string>();
  function visit(n: Topic, level: number) {
    if (
      level > 100 ||
      out.length >= 10000 ||
      !n ||
      typeof n.id !== "string" ||
      !n.id ||
      seen.has(n.id) ||
      (typeof n.title !== "string" && n.title !== undefined)
    )
      throw Error("无效或过大的 XMind 主题树");
    seen.add(n.id);
    out.push(n);
    for (const group of Object.values(n.children ?? {})) {
      if (!Array.isArray(group)) throw Error("无效的 XMind 子主题");
      for (const child of group) visit(child, level + 1);
    }
  }
  visit(root, 0);
  return out;
}
export function openMap(bytes: Uint8Array): Workbook {
  if (bytes.length > noteLimit) throw Error("笔记超过 16 MiB");
  const entries = unpack(bytes, 48 << 20, 2048);
  if (!entries["content.json"])
    throw Error(
      entries["content.xml"]
        ? "此文件为 XMind 8 XML 格式，请在 XMind 中另存为新版 .xmind 后打开。"
        : "缺少 XMind content.json",
    );
  const sheets: Sheet[] = JSON.parse(decodeText(entries["content.json"]));
  if (!Array.isArray(sheets) || !sheets.length || sheets.length > 128)
    throw Error("无效的 XMind 工作表");
  for (const s of sheets) {
    if (
      !s ||
      (s.title !== undefined && typeof s.title !== "string") ||
      (s.relationships !== undefined &&
        (!Array.isArray(s.relationships) ||
          s.relationships.some(
            (r) =>
              !r ||
              typeof r.id !== "string" ||
              (r.title !== undefined && typeof r.title !== "string"),
          )))
    )
      throw Error("无效的 XMind 工作表或关系线");
    topics(s.rootTopic);
  }
  return { entries, sheets };
}
export function writeMap(book: Workbook) {
  const data = zipSync(
    {
      ...book.entries,
      "content.json": utf8.encode(JSON.stringify(book.sheets)),
    },
    { level: 3 },
  );
  if (data.length > noteLimit) throw Error("笔记超过 16 MiB");
  return data;
}
export function initialBytes(path: string) {
  if (/\.xmind$/i.test(path))
    return writeMap(
      workbook(path.split("/").at(-1)!.slice(0, -6) || "中心主题"),
    );
  return utf8.encode(/\.json$/i.test(path) ? "{}" : "");
}
export function setTopicNote(n: Topic, content: string) {
  n.notes = {
    ...n.notes,
    plain: { content },
    html: {
      content: {
        paragraphs: content.split("\n").map((text) => ({ spans: [{ text }] })),
      },
    },
    ops: { ops: [{ insert: content }] },
  };
}
function note(n: Topic, body: string) {
  if (body.trim()) setTopicNote(n, body.trim());
}
export function fromMarkdown(source: string, title: string) {
  const headings = markdownHeadings(source);
  const book = workbook(title),
    sheet = book.sheets[0];
  if (!headings.length) {
    note(sheet.rootTopic, source);
    return book;
  }
  const first = headings[0];
  const singleRoot =
    !source.slice(0, first.start).trim() &&
    headings.slice(1).every((h) => h.level > first.level);
  if (!singleRoot) note(sheet.rootTopic, source.slice(0, first.start));
  const stack: { level: number; node: Topic }[] = [];
  headings.forEach((h, i) => {
    const n = topic(h.title);
    note(n, source.slice(h.end, headings[i + 1]?.start ?? source.length));
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    if (!i && singleRoot) sheet.rootTopic = n;
    else {
      const parent = stack.at(-1)?.node || sheet.rootTopic;
      ((parent.children ??= {}).attached ??= []).push(n);
    }
    stack.push({ level: h.level, node: n });
  });
  return book;
}
export function asMarkdown(sheet: Sheet) {
  const lines: string[] = [];
  function visit(n: Topic, depth: number) {
    if (depth > 6) throw Error("主题超过六层，无法完整转换为 Markdown 标题树");
    const title = headingText(n.title || "未命名");
    lines.push("#".repeat(depth) + " " + title, "");
    if (n.notes?.plain?.content) lines.push(n.notes.plain.content, "");
    for (const child of [
      ...(n.children?.attached ?? []),
      ...(n.children?.detached ?? []),
    ])
      visit(child, depth + 1);
  }
  visit(sheet.rootTopic, 1);
  return lines.join("\n");
}
