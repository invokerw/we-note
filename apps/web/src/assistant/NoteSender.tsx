import { Sender, Suggestion, type SenderProps } from "@ant-design/x";
import type { SenderRef } from "@ant-design/x/es/sender/interface";
import { useState, type Ref } from "react";
import { Button, Checkbox, Popover, Tag } from "antd";
import {
  CloseOutlined,
  FileTextOutlined,
  PaperClipOutlined,
} from "@ant-design/icons";

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
  footer: SenderProps["footer"];
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
  const [choosing, setChoosing] = useState(false);
  return (
    <>
      <div className="assistant-reference-bar">
        {refs.map((path) => (
          <Tag
            key={path}
            bordered={false}
            title={path}
            icon={<FileTextOutlined />}
          >
            <span className="assistant-reference-name">{path}</span>
            <button
              type="button"
              title={`移除引用 ${path}`}
              aria-label={`移除引用 ${path}`}
              disabled={locked}
              onClick={() =>
                references(
                  refs.filter((p) => p !== path),
                  all,
                )
              }
            >
              <CloseOutlined />
            </button>
          </Tag>
        ))}
        <Popover
          trigger="click"
          placement="topLeft"
          open={choosing && !locked}
          onOpenChange={setChoosing}
          content={
            <div className="assistant-reference-options">
              <select
                aria-label="引用笔记"
                value=""
                disabled={locked}
                onChange={(e) => {
                  if (e.target.value) {
                    references([...refs, e.target.value], all);
                    setChoosing(false);
                  }
                }}
              >
                <option value="">选择笔记</option>
                {availableRefs.map((path) => (
                  <option key={path}>{path}</option>
                ))}
              </select>
              <Checkbox
                checked={all}
                disabled={locked}
                onChange={(e) => references(refs, e.target.checked)}
              >
                搜索本库
              </Checkbox>
            </div>
          }
        >
          <Button
            size="small"
            type="text"
            className="assistant-reference-trigger"
            icon={<PaperClipOutlined />}
            aria-label="管理引用"
            title="引用笔记与搜索范围"
            aria-expanded={choosing && !locked}
            disabled={locked}
          >
            {all ? "搜索本库" : refs.length ? undefined : "引用笔记"}
          </Button>
        </Popover>
      </div>
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
            submitType="enter"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
                e.stopPropagation();
                return false;
              }
              // Suggestion's outer combobox consumes Space and Enter on bubble.
              if (
                e.key === " " ||
                (e.key === "Enter" && (!suggesting || e.shiftKey))
              ) {
                e.stopPropagation();
                if (suggesting) onTrigger(false);
                return;
              }
              if (suggesting) {
                onKeyDown(e);
                if (e.defaultPrevented) return false;
              } else if (e.key === "@" && !locked && availableRefs.length) {
                e.preventDefault();
                onTrigger();
                return false;
              }
            }}
            value={draft}
            aria-label="助手消息"
            placeholder="发消息，Enter 发送，Shift + Enter 换行"
            autoSize={{ minRows: 1, maxRows: 5 }}
            onChange={changeDraft}
            onSubmit={submit}
            suffix={false}
            footer={footer}
          />
        )}
      </Suggestion>
    </>
  );
}
