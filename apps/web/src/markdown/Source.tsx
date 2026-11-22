import { useEffect, useRef, type RefObject } from "react";
import { EditorView, placeholder } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { basicSetup, minimalSetup } from "codemirror";
import { Prec } from "@codemirror/state";
import { liveStyle } from "./liveStyle";

export default function Source({
  text,
  onChange,
  onSelect,
  label,
  focus = false,
  language = "markdown",
  editor,
  inline,
}: {
  text: string;
  onChange: (v: string) => void;
  onSelect: (start: number, end: number) => void;
  label: string;
  focus?: boolean;
  language?: "markdown" | "json";
  editor?: RefObject<EditorView | null>;
  inline?: {
    caret: number;
    keyDown: (event: KeyboardEvent, view: EditorView) => boolean;
  };
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    props = useRef({ onChange, onSelect, inline });
  props.current = { onChange, onSelect, inline };
  useEffect(() => {
    const cm = new EditorView({
      parent: host.current!,
      doc: text,
      selection: { anchor: Math.min(inline?.caret ?? 0, text.length) },
      extensions: [
        inline
          ? [
              minimalSetup,
              liveStyle,
              placeholder("开始写作…"),
              Prec.highest(
                EditorView.domEventHandlers({
                  keydown: (e, view) =>
                    !e.isComposing &&
                    !view.composing &&
                    (props.current.inline?.keyDown(e, view) ?? false),
                }),
              ),
            ]
          : basicSetup,
        language === "json" ? json() : markdown({ base: markdownLanguage }),
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
    if (editor) editor.current = cm;
    props.current.onSelect(
      cm.state.selection.main.from,
      cm.state.selection.main.to,
    );
    if (focus) cm.focus();
    return () => {
      if (editor?.current === cm) editor.current = null;
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
