import { useEffect, useRef, useState } from "react";
import { checkedConfig, type Config } from "./policy";
const storageKey = "wenote-assistant-model";
const blank: Config = { api: "openai-completions", baseUrl: "", model: "" };
let credential = { url: "", key: "" };
export function readConfig(): Config {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "null") ?? blank;
  } catch {
    return blank;
  }
}
export function clearCredential() {
  credential = { url: "", key: "" };
}
export function keyFor(c: Config) {
  return credential.url === c.baseUrl ? credential.key : "";
}
export function ModelSettings() {
  const [c, config] = useState(readConfig),
    [key, setKey] = useState(() => keyFor(c)),
    [notice, status] = useState(""),
    [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(test: boolean) {
    try {
      const checked = checkedConfig(c);
      if (test) {
        setBusy(true);
        status("正在验证工具调用…");
        controller.current = new AbortController();
        const { testModel } = await import("./runtime");
        await testModel(checked, key, controller.current.signal);
      }
      localStorage.setItem(storageKey, JSON.stringify(checked));
      credential = { url: checked.baseUrl, key };
      window.dispatchEvent(new Event("wenote-model"));
      status(test ? "可用于写笔记，模型设置已保存" : "本机模型设置已保存");
    } catch (e) {
      status(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="assistant-config" disabled={busy}>
      <legend>本机模型</legend>
      <label>
        接口协议
        <select
          value={c.api}
          onChange={(e) =>
            config({ ...c, api: e.target.value as Config["api"] })
          }
        >
          <option value="openai-completions">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
        </select>
      </label>
      <label>
        服务地址
        <input
          type="url"
          placeholder="http://localhost:11434/v1"
          value={c.baseUrl}
          onChange={(e) => {
            config({ ...c, baseUrl: e.target.value });
            setKey("");
          }}
        />
      </label>
      <label>
        模型 ID
        <input
          value={c.model}
          onChange={(e) => config({ ...c, model: e.target.value })}
        />
      </label>
      <label>
        API Key（可选，仅此会话）
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div>
        <button onClick={() => void submit(true)}>测试连接</button>{" "}
        <button onClick={() => void submit(false)}>保存模型设置</button>
      </div>
      <p role="status">{notice}</p>
    </fieldset>
  );
}
