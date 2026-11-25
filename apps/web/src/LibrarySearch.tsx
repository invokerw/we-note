import { useEffect, useRef, useState, type RefObject } from "react";

function literalPattern(term: string) {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}
export function MatchText({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(literalPattern(term))) {
    parts.push(
      text.slice(start, match.index),
      <mark key={match.index}>{match[0]}</mark>,
    );
    start = match.index + match[0].length;
  }
  return (
    <>
      {parts}
      {text.slice(start)}
    </>
  );
}

// Highlight rendered text without modifying the editor's DOM, selection or saved bytes.
export function useDocumentMatches(query: string, active: string) {
  useEffect(() => {
    const workspace = document.querySelector(".workspace");
    const term = query.trim();
    if (!workspace || !term || !active || !globalThis.CSS?.highlights) return;
    const pattern = literalPattern(term);
    let frame = 0;
    function paint() {
      const result = new Highlight();
      for (const surface of workspace!.querySelectorAll(
        ".document .reading, .document .ProseMirror, .document .cm-content, .document h1",
      )) {
        const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          for (const match of (n.nodeValue || "").matchAll(pattern)) {
            const range = new Range();
            range.setStart(n, match.index);
            range.setEnd(n, match.index + match[0].length);
            result.add(range);
          }
        }
      }
      CSS.highlights.set("note-search", result);
    }
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    });
    observer.observe(workspace, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    paint();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete("note-search");
    };
  }, [query, active]);
}
export function useRecentSearches(key: string) {
  const storageKey = "wenote-search:" + key;
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      return Array.isArray(stored)
        ? stored.filter((v) => typeof v === "string").slice(0, 8)
        : [];
    } catch {
      return [];
    }
  });
  function save(terms: string[]) {
    setRecent(terms);
    try {
      localStorage.setItem(storageKey, JSON.stringify(terms));
    } catch {
      /* History is optional in private browsing. */
    }
  }
  function remember(value: string) {
    const term = value.trim();
    if (term)
      save(
        [
          term,
          ...recent.filter((v) => v.toLowerCase() !== term.toLowerCase()),
        ].slice(0, 8),
      );
  }
  return { recent, remember, clear: () => save([]) };
}
export function SearchField({
  input,
  query,
  change,
  folder,
  currentOnly,
  setCurrentOnly,
  history,
}: {
  input: RefObject<HTMLInputElement | null>;
  query: string;
  change: (q: string) => void;
  folder: string | null;
  currentOnly: boolean;
  setCurrentOnly: (v: boolean) => void;
  history: ReturnType<typeof useRecentSearches>;
}) {
  const [shown, show] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shown) return;
    const outside = (event: MouseEvent) => {
      if (!field.current?.contains(event.target as Node)) show(false);
    };
    document.addEventListener("click", outside);
    return () => document.removeEventListener("click", outside);
  }, [shown]);
  return (
    <div
      className="note-search-field"
      ref={field}
      onBlur={(e) => {
        if (
          !e.currentTarget.contains(e.relatedTarget) &&
          !(
            e.relatedTarget instanceof Element &&
            e.relatedTarget.closest(".entry-row")
          )
        )
          show(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          input.current?.focus();
          show(false);
        }
      }}
    >
      <div className="note-search-input">
        <i aria-hidden="true" />
        <input
          ref={input}
          type="search"
          aria-label="搜索笔记"
          placeholder="搜索笔记"
          title="搜索笔记（Ctrl / ⌘ + Shift + F）"
          value={query}
          onFocus={() => show(true)}
          onClick={() => show(true)}
          onChange={(e) => {
            change(e.target.value);
            show(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              history.remember(query);
              show(false);
            }
          }}
        />
      </div>
      {shown && (
        <div className="note-search-options">
          <div className="recent-heading">
            最近搜索
            {history.recent.length > 0 && (
              <button
                type="button"
                onClick={history.clear}
                aria-label="清空最近搜索"
                title="清空最近搜索"
              >
                清空
              </button>
            )}
          </div>
          {history.recent.length ? (
            <div className="recent-terms">
              {history.recent.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => {
                    change(term);
                    history.remember(term);
                    input.current?.focus();
                  }}
                >
                  {term}
                </button>
              ))}
            </div>
          ) : (
            <small>暂无记录</small>
          )}
          <fieldset>
            <legend>搜索范围</legend>
            {folder && (
              <label>
                <input
                  type="radio"
                  name="note-search-scope"
                  checked={currentOnly}
                  onChange={() => setCurrentOnly(true)}
                />
                当前目录：{folder.slice(0, -1)}
              </label>
            )}
            <label>
              <input
                type="radio"
                name="note-search-scope"
                checked={!folder || !currentOnly}
                onChange={() => setCurrentOnly(false)}
              />
              全部笔记
            </label>
          </fieldset>
        </div>
      )}
    </div>
  );
}
