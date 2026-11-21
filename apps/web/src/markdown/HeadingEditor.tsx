import { useMemo, useState } from "react";
import { markdownHeadings, headingText } from "./document";
export default function HeadingEditor({
  text,
  edit,
}: {
  text: string;
  edit: (next: string) => void;
}) {
  const headings = useMemo(() => markdownHeadings(text), [text]);
  const [index, select] = useState(0),
    [title, setTitle] = useState<string | null>(null);
  const current = headings[index];
  if (!current) return null;
  let previous = index - 1;
  while (previous >= 0 && headings[previous].level > current.level) previous--;
  const canMove = previous >= 0 && headings[previous].level === current.level;
  function moveUp() {
    let after = index + 1;
    while (after < headings.length && headings[after].level > current.level)
      after++;
    const end = headings[after]?.start ?? text.length,
      start = headings[previous].start;
    const earlier = text.slice(start, current.start),
      later = text.slice(current.start, end);
    const separator = (chunk: string) => chunk.match(/\n+$/)?.[0] ?? "";
    edit(
      text.slice(0, start) +
        later.slice(0, later.length - separator(later).length) +
        separator(earlier) +
        earlier.slice(0, earlier.length - separator(earlier).length) +
        separator(later) +
        text.slice(end),
    );
    select(previous);
    setTitle(null);
  }
  return (
    <details>
      <summary>编辑标题树</summary>
      <fieldset>
        <label>
          目标标题
          <select
            value={index}
            onChange={(e) => {
              select(Number(e.target.value));
              setTitle(null);
            }}
          >
            {headings.map((h, i) => (
              <option key={i} value={i}>
                {"#".repeat(h.level)} {h.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题文本
          <input
            value={title ?? current.title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <button
          disabled={!title?.trim()}
          onClick={() => {
            edit(
              text.slice(0, current.start) +
                "#".repeat(current.level) +
                " " +
                headingText(title!.trim()) +
                text.slice(current.end),
            );
            setTitle(null);
          }}
        >
          更新标题
        </button>
        <button disabled={!canMove} onClick={moveUp}>
          上移整个章节
        </button>
      </fieldset>
    </details>
  );
}
