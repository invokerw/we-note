import type { EditorView } from "@milkdown/kit/prose/view";

export type Span = [number, number];

// Use the surrounding source as-is, including blank lines and trailing whitespace.
export function patchBlocks(
  source: string,
  spans: Span[],
  first: number,
  end: number,
  replacement: string,
) {
  const startOffset = spans[first]?.[0] ?? spans.at(-1)?.[1] ?? 0;
  const endOffset = first < end ? spans[end - 1][1] : startOffset;
  return source.slice(0, startOffset) + replacement + source.slice(endOffset);
}

export type RichWriting = {
  focusedView(): EditorView | undefined;
  compositionEnd(): Promise<void>;
  insertion(): (markdown: string) => boolean;
};
