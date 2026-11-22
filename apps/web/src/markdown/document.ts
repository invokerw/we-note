import { unified } from "unified";
import remarkParse from "remark-parse";
import gfm from "remark-gfm";
import math from "remark-math";
import frontmatter from "remark-frontmatter";
import { toString } from "mdast-util-to-string";
import { visit } from "unist-util-visit";
import { parse } from "yaml";
import type { Root, PhrasingContent } from "mdast";

export const extensions = [frontmatter, gfm, math];
const parser = unified().use(remarkParse).use(extensions);
export function parseMarkdown(source: string) {
  return parser.parse(source);
}
export function taskCheckChange(source: string, offset: number) {
  const match = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\]/.exec(source.slice(offset));
  if (!match) return;
  const from = offset + match[0].length - 2;
  return { from, to: from + 1, insert: match[1] === " " ? "x" : " " };
}
export type Branch = {
  title: string;
  level: number;
  offset: number;
  children: Branch[];
};
export function inspect(source: string) {
  const tree = parser.parse(source),
    outline: Branch[] = [],
    stack: Branch[] = [];
  let properties: Record<string, unknown> = {};
  const tags = new Set<string>();
  visit(tree, "heading", (node) => {
    const h = {
      title: toString(node),
      level: node.depth,
      offset: node.position!.start.offset!,
      children: [],
    };
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    (stack.at(-1)?.children ?? outline).push(h);
    stack.push(h);
  });
  const front = tree.children[0];
  if (front?.type === "yaml") {
    try {
      const value = parse(front.value);
      if (value && typeof value === "object" && !Array.isArray(value))
        properties = JSON.parse(JSON.stringify(value));
    } catch {
      /* Invalid YAML remains editable as source. */
    }
  }
  const declared = properties.tags;
  for (const tag of Array.isArray(declared)
    ? declared
    : typeof declared === "string"
      ? declared.split(/[,\s]+/)
      : [])
    if (typeof tag === "string" && tag) tags.add(tag.replace(/^#/, ""));
  visit(tree, "text", (node) => {
    for (const tag of node.value.matchAll(
      /(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu,
    ))
      tags.add(tag[1]);
  });
  return { outline, properties, tags: [...tags].sort() };
}
const wikiPrefix = "#wenote-link=";
export function linkTarget(href: string) {
  if (!href.startsWith(wikiPrefix)) return href;
  try {
    return decodeURIComponent(href.slice(wikiPrefix.length));
  } catch {
    return href;
  }
}
export function noteSyntax() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node) => {
      const p = node.children[0];
      if (p?.type !== "paragraph") return;
      const t = p.children[0];
      if (t?.type !== "text") return;
      const match = t.value.match(/^\[!([a-z]+)\][ \t]*/i);
      if (match) {
        node.data = {
          hProperties: {
            className: ["callout"],
            "data-kind": match[1].toUpperCase(),
          },
        };
        t.value = t.value.slice(match[0].length);
      }
    });
    visit(tree, "text", (node, index, parent) => {
      if (
        !parent ||
        index === undefined ||
        parent.type === "link" ||
        parent.type === "linkReference"
      )
        return;
      const re = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g;
      let end = 0;
      const values: PhrasingContent[] = [];
      for (const m of node.value.matchAll(re)) {
        values.push(
          { type: "text", value: node.value.slice(end, m.index) },
          {
            type: "link",
            url: wikiPrefix + encodeURIComponent(m[1]),
            children: [{ type: "text", value: m[2] || m[1] }],
          },
        );
        end = m.index! + m[0].length;
      }
      if (end) {
        values.push({ type: "text", value: node.value.slice(end) });
        parent.children.splice(index, 1, ...values);
        return index + values.length;
      }
    });
  };
}
export function resolvePath(from: string, raw: string, paths: string[]) {
  const target = raw.split("#")[0].trim();
  if (!target) return from;
  if (/^[\w+.-]+:|^\/\//.test(target)) return;
  let name: string;
  try {
    name = decodeURIComponent(target);
  } catch {
    return;
  }
  if (!/\.[^/]+$/.test(name)) name += ".md";
  const parts = from.split("/").slice(0, -1);
  if (!name.startsWith("/")) {
    for (const part of name.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    const relative = parts.join("/");
    if (paths.includes(relative)) return relative;
  }
  name = name.replace(/^\//, "");
  if (paths.includes(name)) return name;
  const matches = paths.filter((p) => p.split("/").at(-1) === name);
  if (matches.length === 1) return matches[0];
}

/** Only document-level headings delimit sections. Keep code and quoted headings in their body. */
export function markdownHeadings(source: string) {
  return parser
    .parse(source)
    .children.flatMap((node) =>
      node.type === "heading"
        ? [
            {
              title: toString(node),
              level: node.depth,
              start: node.position!.start.offset!,
              end: node.position!.end.offset!,
            },
          ]
        : [],
    );
}

export function headingText(value: string) {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}\[\]<>#!~|&])/g, "\\$1");
}
