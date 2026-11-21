import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
export default function Source({
  text,
  onChange,
  onSelect,
  label,
  focus = false,
  language = "markdown",
}: {
  text: string;
  onChange: (v: string) => void;
  onSelect: (start: number, end: number) => void;
  label: string;
  focus?: boolean;
  language?: "markdown" | "json";
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    props = useRef({ onChange, onSelect });
  props.current = { onChange, onSelect };
  useEffect(() => {
    const cm = new EditorView({
      parent: host.current!,
      doc: text,
      extensions: [
        basicSetup,
        language === "json" ? json() : markdown(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({
          "aria-label": label,
          role: "textbox",
          "aria-multiline": "true",
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) props.current.onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const s = u.state.selection.main;
            props.current.onSelect(s.from, s.to);
          }
        }),
      ],
    });
    view.current = cm;
    props.current.onSelect(0, 0);
    if (focus) cm.focus();
    return () => {
      cm.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const cm = view.current;
    if (cm && cm.state.doc.toString() !== text)
      cm.dispatch({
        changes: { from: 0, to: cm.state.doc.length, insert: text },
      });
  }, [text]);
  return <div className="source" ref={host} />;
}
