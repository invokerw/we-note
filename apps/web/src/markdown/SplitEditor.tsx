import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type { EditorView } from "@codemirror/view";

// Match block starts in the two layouts. Interpolate inside long paragraphs and
// code blocks, where wrapping can give the same text very different heights.
function correspondingScroll(
  cm: EditorView,
  preview: HTMLElement,
  fromSource: boolean,
) {
  const source = cm.scrollDOM;
  const limit = (el: HTMLElement) => el.scrollHeight - el.clientHeight;
  const sourceEnd = limit(source),
    previewEnd = limit(preview);
  const position = fromSource ? source.scrollTop : preview.scrollTop;
  if (position <= 0 || sourceEnd <= 0 || previewEnd <= 0) return 0;
  const sourceTop = source.getBoundingClientRect().top - source.scrollTop;
  const previewTop = preview.getBoundingClientRect().top - preview.scrollTop;
  const docTop = cm.documentTop - sourceTop;
  const blocks = preview.querySelectorAll<HTMLElement>(
    ".reading > [data-block-start]",
  );
  let before = [0, 0],
    after = [sourceEnd, previewEnd];
  const axis = fromSource ? 0 : 1,
    other = 1 - axis;
  let lo = 0,
    hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1,
      block = blocks[mid];
    const at = Math.min(cm.state.doc.length, Number(block.dataset.blockStart));
    const point = [
      cm.lineBlockAt(at).top + docTop,
      block.getBoundingClientRect().top - previewTop,
    ];
    if (
      point[0] >= sourceEnd ||
      point[1] >= previewEnd ||
      point[axis] > position
    ) {
      if (point[0] < sourceEnd && point[1] < previewEnd) after = point;
      hi = mid;
    } else {
      before = point;
      lo = mid + 1;
    }
  }
  const fraction = Math.min(
    1,
    (position - before[axis]) / Math.max(1, after[axis] - before[axis]),
  );
  return before[other] + fraction * (after[other] - before[other]);
}

export default function SplitEditor({
  editor,
  source,
  children,
}: {
  editor: RefObject<EditorView | null>;
  source: ReactNode;
  children: ReactNode;
}) {
  const split = Boolean(children);
  const container = useRef<HTMLDivElement>(null),
    preview = useRef<HTMLDivElement>(null);
  const [linked, setLinked] = useState(true),
    [ratio, setRatio] = useState(50);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    if (!split) return;
    const el = container.current!;
    const observer = new ResizeObserver(() => setStacked(el.clientWidth < 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, [split]);
  useEffect(() => {
    const cm = editor.current,
      paper = preview.current;
    if (!split || !linked || !cm || !paper) return;
    const source = cm.scrollDOM;
    const expected = new Map<HTMLElement, number>();
    function sync(from: HTMLElement, to: HTMLElement) {
      if (Math.abs(from.scrollTop - (expected.get(from) ?? -10)) < 1) return;
      to.scrollTop = correspondingScroll(cm!, paper!, from === source);
      expected.set(to, to.scrollTop);
      expected.delete(from);
    }
    const left = () => sync(source, paper),
      right = () => sync(paper, source);
    left();
    source.addEventListener("scroll", left, { passive: true });
    paper.addEventListener("scroll", right, { passive: true });
    return () => {
      source.removeEventListener("scroll", left);
      paper.removeEventListener("scroll", right);
    };
  }, [split, linked, editor]);
  const resize = (value: number) =>
    setRatio(Math.round(Math.max(25, Math.min(75, value))));
  return (
    <div
      className={split ? "split-editor" : "source-editor"}
      ref={container}
      data-stacked={stacked}
      style={{ "--split": `${ratio}%` } as CSSProperties}
    >
      <section className="split-pane" aria-label="源码栏">
        <header hidden={!split}>Markdown 源码</header>
        {source}
      </section>
      <div
        hidden={!split}
        className="split-divider"
        role="separator"
        tabIndex={0}
        aria-label="调整分屏比例"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={ratio}
        onDoubleClick={() => resize(50)}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
          const box = container.current!.getBoundingClientRect();
          resize(
            100 *
              (stacked
                ? (e.clientY - box.top) / box.height
                : (e.clientX - box.left) / box.width),
          );
        }}
        onKeyDown={(e) => {
          const step = stacked
            ? ["ArrowUp", "ArrowDown"]
            : ["ArrowLeft", "ArrowRight"];
          if (step.includes(e.key)) {
            e.preventDefault();
            resize(ratio + (e.key === step[0] ? -5 : 5));
          }
          if (e.key === "Home" || e.key === "End") {
            e.preventDefault();
            resize(e.key === "Home" ? 25 : 75);
          }
        }}
      />
      <section hidden={!split} className="split-pane" aria-label="预览栏">
        <header>
          实时预览
          <button aria-pressed={linked} onClick={() => setLinked(!linked)}>
            同步滚动
          </button>
        </header>
        <div className="split-preview" ref={preview}>
          {children}
        </div>
      </section>
    </div>
  );
}
