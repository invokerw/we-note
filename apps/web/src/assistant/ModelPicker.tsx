import { Button, Input, Popover, Select, Space } from "antd";
import { DownOutlined, ReloadOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
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
export function ModelPicker(p: Props) {
  const [open, setOpen] = useState(false),
    [manual, setManual] = useState("");
  const selected = p.options.find((m) => m.id === p.id);
  useEffect(() => {
    if (p.disabled) setOpen(false);
  }, [p.disabled]);
  const choose = (id: string) => {
    p.select(id);
    setOpen(false);
  };
  return (
    <div className="assistant-model-controls">
      <Popover
        trigger="click"
        placement="topLeft"
        open={open && !p.disabled}
        onOpenChange={(v) => {
          setOpen(v);
          setManual("");
        }}
        content={
          <div
            className="assistant-model-menu"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.defaultPrevented) setOpen(false);
            }}
          >
            <Select
              aria-label="可用模型"
              placeholder="选择模型"
              value={p.id || undefined}
              showSearch={{ optionFilterProp: "label" }}
              onChange={choose}
              options={p.options.map((m) => ({
                value: m.id,
                label: m.label === m.id ? m.id : `${m.label} · ${m.id}`,
              }))}
            />
            {p.id && !selected && !p.notice && <small>未在当前列表中</small>}
            <Space.Compact>
              <Input
                aria-label="模型 ID"
                placeholder="手动输入模型 ID"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onPressEnter={() => {
                  if (manual.trim()) choose(manual.trim());
                }}
              />
              <Button
                disabled={!manual.trim()}
                onClick={() => choose(manual.trim())}
              >
                选用
              </Button>
            </Space.Compact>
            <Space>
              <Button size="small" icon={<ReloadOutlined />} onClick={p.reload}>
                刷新列表
              </Button>
              <Button
                size="small"
                disabled={!p.id}
                onClick={() => {
                  setOpen(false);
                  p.test();
                }}
              >
                测试连接
              </Button>
            </Space>
          </div>
        }
      >
        <Button
          size="small"
          type="text"
          className="assistant-model-trigger"
          aria-expanded={open}
          aria-label="选择聊天模型"
          title={p.id || "选择聊天模型"}
          disabled={p.disabled}
        >
          <span>{selected?.label || p.id || "选择模型"}</span>
          <DownOutlined />
        </Button>
      </Popover>
      {!!selected?.levels.length && (
        <Select
          size="small"
          variant="borderless"
          aria-label="推理等级"
          disabled={p.disabled}
          value={p.effort}
          onChange={p.setEffort}
          options={[
            {
              value: "",
              label: `默认${selected.defaultLevel ? `（${selected.defaultLevel}）` : ""}`,
            },
            ...selected.levels.map((value) => ({ value, label: value })),
          ]}
        />
      )}
    </div>
  );
}
