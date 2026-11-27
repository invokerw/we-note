import { useEffect, useState } from "react";
import { Modal, Form, Input, Checkbox, Select } from "antd";
import { checkedConfig, type Config } from "./policy";
import { loadCredential, readConfig, saveModel } from "./credentials";
export const missingKeyHint =
  "请打开笔记助手右上角的模型设置，填写 API Key 并保存，然后重新发送。";
export function gatewayNeedsKey(error: unknown, key: string) {
  return (
    !key &&
    /\b401\b/.test(String(error)) &&
    /\bAPI_KEY_REQUIRED\b/i.test(String(error))
  );
}
export function ModelSettings({
  owner,
  close,
}: {
  owner: string;
  close: () => void;
}) {
  const [initial] = useState(() => readConfig(owner));
  const [url, setUrl] = useState(initial.baseUrl),
    [api, setApi] = useState(initial.api);
  const [key, setKey] = useState(""),
    [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    loadCredential(owner, initial.baseUrl)
      .then((saved) => {
        if (live) {
          setKey(saved.key);
          setRemember(saved.remembered);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [owner, initial]);
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const connection = checkedConfig(
        { api, baseUrl: url, model: "", usesApiKey: !!key.trim() },
        false,
      );
      if (connection.baseUrl === initial.baseUrl)
        connection.model = readConfig(owner).model;
      await saveModel(owner, connection, key.trim(), remember);
      window.dispatchEvent(new Event("wenote-model"));
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      className="assistant-settings"
      open
      title="模型设置"
      width={420}
      onCancel={() => {
        if (!busy) close();
      }}
      onOk={submit}
      okText="保存模型设置"
      okButtonProps={{ disabled: busy || !owner }}
      cancelText="取消"
    >
      <Form
        layout="vertical"
        disabled={busy}
        onFinish={submit}
        className="assistant-config"
      >
        <Form.Item
          label="服务地址"
          htmlFor="assistant-url"
          validateStatus={error ? "error" : undefined}
          help={error && <span role="alert">{error}</span>}
        >
          <Input
            id="assistant-url"
            autoFocus
            placeholder="http://localhost:11434/v1"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setKey("");
              setRemember(false);
              setError("");
            }}
          />
        </Form.Item>
        <Form.Item label="API Key（可选）" htmlFor="assistant-key">
          <Input.Password
            id="assistant-key"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Form.Item>
        <Checkbox
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        >
          在本机记住密钥
        </Checkbox>
        <details>
          <summary>高级设置</summary>
          <Form.Item label="接口协议" htmlFor="assistant-api">
            <Select<Config["api"]>
              id="assistant-api"
              value={api}
              onChange={setApi}
              options={[
                {
                  value: "openai-completions",
                  label: "OpenAI Chat Completions",
                },
                { value: "openai-responses", label: "OpenAI Responses" },
              ]}
            />
          </Form.Item>
        </details>
      </Form>
    </Modal>
  );
}
