import { Sender, Suggestion } from "@ant-design/x";
import type { SenderRef } from "@ant-design/x/es/sender/interface";
import type { ReactNode, Ref } from "react";

type Props = {
  sender: Ref<SenderRef>;
  draft: string;
  refs: string[];
  all: boolean;
  availableRefs: string[];
  locked: boolean;
  references: (refs: string[], all: boolean) => void;
  changeDraft: (value: string) => void;
  submit: () => void;
  footer: ReactNode;
};
export function NoteSender({
  sender,
  draft,
  refs,
  all,
  availableRefs,
  locked,
  references,
  changeDraft,
  submit,
  footer,
}: Props) {
  return (
    <Suggestion
      block
      items={availableRefs.map((path) => ({
        label: path,
        value: path,
      }))}
      onSelect={(path) => references([...refs, path], all)}
    >
      {({ onTrigger, onKeyDown, open: suggesting }) => (
        <Sender
          ref={sender}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return false;
            if (suggesting) {
              onKeyDown(e);
              if (e.defaultPrevented) return false;
            } else if (e.key === "@" && !locked && availableRefs.length) {
              e.preventDefault();
              onTrigger();
              return false;
            }
          }}
          header={
            <fieldset disabled={locked}>
              <select
                aria-label="引用笔记"
                value=""
                onChange={(e) => {
                  if (e.target.value)
                    references([...refs, e.target.value], all);
                }}
              >
                <option value="">＋ 引用笔记</option>
                {availableRefs.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              {refs.map((ref) => (
                <button
                  type="button"
                  key={ref}
                  title={"移除引用 " + ref}
                  onClick={() =>
                    references(
                      refs.filter((p) => p !== ref),
                      all,
                    )
                  }
                >
                  {ref} ×
                </button>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => references(refs, e.target.checked)}
                />
                搜索本库
              </label>
            </fieldset>
          }
          value={draft}
          aria-label="助手消息"
          placeholder="给笔记助手发消息…"
          autoSize={{ minRows: 2, maxRows: 5 }}
          onChange={changeDraft}
          onSubmit={submit}
          suffix={false}
          footer={footer}
        />
      )}
    </Suggestion>
  );
}
