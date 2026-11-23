import { unified } from "unified";
import remarkParse from "remark-parse";
import gfm from "remark-gfm";
import math from "remark-math";
import frontmatter from "remark-frontmatter";

type MarkdownNode = {
  type: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: MarkdownNode[];
};

type Range = { start: number; end: number };

export type MarkdownSaveFormatOptions = {
  cjkLatinSpacing: boolean;
  cjkDigitSpacing: boolean;
  latinDigitSpacing: boolean;
  trimTrailingWhitespace: boolean;
  normalizeBlankLines: boolean;
};

export const defaultMarkdownSaveFormatOptions: MarkdownSaveFormatOptions = {
  cjkLatinSpacing: true,
  cjkDigitSpacing: true,
  latinDigitSpacing: true,
  trimTrailingWhitespace: true,
  normalizeBlankLines: true,
};

const parser = unified()
  .use(remarkParse)
  .use(frontmatter)
  .use(gfm)
  .use(math);

const protectedNodeTypes = new Set([
  "yaml",
  "toml",
  "code",
  "math",
  "inlineMath",
  "inlineCode",
  "html",
  "link",
  "linkReference",
  "definition",
  "image",
  "imageReference",
]);

function parse(source: string) {
  return parser.parse(source) as unknown as MarkdownNode;
}

function protectedRanges(source: string): Range[] {
  const ranges: Range[] = [];
  const tree = parse(source);
  function visit(node: MarkdownNode) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      protectedNodeTypes.has(node.type) &&
      typeof start === "number" &&
      typeof end === "number"
    ) {
      ranges.push({ start, end });
      return;
    }
    for (const child of node.children || []) visit(child);
  }
  visit(tree);
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function overlaps(ranges: Range[], start: number, end: number) {
  return ranges.some((range) => range.start < end && start < range.end);
}

function isCjk(character: string) {
  return /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
    character,
  );
}

function isLatin(character: string) {
  return /[A-Za-z]/.test(character);
}

function isDigit(character: string) {
  return /[0-9]/.test(character);
}

function shouldSeparate(
  left: string,
  right: string,
  options: MarkdownSaveFormatOptions,
) {
  const leftCjk = isCjk(left),
    rightCjk = isCjk(right),
    leftLatin = isLatin(left),
    rightLatin = isLatin(right),
    leftDigit = isDigit(left),
    rightDigit = isDigit(right);
  return (
    (options.cjkLatinSpacing &&
      ((leftCjk && rightLatin) || (leftLatin && rightCjk))) ||
    (options.cjkDigitSpacing &&
      ((leftCjk && rightDigit) || (leftDigit && rightCjk))) ||
    (options.latinDigitSpacing &&
      ((leftLatin && rightDigit) || (leftDigit && rightLatin)))
  );
}

function protectedInlineRanges(text: string): Range[] {
  const ranges: Range[] = [];
  const patterns = [
    /!?\[\[[^\]\n]+\]\]/g,
    /(?:https?|ftp):\/\/[^\s)]+/gi,
    /<[^>\n]*>/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined)
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end);
}

function formatTextSegment(
  text: string,
  options: MarkdownSaveFormatOptions,
): string {
  const masks = protectedInlineRanges(text);
  const output: string[] = [];
  let cursor = 0;
  let maskIndex = 0;
  while (cursor < text.length) {
    const mask = masks[maskIndex];
    if (mask && cursor >= mask.start) {
      output.push(text.slice(mask.start, mask.end));
      cursor = mask.end;
      maskIndex++;
      continue;
    }
    if (mask && cursor < mask.start) {
      output.push(formatTextSegment(text.slice(cursor, mask.start), options));
      cursor = mask.start;
      continue;
    }
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const nextOffset = cursor + character.length;
    const nextCodePoint = text.codePointAt(nextOffset);
    const next =
      nextCodePoint === undefined ? "" : String.fromCodePoint(nextCodePoint);
    output.push(character);
    if (next && shouldSeparate(character, next, options)) output.push(" ");
    cursor = nextOffset;
  }
  return output.join("");
}

function formatSpacing(
  source: string,
  ranges: Range[],
  options: MarkdownSaveFormatOptions,
) {
  const output: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output.push(formatTextSegment(source.slice(cursor, range.start), options));
    output.push(source.slice(range.start, range.end));
    cursor = range.end;
  }
  output.push(formatTextSegment(source.slice(cursor), options));
  return output.join("");
}

function formatTrailingWhitespace(source: string, ranges: Range[]) {
  const output: string[] = [];
  let lineStart = 0;
  while (lineStart <= source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd);
    const trailing = line.match(/[ \t]+$/);
    if (!trailing) {
      output.push(line);
    } else {
      const trailingStart = line.length - trailing[0].length;
      if (overlaps(ranges, lineStart + trailingStart, lineEnd)) {
        output.push(line);
      } else {
        const hardBreak =
          trailing[0].length >= 2 &&
          !trailing[0].includes("\t") &&
          trailing[0].endsWith("  ");
        output.push(line.slice(0, trailingStart) + (hardBreak ? "  " : ""));
      }
    }
    if (newline < 0) break;
    output.push("\n");
    lineStart = newline + 1;
  }
  return output.join("");
}

function formatBlankLines(source: string, ranges: Range[]) {
  const hasFinalNewline = source.endsWith("\n");
  const body = hasFinalNewline ? source.slice(0, -1) : source;
  if (!body) return source;
  const lines = body.split("\n");
  const output: string[] = [];
  let previousOrdinaryBlank = false;
  let offset = 0;
  for (const line of lines) {
    const end = offset + line.length;
    const blank = line.trim() === "";
    const protectedLine = overlaps(ranges, offset, end + 1);
    if (blank && !protectedLine) {
      if (output.length === 0) {
        offset = end + 1;
        continue;
      }
      if (previousOrdinaryBlank) {
        offset = end + 1;
        continue;
      }
      output.push("");
      previousOrdinaryBlank = true;
    } else {
      output.push(line);
      previousOrdinaryBlank = false;
    }
    offset = end + 1;
  }
  while (output.at(-1) === "") output.pop();
  return output.join("\n") + (hasFinalNewline ? "\n" : "");
}

export function formatMarkdown(
  source: string,
  options: Partial<MarkdownSaveFormatOptions> = {},
) {
  const settings = { ...defaultMarkdownSaveFormatOptions, ...options };
  let text = source;
  const initialRanges = protectedRanges(text);
  text = formatSpacing(text, initialRanges, settings);
  if (settings.trimTrailingWhitespace) {
    text = formatTrailingWhitespace(text, protectedRanges(text));
  }
  if (settings.normalizeBlankLines) {
    text = formatBlankLines(text, protectedRanges(text));
  }
  return { text, changed: text !== source };
}
