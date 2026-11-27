import { useState, type ReactNode } from "react";
import { Actions, Bubble, Sources, Think, ThoughtChain } from "@ant-design/x";
import { EditOutlined } from "@ant-design/icons";
import { Button, Space } from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Line, Proposal } from "./history";

type Props = {
  lines: Line[];
  activeUser?: string;
  stream: string;
  summary: string;
  draft: string;
  status: string;
  canApply: (proposal: Proposal) => boolean;
  applying: boolean;
  locked: boolean;
  apply: (p: Proposal) => void;
  discard: (p: Proposal) => void;
  openFile: (path: string) => void;
  reuse: (text: string) => void;
  feedback: (index: number, value: Line["feedback"]) => void;
};
type Entry = { line: Line; index: number };
type Round = { key: string; user?: Line; entries: Entry[] };
function rounds(lines: Line[]): Round[] {
  const result: Round[] = [];
  lines.forEach((line, index) => {
    if (line.role === "user")
      result.push({ key: line.id ?? String(index), user: line, entries: [] });
    else {
      if (!result.length) result.push({ key: "legacy", entries: [] });
      result[result.length - 1].entries.push({ line, index });
    }
  });
  return result;
}
function Answer({
  text,
  summary,
  thinking,
}: {
  text: string;
  summary?: string;
  thinking?: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  return (
    <>
      {summary?.trim() && (
        <Think
          title="思考摘要"
          expanded={expanded ?? !!thinking}
          onExpand={setExpanded}
        >
          {summary}
        </Think>
      )}
      {text && (
        <div className="assistant-answer">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              img: ({ alt }) => <span>{alt}</span>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
    </>
  );
}
const proposalState = {
  preview: "等待确认",
  sending: "保存结果待核对",
  saved: "已保存",
  discarded: "已放弃",
  failed: "保存失败",
};
function ProposalCard({
  proposal: p,
  actions,
}: {
  proposal: Proposal;
  actions: Props;
}) {
  return (
    <div className="assistant-preview">
      <Button
        size="small"
        type="link"
        className="assistant-path"
        onClick={() => actions.openFile(p.path)}
      >
        {p.path}
      </Button>
      <pre>{p.summary}</pre>
      {(p.status === "preview" || p.status === "sending") && (
        <Space wrap>
          <Button
            size="small"
            type="primary"
            disabled={!actions.canApply(p)}
            onClick={() => actions.apply(p)}
          >
            {p.status === "sending" ? "核对保存结果" : "应用修改"}
          </Button>
          {p.status === "preview" && (
            <Button
              size="small"
              disabled={actions.applying}
              onClick={() => actions.discard(p)}
            >
              放弃
            </Button>
          )}
        </Space>
      )}
      {p.receipt && <small>{p.receipt}</small>}
    </div>
  );
}
function ReadSteps({ steps, live }: { steps: Entry[]; live: boolean }) {
  const chain = (
    <ThoughtChain
      items={steps.map(({ line, index }) => ({
        key: String(index),
        title: line.text,
        description: line.path,
        status: "success",
      }))}
    />
  );
  return steps.length > 1 && !live ? (
    <details>
      <summary>{steps.length} 个已完成步骤</summary>
      {chain}
    </details>
  ) : (
    chain
  );
}
function Reply({
  round,
  live,
  actions: p,
}: {
  round: Round;
  live: boolean;
  actions: Props;
}) {
  const paths = new Set<string>(),
    content: ReactNode[] = [];
  let steps: Entry[] = [];
  function flushSteps() {
    if (steps.length) {
      content.push(
        <ReadSteps key={`steps-${steps[0].index}`} steps={steps} live={live} />,
      );
      steps = [];
    }
  }
  for (const [position, entry] of round.entries.entries()) {
    const { line, index } = entry;
    if (
      line.role === "tool" &&
      !line.proposal &&
      (line.text === "已读取" || line.text === "已搜索当前库")
    ) {
      steps.push(entry);
      if (line.text === "已读取" && line.path) paths.add(line.path);
      continue;
    }
    flushSteps();
    if (line.role === "tool") {
      const proposal = line.proposal;
      const progress =
        proposal?.status === "failed" || line.text.includes("调用失败")
          ? "error"
          : proposal?.status === "preview" || proposal?.status === "sending"
            ? undefined
            : proposal?.status === "discarded"
              ? "abort"
              : "success";
      content.push(
        <div key={line.id ?? index}>
          <ThoughtChain
            items={[
              {
                key: "action",
                title: line.text,
                description: proposal
                  ? proposalState[proposal.status]
                  : line.path,
                status: progress,
              },
            ]}
          />
          {proposal && <ProposalCard proposal={proposal} actions={p} />}
        </div>,
      );
    } else {
      content.push(
        <Answer
          key={`answer-${position}`}
          text={line.text}
          summary={line.summary}
        />,
      );
      if (line.interrupted)
        content.push(<small key={`stop-${index}`}>本轮已停止</small>);
      if (line.text && !line.interrupted)
        content.push(
          <div className="assistant-answer-actions" key={`actions-${index}`}>
            <Actions.Copy text={line.text} />
            <Actions.Feedback
              value={line.feedback ?? "default"}
              onChange={(v) => p.feedback(index, v)}
            />
            {round.user && (
              <Button
                type="text"
                size="small"
                title="编辑原问题"
                aria-label="编辑原问题"
                disabled={p.locked}
                icon={<EditOutlined />}
                onClick={() => p.reuse(round.user!.text)}
              />
            )}
          </div>,
        );
    }
  }
  flushSteps();
  if (live)
    content.push(
      <Answer
        key={`answer-${round.entries.length}`}
        text={p.stream}
        summary={p.summary}
        thinking={!p.stream && !p.draft}
      />,
    );
  return (
    <div className="assistant-reply">
      {content}
      {live && p.draft && (
        <div className="assistant-preview" aria-label="正在起草的笔记">
          <pre>{p.draft}</pre>
        </div>
      )}
      {live && p.status && <small role="status">{p.status}</small>}
      {!!paths.size && (
        <Sources
          title={`本轮读取 · ${paths.size} 篇笔记`}
          defaultExpanded={false}
          items={Array.from(paths, (path) => ({ key: path, title: path }))}
          onClick={(item) => {
            if (typeof item.key === "string" && paths.has(item.key))
              p.openFile(item.key);
          }}
        />
      )}
    </div>
  );
}
export function ThreadMessages(p: Props) {
  return (
    <Bubble.List
      autoScroll={false}
      role={{
        user: { placement: "end" },
        assistant: { variant: "borderless" },
      }}
      items={rounds(p.lines).flatMap((round) => {
        const live = p.activeUser === round.key;
        return [
          ...(round.user
            ? [
                {
                  key: round.key,
                  role: "user",
                  content: (
                    <span className="assistant-line role-user">
                      {round.user.text}
                    </span>
                  ),
                },
              ]
            : []),
          ...(round.entries.length || live
            ? [
                {
                  key: `reply-${round.key}`,
                  role: "assistant",
                  content: <Reply round={round} live={live} actions={p} />,
                },
              ]
            : []),
        ];
      })}
    />
  );
}
