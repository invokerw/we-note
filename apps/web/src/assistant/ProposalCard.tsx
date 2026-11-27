import { Button, Space } from "antd";
import type { Proposal } from "./history";

type Props = {
  proposal: Proposal;
  canApply: boolean;
  applying: boolean;
  apply: (proposal: Proposal) => void;
  discard: (proposal: Proposal) => void;
  openFile: (path: string) => void;
};

function ChangedText({ before, after }: { before: string; after: string }) {
  const old = Array.from(before),
    next = Array.from(after);
  let start = 0,
    end = next.length,
    oldEnd = old.length;
  while (start < oldEnd && start < end && old[start] === next[start]) start++;
  while (oldEnd > start && end > start && old[oldEnd - 1] === next[end - 1]) {
    oldEnd--;
    end--;
  }
  return (
    <>
      {next.slice(0, start).join("")}
      <strong>{next.slice(start, end).join("")}</strong>
      {next.slice(end).join("")}
    </>
  );
}
export function ProposalCard({
  proposal: p,
  canApply,
  applying,
  apply,
  discard,
  openFile,
}: Props) {
  const edit = p.call.name === "edit_note" ? p.call.args.edit : undefined;
  return (
    <section aria-label="修改预览" className="assistant-preview">
      {p.call.name === "create_note" ? (
        <b title={p.path}>{p.path}</b>
      ) : (
        <button
          className="assistant-path"
          title={p.path}
          onClick={() => openFile(p.path)}
        >
          {p.path}
        </button>
      )}
      {edit?.mode === "replace_text" ? (
        <dl>
          <dt>原文</dt>
          <dd>{edit.old_text}</dd>
          <dt>改为</dt>
          <dd>
            {edit.new_text ? (
              <ChangedText before={edit.old_text} after={edit.new_text} />
            ) : (
              "（删除该段）"
            )}
          </dd>
        </dl>
      ) : (
        <pre>{p.summary}</pre>
      )}
      <Space wrap>
        <Button type="primary" disabled={!canApply} onClick={() => apply(p)}>
          {p.status === "sending" ? "核对保存结果" : "应用修改"}
        </Button>
        {p.status === "preview" && (
          <Button disabled={applying} onClick={() => discard(p)}>
            放弃
          </Button>
        )}
      </Space>
      {p.receipt && <small>{p.receipt}</small>}
    </section>
  );
}
