import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  drawSelection,
  EditorView,
  highlightSpecialChars,
  keymap,
  placeholder,
} from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { basicSetup } from "codemirror";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, Prec } from "@codemirror/state";
import { liveStyle } from "./liveStyle";
import { liveKeys } from "./liveCommands";
import { livePreview } from "./livePreview";
import type { MarkdownIO } from "./MarkdownView";
import { changedRange } from "./textFile";

// Saving and uploading temporarily make the document inert. Restore its caret
// after React unlocks it, unless the user has focused something else.
export function resumeWriting(
  view: EditorView,
  trigger: Element | null = view.contentDOM,
) {
  requestAnimationFrame(() => {
    const active = view.root.activeElement;
    if (
      view.dom.isConnected &&
      (active === trigger || active === document.body)
    )
      view.focus();
  });
}

export function captureInsertion(view: EditorView | null) {
  if (!view) return;
  const { doc, selection } = view.state,
    trigger = view.root.activeElement;
  return (text: string) => {
    if (!view.dom.isConnected) return false;
    const { from, to } = (
      view.state.doc === doc ? selection : view.state.selection
    ).main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    resumeWriting(view, trigger);
    return true;
  };
}

export default function Source({
  text,
  onChange,
  label,
  focus = false,
  language = "markdown",
  editor,
  live = false,
  io,
}: {
  text: string;
  onChange: (v: string) => void;
  label: string;
  focus?: boolean;
  language?: "markdown" | "json";
  editor?: RefObject<EditorView | null>;
  live?: boolean;
  io?: MarkdownIO;
}) {
  const host = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null);
  const synced = useRef(text);
  const props = useRef({ onChange, io });
  props.current = { onChange, io };
  const compartment = useMemo(() => new Compartment(), []);
  const setup = useMemo(
    () => [
      live
        ? [
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            drawSelection(),
            highlightSpecialChars(),
            liveStyle,
            livePreview({
              get image() {
                return props.current.io?.image;
              },
              get link() {
                return props.current.io?.link;
              },
            }),
            Prec.highest(liveKeys),
            placeholder("开始写作…"),
          ]
        : basicSetup,
      EditorView.contentAttributes.of({
        "aria-label": label,
        role: "textbox",
        "aria-multiline": "true",
      }),
    ],
    [live, label],
  );
  useEffect(() => {
    const cm = new EditorView({
      parent: host.current!,
      doc: text,
      extensions: [
        compartment.of(setup),
        language === "json" ? json() : markdown({ base: markdownLanguage }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            synced.current = u.state.doc.toString();
            props.current.onChange(synced.current);
          }
        }),
      ],
    });
    view.current = cm;
    if (editor) editor.current = cm;
    return () => {
      if (editor?.current === cm) editor.current = null;
      cm.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    const cm = view.current;
    if (cm && compartment.get(cm.state) !== setup)
      cm.dispatch({ effects: compartment.reconfigure(setup) });
    if (focus) cm?.focus();
  }, [setup, focus]);
  useEffect(() => {
    const cm = view.current;
    if (!cm) return;
    const old = synced.current;
    if (old === text) return;
    const { start, oldEnd, newEnd } = changedRange(old, text);
    const { from, to } = cm.state.selection.main;
    cm.dispatch({
      changes: { from: start, to: oldEnd, insert: text.slice(start, newEnd) },
      selection:
        from === start && to === oldEnd ? { anchor: newEnd } : undefined,
    });
  }, [text]);
  return <div className="source" ref={host} />;
}
