import { useRef, useState, type PointerEvent } from "react";

// Keep drawings portable inside a fenced Markdown block; points use a fixed viewBox.
export function boardText(strokes: string[]) {
  return "```wenote-whiteboard\n" + JSON.stringify(strokes) + "\n```\n";
}
export function boardStrokes(text: string): string[] | null {
  const raw = /^```wenote-whiteboard\r?\n([^\n]*)\r?\n```\s*$/.exec(text)?.[1];
  if (!raw) return null;
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) &&
      data.every(
        (p) =>
          typeof p === "string" &&
          /^\d{1,4},\d{1,4}( \d{1,4},\d{1,4})*$/.test(p),
      )
      ? data
      : null;
  } catch {
    return null;
  }
}
export function Whiteboard({
  strokes,
  change,
  activate,
}: {
  strokes: string[];
  change?: (strokes: string[]) => void;
  activate?: () => void;
}) {
  const current = useRef<{ id: number; points: string[] } | null>(null),
    [line, draw] = useState("");
  function point(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return (
      Math.round(
        Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * 1000,
      ) +
      "," +
      Math.round(
        Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)) * 650,
      )
    );
  }
  function finish() {
    const stroke = current.current;
    current.current = null;
    draw("");
    if (stroke) change?.([...strokes, stroke.points.join(" ")]);
  }
  return (
    <section className="whiteboard">
      {(change || activate) && (
        <div>
          {change ? (
            <button
              disabled={!strokes.length}
              onClick={() => change(strokes.slice(0, -1))}
            >
              撤销一笔
            </button>
          ) : (
            <button onClick={activate}>编辑白板</button>
          )}
        </div>
      )}
      <svg
        viewBox="0 0 1000 650"
        preserveAspectRatio="none"
        role="img"
        aria-label="白板画布"
        data-editable={!!change}
        onPointerDown={(e) => {
          if (!change || e.button !== 0 || current.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          current.current = { id: e.pointerId, points: [p, p] };
          draw(p + " " + p);
        }}
        onPointerMove={(e) => {
          const s = current.current;
          if (s?.id !== e.pointerId) return;
          const p = point(e);
          if (p !== s.points.at(-1)) {
            s.points.push(p);
            draw(s.points.join(" "));
          }
        }}
        onPointerUp={(e) => {
          if (current.current?.id === e.pointerId) finish();
        }}
        onPointerCancel={() => {
          current.current = null;
          draw("");
        }}
      >
        {[...strokes, ...(line ? [line] : [])].map((points, i) => (
          <polyline
            key={i}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </section>
  );
}
