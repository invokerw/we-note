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
import { Conversations, Prompts, Welcome, XProvider } from "@ant-design/x";
import zhCN from "@ant-design/x/es/locale/zh_CN";
import type { SenderRef } from "@ant-design/x/es/sender/interface";
import { NoteSender } from "./NoteSender";
import { ThreadMessages } from "./ThreadMessages";
import { Button } from "antd";
import { SettingOutlined, SendOutlined, StopOutlined } from "@ant-design/icons";
import { ModelPicker } from "./ModelPicker";
import { useCatalog } from "./useCatalog";
import { ModelSettings, missingKeyHint, gatewayNeedsKey } from "./Settings";
import {
  saveSelection,
  readConfig,
  loadCredential,
  modelSettingsKey,
} from "./credentials";
import type { Connection } from "./turn";
import "./assistant.css";
type Props = {
  credentialOwner: string;
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
    [summary, setSummary] = useState(""),
    [activeUser, setActiveUser] = useState<string>(),
    [stream, text] = useState(""),
    [draftPreview, setDraftPreview] = useState(""),
    [busy, setBusy] = useState(false),
    [applying, setApplying] = useState(false),
    [model, refresh] = useState(() => readConfig(props.credentialOwner));
  const [settings, setSettings] = useState(false),
    [revision, reload] = useState(0);
  const [effort, setEffort] = useState(""),
    [testing, setTesting] = useState(false);
  const { options, notice } = useCatalog(
    props.credentialOwner,
    model,
    open,
    revision,
  );
  const effectiveEffort = options
    .find((o) => o.id === model.model)
    ?.levels.includes(effort)
    ? effort
    : "";
  function selectModel(id: string) {
    const next = saveSelection(props.credentialOwner, model, id);
    if (next) {
      refresh(next);
      setEffort("");
      showError("");
      setStatus("");
    }
  }
  useEffect(() => {
    if (!model.model && options.length === 1 && !busy && !settings)
      selectModel(options[0].id);
  }, [model, options, busy, settings]);
  const current = useRef<Chat | undefined>(undefined),
    queue = useRef(Promise.resolve()),
    controller = useRef<AbortController | null>(null),
    pending = useRef<Pending | null>(null),
    applyingRef = useRef(false),
    mounted = useRef(true),
    sender = useRef<SenderRef>(null),
    follow = useRef(true),
    flow = useRef<HTMLDivElement>(null);
  const activeTurn = useRef<Promise<void> | null>(null);
  const selectedKey = "wenote-assistant-current:" + scope;
  function present(c: Chat) {
    if (current.current?.id !== c.id) follow.current = true;
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
      lines: [...c.lines, { id: crypto.randomUUID(), ...l }],
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
      setEffort("");
      setStatus("");
      showError("");
      reload((v) => v + 1);
      refresh(readConfig(props.credentialOwner));
    };
    window.addEventListener("wenote-model", changed);
    window.addEventListener("storage", changedConfig);
    function changedConfig(e: StorageEvent) {
      if (e.key === modelSettingsKey(props.credentialOwner)) changed();
    }
    return () => {
      window.removeEventListener("wenote-model", changed);
      window.removeEventListener("storage", changedConfig);
    };
  }, [props.credentialOwner]);
  useEffect(() => () => stop(), [connection.assistantGrant?.id]);
  useEffect(() => {
    if (open && follow.current && flow.current)
      flow.current.scrollTop = flow.current.scrollHeight;
  }, [
    open,
    list,
    chat?.id,
    chat?.lines.length,
    stream,
    summary,
    draftPreview,
    status,
  ]);
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
  useEffect(() => {
    if (!open) return;
    const back = (event: Event) => {
      event.preventDefault();
      const dropdown = document.querySelector(".ant-select-open input");
      if (dropdown instanceof HTMLElement) dropdown.blur();
      else if (settings)
        document
          .querySelector<HTMLButtonElement>(
            ".assistant-settings .ant-modal-close",
          )
          ?.click();
      else if (
        document.querySelector('.assistant-model-trigger[aria-expanded="true"]')
      )
        document
          .querySelector<HTMLButtonElement>(".assistant-model-trigger")
          ?.click();
      else if (list) setList(null);
      else setOpen(false);
    };
    window.addEventListener("wenote-assistant-back", back);
    return () => window.removeEventListener("wenote-assistant-back", back);
  }, [open, settings, list]);
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
    const userId = crypto.randomUUID();
    let partial = "",
      visibleSummary = "";
    let key = "";
    try {
      const config = checkedConfig({ ...model, effort: effectiveEffort });
      key = (await loadCredential(props.credentialOwner, config.baseUrl)).key;
      ctrl.signal.throwIfAborted();
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
          { id: userId, role: "user", text: prompt },
        ],
      }));
      setActiveUser(userId);
      follow.current = true;
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
        summary: (s) => {
          if (!ctrl.signal.aborted) {
            visibleSummary = s;
            setSummary(s);
          }
        },
        draft: (s) => {
          if (!ctrl.signal.aborted) setDraftPreview(s);
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
        const started = current.current?.lines.some((l) => l.id === userId);
        if (
          partial ||
          visibleSummary.trim() ||
          (ctrl.signal.aborted && started)
        )
          void append({
            role: "assistant",
            text: partial,
            summary: visibleSummary.trim() || undefined,
            interrupted: ctrl.signal.aborted,
          });
        if (!ctrl.signal.aborted) {
          const needsKey = gatewayNeedsKey(e, key);
          if (needsKey || effectiveEffort) {
            const c = current.current;
            if (
              c?.id === before.id &&
              !c.draft &&
              !partial &&
              c.lines.length === before.lines.length + 1
            ) {
              void update((latest) => ({
                ...latest,
                draft: before.draft,
                lines: latest.lines.slice(0, -1),
                title: before.title,
              }));
            }
            showError(needsKey ? missingKeyHint : String(e));
          } else showError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      if (controller.current === ctrl) controller.current = null;
      if (mounted.current) {
        text("");
        setSummary("");
        setActiveUser(undefined);
        setStatus("");
        setDraftPreview("");
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
  async function testConnection() {
    if (testing || busy) return;
    const ctrl = new AbortController();
    controller.current = ctrl;
    setTesting(true);
    showError("");
    setStatus("正在验证工具调用…");
    try {
      const config = checkedConfig({ ...model, effort: effectiveEffort });
      const { key } = await loadCredential(
        props.credentialOwner,
        config.baseUrl,
      );
      if (config.usesApiKey && !key) throw Error(missingKeyHint);
      const { testModel } = await import("./runtime");
      await testModel(config, key, ctrl.signal);
      if (!ctrl.signal.aborted) setStatus("可用于写笔记");
    } catch (e) {
      if (!ctrl.signal.aborted) {
        showError(String(e));
        setStatus("");
      }
    } finally {
      if (controller.current === ctrl) controller.current = null;
      setTesting(false);
    }
  }
  const locked = busy || applying || testing;
  const canSend =
    !!chat?.draft.trim() &&
    !!grant &&
    !!model.model &&
    !applying &&
    !testing &&
    (!busy || !!pending.current);
  const availableRefs = props.paths.filter(
    (p) => !p.endsWith("/") && !chat?.refs.includes(p),
  );
  const prompts = chat?.refs.length
    ? ["总结引用的笔记", "提炼笔记中的待办"]
    : ["起草一篇笔记", "列一份待办清单"];
  function fillDraft(value: string) {
    void update((c) => ({
      ...c,
      draft: c.draft ? `${c.draft}\n${value}` : value,
    }));
    sender.current?.focus();
  }
  if (!scope) return null;
  return (
    <XProvider locale={zhCN}>
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
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="7" />
              <path d="M10 6v4l3 2" />
            </svg>
          </button>
          <button
            title="新对话"
            aria-label="新对话"
            disabled={busy || applying || !chat}
            onClick={fresh}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 4v12M4 10h12" />
            </svg>
          </button>
          <Button
            type="text"
            aria-label="模型设置"
            title="模型设置"
            disabled={locked}
            onClick={() => setSettings(true)}
            icon={<SettingOutlined />}
          />
        </header>
        {settings && (
          <ModelSettings
            owner={props.credentialOwner}
            close={() => setSettings(false)}
          />
        )}

        {list ? (
          <div className="assistant-history">
            <h3>历史对话</h3>
            <Conversations
              activeKey={chat?.id}
              items={list.map((c) => ({
                key: c.id,
                label: (
                  <button
                    type="button"
                    aria-current={c.id === chat?.id ? "true" : undefined}
                  >
                    {c.title}
                    <small>{new Date(c.updated).toLocaleString()}</small>
                  </button>
                ),
              }))}
              onActiveChange={(id) => {
                const next = list.find((c) => c.id === id);
                if (next) {
                  present(next);
                  setList(null);
                  showError("");
                  setStatus("");
                }
              }}
            />
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
              onScroll={(e) => {
                const el = e.currentTarget;
                follow.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 32;
              }}
              role="log"
              aria-label="对话"
            >
              {!model.baseUrl && (
                <Button onClick={() => setSettings(true)}>配置模型服务</Button>
              )}
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
              {chat && !chat.lines.length && grant && model.baseUrl && (
                <>
                  <Welcome
                    variant="borderless"
                    title="想从哪里开始？"
                    description={
                      chat.refs.length
                        ? "围绕引用的笔记提问，或一起修改内容。"
                        : "把想法写成笔记，或引用已有笔记继续整理。"
                    }
                  />
                  <Prompts
                    vertical
                    items={prompts.map((label) => ({
                      key: label,
                      label,
                      disabled: !!chat.draft.trim(),
                    }))}
                    onItemClick={({ data }) => fillDraft(data.key as string)}
                  />
                </>
              )}
              {chat && (
                <ThreadMessages
                  lines={chat.lines}
                  activeUser={activeUser}
                  stream={stream}
                  summary={summary}
                  draft={draftPreview}
                  status={status}
                  canApply={(p) =>
                    !!grant?.write && grant.id === p.grant && !applying
                  }
                  applying={applying}
                  apply={(p) => void apply(p)}
                  discard={discard}
                  openFile={props.openFile}
                  reuse={fillDraft}
                  locked={locked}
                  feedback={(index, value) =>
                    void update((c) => ({
                      ...c,
                      lines: c.lines.map((l, i) =>
                        i === index ? { ...l, feedback: value } : l,
                      ),
                    }))
                  }
                />
              )}
              {status && !activeUser && <small role="status">{status}</small>}
            </div>
            {chat && (
              <div className="assistant-compose">
                <NoteSender
                  sender={sender}
                  draft={chat.draft}
                  refs={chat.refs}
                  all={chat.all}
                  availableRefs={availableRefs}
                  locked={locked}
                  references={references}
                  changeDraft={(value) =>
                    void update((c) => ({ ...c, draft: value }))
                  }
                  submit={() => {
                    if (canSend) void submit();
                  }}
                  footer={
                    <div className="assistant-sender-footer">
                      {model.baseUrl && (
                        <ModelPicker
                          id={model.model}
                          options={options}
                          notice={notice}
                          disabled={locked}
                          effort={effectiveEffort}
                          select={selectModel}
                          setEffort={setEffort}
                          reload={() => reload((v) => v + 1)}
                          test={() => void testConnection()}
                        />
                      )}
                      <div className="assistant-send-actions">
                        {busy && pending.current && chat.draft.trim() && (
                          <Button
                            size="small"
                            disabled={!canSend}
                            onClick={() => void submit()}
                          >
                            修改要求
                          </Button>
                        )}
                        {busy ? (
                          <Button
                            aria-label="停止"
                            title="停止"
                            disabled={applying}
                            icon={<StopOutlined />}
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
                          />
                        ) : (
                          <Button
                            type="primary"
                            aria-label="发送"
                            title="发送"
                            icon={<SendOutlined />}
                            disabled={!canSend}
                            onClick={() => void submit()}
                          />
                        )}
                      </div>
                    </div>
                  }
                />
                {notice && (
                  <small role="status">
                    {notice}{" "}
                    {notice.includes("Key") && (
                      <Button
                        size="small"
                        type="link"
                        disabled={locked}
                        onClick={() => setSettings(true)}
                      >
                        打开模型设置
                      </Button>
                    )}
                  </small>
                )}
              </div>
            )}
          </>
        )}
        {error && (
          <p className="assistant-error" role="alert">
            {error}{" "}
            {error.includes("Key") && (
              <Button
                type="link"
                size="small"
                disabled={locked}
                onClick={() => setSettings(true)}
              >
                打开模型设置
              </Button>
            )}
            {effectiveEffort && (
              <Button
                size="small"
                disabled={locked}
                onClick={() => setEffort("")}
              >
                改用默认
              </Button>
            )}
          </p>
        )}
      </aside>
    </XProvider>
  );
}
