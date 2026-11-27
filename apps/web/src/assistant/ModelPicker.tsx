import { Button, Input, Popover, Space } from "antd";
import {
  CheckOutlined,
  DownOutlined,
  ReloadOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import type { ModelOption } from "./catalog";

type Props = {
  id: string;
  options: ModelOption[];
  notice: string;
  disabled: boolean;
  effort: string;
  select: (id: string) => void;
  setEffort: (value: string) => void;
  reload: () => void;
  test: () => void;
};
const names: Record<string, string> = {
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "超高",
  none: "关闭",
};
const levelName = (level: string) => names[level] ?? level;
export function ModelPicker(p: Props) {
  const [open, setOpen] = useState(false),
    [step, setStep] = useState<"model" | "effort">("model"),
    [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null);
  const selected = p.options.find((m) => m.id === p.id);
  const levels = selected?.levels ?? [];
  const defaultValue = selected?.defaultLevel;
  const value = p.effort || defaultValue || levels[0];
  const index = Math.max(0, levels.indexOf(value));
  const display = p.effort ? levelName(p.effort) : "默认";
  const name = selected?.label || p.id || "选择模型";
  const grade =
    !p.effort && defaultValue ? `默认（${levelName(defaultValue)}）` : display;
  const label = levels.length ? `${name} · ${display}` : name;
  function changeOpen(next: boolean) {
    setOpen(next);
    setStep("model");
    setQuery("");
  }
  function close() {
    changeOpen(false);
    trigger.current?.focus();
  }
  function choose(id: string) {
    if (id !== p.id) p.select(id);
    if (p.options.find((m) => m.id === id)?.levels.length) setStep("effort");
    else close();
  }
  useEffect(() => {
    if (p.disabled) changeOpen(false);
  }, [p.disabled]);
  useEffect(() => {
    if (!open) return;
    const firstChoice =
      step === "effort"
        ? "input[type=range], .assistant-single-level"
        : 'button[aria-pressed="true"]';
    const option =
      panel.current?.querySelector<HTMLElement>(firstChoice) ??
      panel.current?.querySelector<HTMLElement>("button[aria-pressed], input");
    option?.focus({ preventScroll: true });
  }, [step, open]);
  const matches = p.options.filter((m) =>
    (m.id + " " + m.label).toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="assistant-model-controls">
      <Popover
        open={open && !p.disabled}
        onOpenChange={changeOpen}
        trigger="click"
        placement="topLeft"
        arrow={false}
        destroyOnHidden
        content={
          <section
            ref={panel}
            className="assistant-model-menu"
            role="dialog"
            aria-label={step === "model" ? "选择模型" : "选择推理等级"}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            {step === "model" || !selected || !levels.length ? (
              <>
                <Space.Compact>
                  <Input
                    aria-label="模型 ID"
                    placeholder="搜索或输入模型 ID"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onPressEnter={() => {
                      if (query.trim()) choose(query.trim());
                    }}
                  />
                  <Button
                    disabled={!query.trim()}
                    onClick={() => choose(query.trim())}
                  >
                    选用
                  </Button>
                </Space.Compact>
                <div className="assistant-model-rows">
                  {matches.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-label={m.id}
                      title={m.id}
                      aria-pressed={m.id === p.id}
                      onClick={() => choose(m.id)}
                    >
                      <span>
                        {m.label}
                        {m.id !== m.label && <small>{m.id}</small>}
                      </span>
                      {m.id === p.id && <CheckOutlined />}
                    </button>
                  ))}
                </div>
                {p.id && !selected && !p.notice && (
                  <small>{p.id} · 未在当前列表中</small>
                )}
                <Space>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={p.reload}
                  >
                    刷新列表
                  </Button>
                  <Button
                    size="small"
                    disabled={!p.id}
                    onClick={() => {
                      close();
                      p.test();
                    }}
                  >
                    测试连接
                  </Button>
                </Space>
              </>
            ) : (
              <div className="assistant-level-sheet">
                <strong aria-live="polite">{grade}</strong>
                <Button
                  size="small"
                  type="text"
                  aria-label="重新选择模型"
                  title={p.id}
                  onClick={() => setStep("model")}
                >
                  {name} <RightOutlined />
                </Button>
                <Button
                  type="text"
                  size="small"
                  className="assistant-level-reset"
                  aria-label="恢复默认推理等级"
                  title="恢复默认"
                  onClick={() => p.setEffort("")}
                  icon={<ReloadOutlined />}
                />
                {levels.length === 1 ? (
                  <Button
                    className="assistant-single-level"
                    onClick={() => p.setEffort(levels[0])}
                  >
                    {levelName(levels[0])}
                  </Button>
                ) : (
                  <div className="assistant-level-rail">
                    <div className="assistant-level-track">
                      <div
                        style={{
                          width: `${(index / (levels.length - 1)) * 100}%`,
                        }}
                      />
                      <span>
                        {levels.map((l) => (
                          <i key={l} />
                        ))}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={levels.length - 1}
                      step={1}
                      value={index}
                      aria-label="推理等级"
                      aria-valuetext={grade}
                      onChange={(e) =>
                        p.setEffort(levels[Number(e.target.value)])
                      }
                      onPointerUp={(e) =>
                        p.setEffort(levels[Number(e.currentTarget.value)])
                      }
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        }
      >
        <Button
          ref={trigger}
          size="small"
          type="text"
          className="assistant-model-trigger"
          aria-expanded={open}
          aria-label="选择聊天模型"
          aria-haspopup="dialog"
          aria-description={label}
          title={label}
          disabled={p.disabled}
        >
          <span>{label}</span>
          <DownOutlined />
        </Button>
      </Popover>
    </div>
  );
}
