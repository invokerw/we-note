export const markdownModes = [
  ["split", "分屏编辑"],
  ["crepe", "可视化编辑"],
  ["read", "预览"],
] as const;

export type MarkdownMode = (typeof markdownModes)[number][0];

export function normalizeMarkdownMode(value: unknown): MarkdownMode | undefined {
  switch (value) {
    case "split": case "edit": return "split";
    case "crepe": case "live": return "crepe";
    case "read": case "map": return "read";
    default: return undefined;
  }
}

export function markdownWritingMode(remembered: MarkdownMode | undefined, preferred: MarkdownMode) {
  if (remembered === "split" || remembered === "crepe") return remembered;
  return preferred === "split" ? "split" : "crepe";
}
