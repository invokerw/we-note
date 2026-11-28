import type { AgentTool } from "@earendil-works/pi-agent-core";
import skill from "../../../../skills/wenote-notes/SKILL.md?raw";
import { createAgent } from "./runtime";
import { parseCall, readOnly, type Call } from "../mcp/tools";
import type { useMcp } from "../mcp/Connections";
import {
  checkReference,
  prepareCreateArguments,
  prepareWrite,
  type Config,
} from "./policy";
import type { Chat, Line, Proposal } from "./history";
import { createWebSearchService, createWebSearchTools } from "./webSearch";
export type Connection = ReturnType<typeof useMcp>;
type Turn = {
  connection: Connection;
  chat: Chat;
  prompt: string;
  folder: string;
  config: Config;
  key: string;
  signal: AbortSignal;
  append: (line: Line) => void;
  text: (s: string) => void;
  summary: (s: string) => void;
  draft: (s: string) => void;
  status: (s: string) => void;
  propose: (p: Proposal) => Promise<Record<string, unknown>>;
};
export async function runTurn(t: Turn) {
  const grant = t.connection.assistantGrant;
  if (!grant) throw Error("请先授权当前库");
  const rpc = async (call: Call) => {
    t.signal.throwIfAborted();
    return (await t.connection.assistantRpc(grant.id, "tools/call", call))
      .structuredContent!;
  };
  const allowed = new Set<string>(),
    refs: { file_id: string; path: string }[] = [];
  for (const path of t.chat.refs) {
    let cursor: string | undefined;
    do {
      const result = await rpc({
        name: "search_notes",
        args: { query: path, cursor },
      });
      const row = (result.items as typeof refs).find((x) => x.path === path);
      if (row) {
        refs.push(row);
        allowed.add(row.file_id);
        break;
      }
      cursor = result.next_cursor as string | undefined;
    } while (cursor);
  }
  const list =
    (await t.connection.assistantRpc(grant.id, "tools/list")).tools ?? [];
  const tools: AgentTool[] = list
    .filter((x) => t.chat.all || x.name !== "search_notes")
    .map((tool) => ({
      name: tool.name,
      label: tool.description,
      description: tool.description,
      parameters: tool.inputSchema,
      prepareArguments:
        tool.name === "create_note" ? prepareCreateArguments : undefined,
      execute: async (_id, args) => {
        const call = parseCall(tool.name, args);
        checkReference(call.name, call.args, t.chat.all, allowed);
        t.signal.throwIfAborted();
        const readLabel =
          call.name === "search_notes" ? "搜索当前库" : "读取笔记";
        t.status(readOnly(call.name) ? `正在${readLabel}…` : "正在准备修改…");
        if (readOnly(call.name)) {
          const data = await rpc(call);
          if (call.name === "search_notes")
            t.append({ role: "tool", text: "已搜索当前库" });
          else
            t.append({
              role: "tool",
              text: "已读取",
              path: typeof data.path === "string" ? data.path : undefined,
            });
          return toolResult(data);
        }
        const note =
          "file_id" in call.args
            ? await rpc({
                name: "read_note",
                args: { file_id: call.args.file_id },
              })
            : undefined;
        if (typeof note?.path === "string")
          t.append({ role: "tool", text: "已读取", path: note.path });
        const branches = new Map<string, string>();
        let impact = "";
        if (call.name === "edit_mindmap") {
          const preview = await t.connection.assistantMapPreview(
            grant.id,
            call,
          );
          const rows = preview.nodes;
          if (
            preview.removedNodes ||
            preview.removedArrows ||
            preview.removedSummaries
          )
            impact = `\n受影响：删除 ${preview.removedNodes} 个节点、${preview.removedArrows} 条关联线、${preview.removedSummaries} 个摘要`;
          const labels = new Map(rows.map((n) => [n.node_id, n.topic]));
          for (const row of rows)
            branches.set(
              row.node_id,
              [...row.ancestors, row.node_id]
                .map((id) => labels.get(id))
                .join(" / ") + `（${row.child_count} 个子节点）`,
            );
        }
        const proposal = {
          ...prepareWrite(call, note, branches),
          grant: grant.id,
          status: "preview" as const,
        };
        proposal.summary += impact;
        const result = await t.propose(proposal);
        if (result.file_id) allowed.add(String(result.file_id));
        return toolResult(result);
      },
    }));
  const webSearch = createWebSearchService(t.config, t.key);
  if (webSearch)
    tools.push(
      ...createWebSearchTools(
        webSearch,
        t.signal,
        t.status,
        (line) => t.append(line),
      ),
    );
  let summary = "";
  const agent = createAgent(
    t.config,
    t.key,
    `${skill}\n你是 WeNote 内置笔记助手。用中文回复。用户确认写入后才能报告已保存。以工具回执为准。当前目录 ${JSON.stringify(t.folder)}。用户选中的引用 ${JSON.stringify(refs)}。`,
    tools,
    (value) => {
      if (!t.signal.aborted) {
        summary = value;
        t.summary(summary);
      }
    },
  );
  let consecutiveFailures = 0;
  let stopped = "";
  agent.finishTurn = ({ toolResults }) => {
    const failure = toolResults.find((result) => result.isError);
    if (!failure) {
      consecutiveFailures = 0;
      return;
    }
    const error =
      failure.content.find((block) => block.type === "text")?.text ||
      "工具执行失败";
    const [reason] = error.split("\n\nReceived arguments:");
    t.append({
      role: "tool",
      text: `${failure.toolName} 调用失败：${reason.slice(0, 300)}`,
    });
    if (++consecutiveFailures >= 2) {
      stopped = "工具连续两次调用失败，本轮已停止。请查看上方原因后重新发送。";
      return { action: "end" };
    }
    t.status("工具调用失败，正在尝试修正…");
  };
  const abort = () => agent.abort();
  t.signal.throwIfAborted();
  t.signal.addEventListener("abort", abort, { once: true });
  agent.subscribe((event) => {
    if (t.signal.aborted) return;
    if (event.type === "turn_start" && !consecutiveFailures) t.status("正在生成…");
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") t.text(update.delta);
      if (
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta"
      ) {
        const block = update.partial.content[update.contentIndex];
        if (block?.type === "toolCall") {
          const args = block.arguments;
          if (block.name === "create_note") {
            t.status(
              typeof args.path === "string"
                ? `正在起草 ${args.path}…`
                : "正在起草笔记…",
            );
            const body = args.kind === "mindmap" ? args.root_topic : args.text;
            if (typeof body === "string") t.draft(body);
          } else t.status(`正在准备调用 ${block.name}…`);
        }
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("");
      if (text || summary.trim())
        t.append({
          role: "assistant",
          text,
          summary: summary.trim() || undefined,
        });
      summary = "";
      t.summary("");
      t.text("");
      t.draft("");
    }
  });
  try {
    const past = t.chat.lines.slice(t.chat.contextStart).map((l) => ({
      role: l.role,
      text: l.text,
      path: l.path,
      proposal: l.proposal && {
        summary: l.proposal.summary,
        status: l.proposal.status,
        receipt: l.proposal.receipt,
      },
      sources: l.sources,
    }));
    await agent.prompt(
      past.length
        ? `以下 JSON 是此前对话记录：\n${JSON.stringify(past)}\n\n用户的新请求：${t.prompt}`
        : t.prompt,
    );
    t.signal.throwIfAborted();
    if (stopped) throw Error(stopped);
    if (agent.state.errorMessage) throw Error(agent.state.errorMessage);
  } finally {
    t.signal.removeEventListener("abort", abort);
  }
}
function toolResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    details: null,
  };
}
