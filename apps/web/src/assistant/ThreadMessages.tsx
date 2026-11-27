import { useState, type ReactNode } from "react";
import { Actions, Bubble, Sources, Think, ThoughtChain } from "@ant-design/x";
import {
  EditOutlined,
  FileTextOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { ProposalCard } from "./ProposalCard";
import type { ThoughtChainItemType } from "@ant-design/x/es/thought-chain";
import { Button } from "antd";
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
  preview: "等待确认修改",
  sending: "保存结果待核对",
  saved: "修改已保存",
  discarded: "已放弃",
  failed: "保存失败",
};
function pending(p: Proposal) {
  return p.status === "preview" || p.status === "sending";
}
function stepFor(
  { line, index }: Entry,
  openFile: Props["openFile"],
): ThoughtChainItemType {
  const key = line.id ?? String(index),
    p = line.proposal;
  if (p)
    return {
      key,
      title: proposalState[p.status],
      icon: <SafetyCertificateOutlined />,
      status: (
        {
          saved: "success",
          failed: "error",
          discarded: "abort",
          sending: "loading",
          preview: undefined,
        } as const
      )[p.status],
      description: p.receipt,
      collapsible: !pending(p),
      content: !pending(p) && (
        <div>
          {p.status === "saved" ? (
            <Button type="link" size="small" onClick={() => openFile(p.path)}>
              {p.path}
            </Button>
          ) : (
            <span>{p.path}</span>
          )}
          <pre className="assistant-step-preview">{p.summary}</pre>
        </div>
      ),
    };
  if (line.text === "已读取" && line.path)
    return {
      key,
      title: `已读取${line.path.split("/").pop()}`,
      icon: <ReadOutlined />,
      status: "success",
      collapsible: true,
      content: line.path,
    };
  return {
    key,
    title: line.text,
    icon: <SearchOutlined />,
    status: line.text.includes("调用失败") ? "error" : "success",
    description: line.path,
  };
}
function ToolSteps({
  entries,
  live,
  actions,
}: {
  entries: Entry[];
  live: boolean;
  actions: Props;
}) {
  const steps = entries.filter(
    ({ line }, i) =>
      !(
        i > 0 &&
        line.text === "已读取" &&
        entries[i - 1].line.text === line.text &&
        entries[i - 1].line.path === line.path
      ),
  );
  const proposal = steps.at(-1)?.line.proposal;
  const chain = (
    <ThoughtChain
      items={steps.map((entry) => stepFor(entry, actions.openFile))}
    />
  );
  if (
    !live &&
    steps.every(({ line }) => line.text === "已读取" && line.path) &&
    !proposal
  ) {
    return steps.length > 1 ? (
      <details>
        <summary>{steps.length} 个已完成步骤</summary>
        {chain}
      </details>
    ) : null;
  }
  return (
    <>
      {chain}
      {proposal && pending(proposal) && (
        <>
          {proposal.call.name === "edit_note" &&
            proposal.call.args.edit.mode === "replace_text" && (
              <div>找到一处匹配的原文，请核对这次修改。</div>
            )}
          <ProposalCard
            proposal={proposal}
            canApply={actions.canApply(proposal)}
            applying={actions.applying}
            apply={actions.apply}
            discard={actions.discard}
            openFile={actions.openFile}
          />
        </>
      )}
    </>
  );
}
function AnswerActions({
  entry,
  user,
  actions,
}: {
  entry: Entry;
  user?: Line;
  actions: Props;
}) {
  return (
    <div className="assistant-answer-actions">
      <Actions.Copy text={entry.line.text} />
      <Actions.Feedback
        value={entry.line.feedback ?? "default"}
        onChange={(v) => actions.feedback(entry.index, v)}
      />
      {user && (
        <Button
          type="text"
          size="small"
          title="编辑原问题"
          aria-label="编辑原问题"
          disabled={actions.locked}
          icon={<EditOutlined />}
          onClick={() => actions.reuse(user.text)}
        />
      )}
    </div>
  );
}
function Reply({
  round,
  live,
  lastAction,
  actions: p,
}: {
  round: Round;
  live: boolean;
  lastAction?: Entry;
  actions: Props;
}) {
  const paths = new Set<string>(),
    content: ReactNode[] = [];
  let steps: Entry[] = [];
  function flushSteps() {
    if (steps.length) {
      content.push(
        <ToolSteps
          key={`steps-${steps[0].index}`}
          entries={steps}
          live={live}
          actions={p}
        />,
      );
      steps = [];
    }
  }
  for (const [position, entry] of round.entries.entries()) {
    const { line, index } = entry;
    if (line.role === "tool") {
      steps.push(entry);
      if (line.text === "已读取" && line.path && !line.proposal)
        paths.add(line.path);
      if (line.proposal) flushSteps();
      continue;
    }
    flushSteps();
    content.push(
      <Answer
        key={`answer-${position}`}
        text={line.text}
        summary={line.summary}
      />,
    );
    if (
      lastAction &&
      entry.index !== lastAction.index &&
      line.text &&
      !line.interrupted
    )
      content.push(
        <AnswerActions
          key={`actions-${index}`}
          entry={entry}
          user={round.user}
          actions={p}
        />,
      );
    if (line.interrupted)
      content.push(<small key={`stop-${index}`}>本轮已停止</small>);
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
      {live && p.status && p.status !== "等待应用修改" && (
        <small role="status">{p.status}</small>
      )}
      {!!paths.size && (
        <Sources
          title={`本轮读取 · ${paths.size} 篇笔记`}
          defaultExpanded={false}
          items={Array.from(paths, (path) => ({
            key: path,
            title: path,
            icon: <FileTextOutlined />,
          }))}
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
        const showActions =
          !live &&
          !round.entries.some(
            ({ line }) => line.proposal && pending(line.proposal),
          );
        const lastAction = showActions
          ? round.entries
              .slice()
              .reverse()
              .find(
                ({ line }) =>
                  line.role === "assistant" && line.text && !line.interrupted,
              )
          : undefined;
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
                  footer: lastAction && (
                    <AnswerActions
                      entry={lastAction}
                      user={round.user}
                      actions={p}
                    />
                  ),
                  content: (
                    <Reply
                      round={round}
                      live={live}
                      lastAction={lastAction}
                      actions={p}
                    />
                  ),
                },
              ]
            : []),
        ];
      })}
    />
  );
}
