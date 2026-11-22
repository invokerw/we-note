import { zipSync, type Unzipped } from "fflate";
import { markdownHeadings, headingText } from "../markdown/document";
import { decodeText, noteLimit, unpack, utf8 } from "./archive";

type Style = { id?: string; properties?: Record<string, string> };
type TopicPosition = { x?: number; y?: number; manual?: boolean };
export type TopicChildren = Record<string, Topic[]>;
export type Topic = {
  id: string;
  title: string;
  class?: string;
  structureClass?: string;
  branch?: string;
  position?: TopicPosition;
  children?: TopicChildren;
  notes?: { plain?: { content: string }; html?: unknown; ops?: unknown };
  style?: Style;
  summaries?: { id: string; range: string; topicId: string }[];
  labels?: string[] | { text?: string }[];
  markers?: { groupId?: string; markerId?: string }[];
  href?: string;
  image?: unknown;
  customWidth?: number;
};
export type Sheet = {
  id: string;
  title: string;
  class?: string;
  structureClass?: string;
  topicPositioning?: string;
  rootTopic: Topic;
  relationships?: {
    id: string;
    title?: string;
    end1Id: string;
    end2Id: string;
    controlPoints?: Record<string, { angle: number; amount: number }>;
  }[];
};
export type Workbook = {
  entries: Unzipped;
  sheets: Sheet[];
  contentShape?: "array" | "sheets" | "workbook";
  contentEnvelope?: Record<string, unknown>;
};
export function topic(title: string): Topic {
  return { id: crypto.randomUUID(), class: "topic", title };
}
export function workbook(title: string): Workbook {
  return {
    entries: {
      "mimetype": utf8.encode("application/vnd.xmind.workbook"),
      "metadata.json": utf8.encode(
        JSON.stringify({
          creator: { name: "WeNote", version: "1" },
          dataStructureVersion: "3",
          layoutEngineVersion: "5",
        }),
      ),
      "manifest.json": utf8.encode(
        JSON.stringify({
          "file-entries": {
            "content.json": {},
            "metadata.json": {},
            mimetype: {},
          },
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
  const parsed = JSON.parse(decodeText(entries["content.json"]));
  const content = contentSheets(parsed);
  if (!content || !content.sheets.length || content.sheets.length > 128)
    throw Error("无效的 XMind 工作表");
  for (const s of content.sheets) {
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
  return {
    entries,
    sheets: content.sheets,
    contentShape: content.shape,
    contentEnvelope: content.envelope,
  };
}
export function writeMap(book: Workbook) {
  const content =
    book.contentShape === "sheets"
      ? { ...(book.contentEnvelope ?? {}), sheets: book.sheets }
      : book.contentShape === "workbook"
        ? {
            ...(book.contentEnvelope ?? {}),
            workbook: {
              ...((book.contentEnvelope?.workbook as Record<string, unknown>) ??
                {}),
              sheets: book.sheets,
            },
          }
        : book.sheets;
  const data = zipSync(
    {
      ...book.entries,
      "content.json": utf8.encode(JSON.stringify(content)),
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

function contentSheets(value: unknown) {
  if (Array.isArray(value))
    return {
      sheets: value as Sheet[],
      shape: "array" as const,
      envelope: undefined,
    };
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.sheets))
      return {
        sheets: record.sheets as Sheet[],
        shape: "sheets" as const,
        envelope: record,
      };
    if (
      record.workbook &&
      typeof record.workbook === "object" &&
      Array.isArray((record.workbook as Record<string, unknown>).sheets)
    )
      return {
        sheets: (record.workbook as Record<string, unknown>).sheets as Sheet[],
        shape: "workbook" as const,
        envelope: record,
      };
  }
  return undefined;
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

export function topicChildren(n: Topic, bucket = "attached") {
  return n.children?.[bucket] ?? [];
}

export function topicLabelText(n: Topic) {
  return (n.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.text ?? ""))
    .filter(Boolean);
}

export function topicColor(n: Topic) {
  const properties = n.style?.properties ?? {};
  return (
    properties["svg:fill"] ||
    properties["fo:background-color"] ||
    properties["fill"] ||
    ""
  );
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
