import { useState, useRef, useEffect, useLayoutEffect } from "react";
import {
  clearHistory,
  history,
  newChat,
  save,
  type Chat,
  type Line,
  type Proposal,
} from "./history";
import { checkedConfig } from "./policy";
import { readConfig, keyFor, missingKeyHint, gatewayNeedsKey } from "./Settings";
import type { Connection } from "./turn";
import "./assistant.css";
type Props = {
  connection: Connection;
  path: string;
  paths: string[];
  folder: string;
  openFile: (p: string) => void;
};
const actionNames: Record<string, string> = {
  create_note: "创建笔记",
  edit_note: "修改笔记",
  move_note: "移动笔记",
  delete_note: "移入回收站",
  edit_mindmap: "修改导图",
};
type Pending = {
  resolve: (r: Record<string, unknown>) => void;
  reject: (e: Error) => void;
};
function syncLabel(result: Record<string, unknown>) {
  return (
    (
      {
        synced: "已同步",
        pending: "已保存到本机，待同步",
        conflict: "同步有冲突",
      } as Record<string, string>
    )[String(result.sync_status)] ?? "已保存"
  );
}
export function AssistantPanel(props: Props) {
  const { connection } = props;
  const scope = connection.scope;
  const [open, setOpen] = useState(false),
    [chat, setChat] = useState<Chat>(),
    [list, setList] = useState<Chat[] | null>(null),
    [error, showError] = useState(""),
    [status, setStatus] = useState(""),
    [stream, text] = useState(""),
    [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [model, refresh] = useState(readConfig);
  const current = useRef<Chat | undefined>(undefined),
    queue = useRef(Promise.resolve()),
    controller = useRef<AbortController | null>(null),
    pending = useRef<Pending | null>(null),
    applyingRef = useRef(false),
    mounted = useRef(true),
    flow = useRef<HTMLDivElement>(null);
  const activeTurn = useRef<Promise<void> | null>(null);
  const selectedKey = "wenote-assistant-current:" + scope;
  function present(c: Chat) {
    current.current = c;
    setChat(c);
    localStorage.setItem(selectedKey, c.id);
  }
  function update(fn: (c: Chat) => Chat) {
    const old = current.current;
    if (!old) throw Error("对话尚未加载");
    const next = { ...fn(old), rev: old.rev + 1 };
    present(next);
    queue.current = queue.current.then(() => save(next));
    void queue.current.catch((e) => {
      if (mounted.current) showError(String(e));
    });
    return queue.current;
  }
  function append(l: Line) {
    return update((c) => ({
      ...c,
      lines: [...c.lines, l],
      updated: Date.now(),
    }));
  }
  function updateProposal(id: string, patch: Partial<Proposal>) {
    return update((c) => ({
      ...c,
      lines: c.lines.map((l) =>
        l.proposal &&
        "operation_id" in l.proposal.call.args &&
        l.proposal.call.args.operation_id === id
          ? { ...l, proposal: { ...l.proposal, ...patch } }
          : l,
      ),
    }));
  }
  function stop() {
    controller.current?.abort();
    pending.current?.reject(Error("本轮已停止"));
    pending.current = null;
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop();
    };
  }, []);
  useEffect(() => {
    if (!open || current.current) return;
    let live = true;
    history(scope)
      .then((rows) => {
        if (live)
          present(
            rows.find((c) => c.id === localStorage.getItem(selectedKey)) ??
              rows[0] ??
              newChat(scope, props.path),
          );
      })
      .catch((e) => showError(String(e)));
    return () => {
      live = false;
    };
  }, [open, scope]);
  useEffect(() => {
    const changed = () => {
      stop();
      refresh(readConfig());
    };
    window.addEventListener("wenote-model", changed);
    window.addEventListener("storage", changedConfig);
    function changedConfig(e: StorageEvent) {
      if (e.key === "wenote-assistant-model") changed();
    }
    return () => {
      window.removeEventListener("wenote-model", changed);
      window.removeEventListener("storage", changedConfig);
    };
  }, []);
  useEffect(() => () => stop(), [connection.assistantGrant?.id]);
  useEffect(() => {
    if (open && flow.current)
      flow.current.scrollTop = flow.current.scrollHeight;
  }, [chat?.lines.length, stream]);
  useEffect(() => {
    const id = connection.assistantGrant?.id;
    if (
      !open ||
      !id ||
      !chat?.lines.some(
        (l) =>
          l.proposal?.status === "sending" || l.proposal?.status === "saved",
      )
    )
      return;
    const chatId = chat.id;
    let live = true;
    async function reconcile() {
      if (!id || applyingRef.current) return;
      const lookup = await connection.assistantReceipts(id);
      if (!live || current.current?.id !== chatId || applyingRef.current)
        return;
      for (const line of current.current.lines) {
        const p = line.proposal;
        if (
          !p ||
          p.grant !== id ||
          !["sending", "saved"].includes(p.status) ||
          !("operation_id" in p.call.args)
        )
          continue;
        const op = p.call.args.operation_id,
          found = lookup(op);
        if (!found) continue;
        const status = found.error ? "failed" : "saved",
          receipt = found.error?.message ?? syncLabel(found.result);
        if (p.status !== status || p.receipt !== receipt)
          void updateProposal(op, { status, receipt });
      }
    }
    const refresh = () =>
      void reconcile().catch((e) => {
        if (live) showError(String(e));
      });
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      live = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [open, chat?.id, connection.assistantGrant?.id]);
  function fresh() {
    const c = newChat(scope, props.path);
    present(c);
    void update((x) => x);
    setList(null);
    showError("");
  }
  const grant = connection.assistantGrant;
  async function send() {
    const before = current.current,
      prompt = before?.draft.trim();
    if (
      !before ||
      !prompt ||
      !grant ||
      controller.current ||
      applyingRef.current
    )
      return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setBusy(true);
    showError("");
    setStatus("正在生成…");
    text("");
    let partial = "";
    let key = "";
    try {
      const config = checkedConfig(readConfig());
      key = keyFor(config);
      if (config.usesApiKey && !key) throw Error(missingKeyHint);
      const { runTurn } = await import("./turn").catch(() => {
        throw Error("聊天模块加载失败。请刷新页面，再发送草稿。");
      });
      ctrl.signal.throwIfAborted();
      const contextKey = JSON.stringify([
        grant.id,
        config.baseUrl,
        config.api,
        config.model,
      ]);
      const contextStart =
        before.contextKey === contextKey
          ? before.contextStart
          : before.lines.length;
      await update((c) => ({
        ...c,
        contextKey,
        contextStart,
        title: c.lines.length ? c.title : prompt.slice(0, 40),
        draft: c.draft === before.draft ? "" : c.draft,
        updated: Date.now(),
        lines: [
          ...c.lines.map((l) =>
            l.proposal?.status === "preview"
              ? {
                  ...l,
                  proposal: { ...l.proposal, status: "discarded" as const },
                }
              : l,
          ),
          { role: "user", text: prompt },
        ],
      }));
      await runTurn({
        connection,
        chat: { ...before, contextStart },
        prompt,
        folder: props.folder,
        config,
        key,
        signal: ctrl.signal,
        append: (l) => {
          if (!ctrl.signal.aborted) void append(l);
        },
        status: (s) => {
          if (!ctrl.signal.aborted) setStatus(s);
        },
        text: (s) => {
          if (!ctrl.signal.aborted) {
            partial = s ? partial + s : "";
            text(partial);
          }
        },
        propose: async (p) => {
          ctrl.signal.throwIfAborted();
          await append({
            role: "tool",
            text: actionNames[p.call.name],
            path: p.path,
            proposal: p,
          });
          ctrl.signal.throwIfAborted();
          setStatus("等待应用修改");
          return new Promise((resolve, reject) => {
            pending.current = { resolve, reject };
          });
        },
      });
    } catch (e) {
      if (mounted.current) {
        if (partial) void append({ role: "assistant", text: partial });
        if (!ctrl.signal.aborted) {
          if (gatewayNeedsKey(e, key)) {
            const c = current.current;
            if (
              c?.id === before.id && !c.draft && !partial &&
              c.lines.length === before.lines.length + 1
            ) {
              void update((latest) => ({
                ...latest,
                draft: before.draft,
                lines: latest.lines.slice(0, -1),
                title: before.title,
              }));
            }
            showError(missingKeyHint);
          } else showError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      if (controller.current === ctrl) controller.current = null;
      if (mounted.current) {
        text("");
        setStatus("");
        setBusy(false);
      }
    }
  }
  async function submit() {
    if (pending.current && !applyingRef.current) {
      const p = current.current?.lines
        .slice()
        .reverse()
        .find((l) => l.proposal?.status === "preview")?.proposal;
      if (p) discard(p);
      await activeTurn.current;
    }
    if (!controller.current && mounted.current) {
      const turn = send();
      activeTurn.current = turn;
      await turn;
    }
  }
  async function apply(p: Proposal) {
    if (
      applyingRef.current ||
      p.grant !== grant?.id ||
      !("operation_id" in p.call.args)
    )
      return;
    const id = p.call.args.operation_id;
    applyingRef.current = true;
    setApplying(true);
    showError("");
    try {
      await updateProposal(id, { status: "sending" });
      const result = (
        await connection.assistantRpc(p.grant, "tools/call", p.call)
      ).structuredContent!;
      const receipt = syncLabel(result);
      await updateProposal(id, {
        status: "saved",
        receipt,
        path: String(result.path ?? p.path),
      });
      pending.current?.resolve(result);
      pending.current = null;
    } catch (e) {
      const message = String(e);
      showError(message);
      const definitive =
        /FILE_VERSION_CONFLICT|EDITOR_DIRTY|TEXT_AMBIGUOUS|PATH_CONFLICT|ACCESS_DENIED|INVALID_|NOT_FOUND|HAS_CHILDREN|SUMMARY_RANGE_CONFLICT/.test(
          message,
        );
      await updateProposal(id, {
        status: definitive ? "failed" : "sending",
        receipt: message,
      }).catch(() => {});
      pending.current?.reject(Error(message));
      pending.current = null;
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }
  function discard(p: Proposal) {
    if ("operation_id" in p.call.args)
      void updateProposal(p.call.args.operation_id, { status: "discarded" });
    stop();
  }
  async function browse() {
    await queue.current;
    setList(await history(scope));
  }
  function references(refs: string[], all: boolean) {
    void update((c) => ({
      ...c,
      refs,
      all,
      contextStart: c.lines.length,
      lines: c.lines.map((l) =>
        l.proposal?.status === "preview"
          ? { ...l, proposal: { ...l.proposal, status: "discarded" } }
          : l,
      ),
    }));
  }
  if (!scope) return null;
  return (
    <>
      <button
        className="assistant-toggle"
        aria-label={open ? "收起笔记助手" : "展开笔记助手"}
        title={open ? "收起笔记助手" : "展开笔记助手"}
        aria-controls="note-assistant"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="2" y="3" width="16" height="14" rx="2" />
          <path d="M12 3v14" />
        </svg>
      </button>
      <aside
        hidden={!open}
        id="note-assistant"
        className="assistant-panel"
        aria-label="笔记助手"
      >
        <header>
          <strong>笔记助手</strong>
          <span />
          <button
            title="历史对话"
            aria-label="历史对话"
            disabled={busy || applying}
            onClick={() =>
              list
                ? setList(null)
                : void browse().catch((e) => showError(String(e)))
            }
          >
            ◷
          </button>
          <button
            title="新对话"
            aria-label="新对话"
            disabled={busy || applying || !chat}
            onClick={fresh}
          >
            ＋
          </button>
        </header>
        {list ? (
          <div className="assistant-history">
            <h3>历史对话</h3>
            {list.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  present(c);
                  setList(null);
                }}
              >
                {c.title}
                <small>{new Date(c.updated).toLocaleString()}</small>
              </button>
            ))}
            <button
              onClick={() => {
                if (confirm("清除本机当前库的全部助手对话？"))
                  void clearHistory(scope)
                    .then(fresh)
                    .catch((e) => showError(String(e)));
              }}
            >
              清除本库对话
            </button>
          </div>
        ) : (
          <>
            <div
              className="assistant-flow"
              ref={flow}
              role="log"
              aria-label="对话"
            >
              <small>
                {model.model
                  ? `${model.model} · ${model.baseUrl}`
                  : "请在个人设置 → 笔记助手中配置本机模型。"}
              </small>
              {!grant ? (
                <section>
                  <p>
                    提问、引用的笔记和本轮工具结果会发往所选模型服务。请选择当前库的访问权限。
                  </p>
                  <button
                    onClick={() =>
                      void connection
                        .authorizeAssistant(false)
                        .catch((e) => showError(String(e)))
                    }
                  >
                    授权只读
                  </button>
                  <button
                    onClick={() =>
                      void connection
                        .authorizeAssistant(true)
                        .catch((e) => showError(String(e)))
                    }
                  >
                    授权编辑
                  </button>
                </section>
              ) : (
                !grant.write && (
                  <button
                    onClick={() =>
                      void connection
                        .authorizeAssistant(true)
                        .catch((e) => showError(String(e)))
                    }
                  >
                    开启当前库编辑权限
                  </button>
                )
              )}
              {chat?.lines.map((l, i) => {
                const p = l.proposal;
                return (
                  <div key={i} className={"assistant-line role-" + l.role}>
                    <p>{l.text}</p>
                    {l.path && (
                      <button
                        className="assistant-path"
                        onClick={() => props.openFile(p?.path ?? l.path!)}
                      >
                        {p?.path ?? l.path}
                      </button>
                    )}
                    {p && (
                      <div className="assistant-preview">
                        <pre>{p.summary}</pre>
                        {p.status === "preview" || p.status === "sending" ? (
                          <>
                            <button
                              disabled={
                                !grant?.write ||
                                grant.id !== p.grant ||
                                applying
                              }
                              onClick={() => void apply(p)}
                            >
                              {p.status === "sending"
                                ? "核对保存结果"
                                : "应用修改"}
                            </button>
                            {p.status === "preview" && (
                              <button
                                disabled={applying}
                                onClick={() => discard(p)}
                              >
                                放弃
                              </button>
                            )}
                            {p.receipt && <p>{p.receipt}</p>}
                          </>
                        ) : (
                          <small>{p.receipt ?? "已放弃"}</small>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {stream && <p>{stream}</p>}
              {status && <small role="status">{status}</small>}
            </div>
            {chat && (
              <form
                className="assistant-compose"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <fieldset disabled={busy || applying}>
                  <select
                    aria-label="引用笔记"
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        references([...chat.refs, e.target.value], chat.all);
                    }}
                  >
                    <option value="">＋ 引用笔记</option>
                    {props.paths
                      .filter((p) => !chat.refs.includes(p) && !p.endsWith("/"))
                      .map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                  </select>
                  {chat.refs.map((ref) => (
                    <button
                      type="button"
                      key={ref}
                      title={"移除引用 " + ref}
                      onClick={() =>
                        references(
                          chat.refs.filter((p) => p !== ref),
                          chat.all,
                        )
                      }
                    >
                      {ref} ×
                    </button>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={chat.all}
                      onChange={(e) => references(chat.refs, e.target.checked)}
                    />
                    搜索本库
                  </label>
                </fieldset>
                <textarea
                  aria-label="助手消息"
                  placeholder="给笔记助手发消息…"
                  value={chat.draft}
                  onChange={(e) =>
                    void update((c) => ({ ...c, draft: e.target.value }))
                  }
                />
                {busy && pending.current && chat.draft.trim() && (
                  <button type="submit" disabled={applying}>
                    修改要求
                  </button>
                )}
                {busy ? (
                  <button
                    type="button"
                    disabled={applying}
                    onClick={() => {
                      const p = chat.lines
                        .slice()
                        .reverse()
                        .find(
                          (l) => l.proposal?.status === "preview",
                        )?.proposal;
                      if (p) discard(p);
                      else stop();
                    }}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={
                      applying || !chat.draft.trim() || !grant || !model.model
                    }
                  >
                    发送
                  </button>
                )}
              </form>
            )}
          </>
        )}
        {error && (
          <p className="assistant-error" role="alert">
            {error}
          </p>
        )}
      </aside>
    </>
  );
}
