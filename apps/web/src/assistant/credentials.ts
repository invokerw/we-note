import { deviceKey } from "../deviceKey";
import type { Config } from "./policy";

const legacyKey = "wenote-assistant-model";
const blank: Config = { api: "openai-completions", baseUrl: "", model: "" };
type Encrypted = { iv: number[]; data: number[] };
type Settings = { model: Config; savedKey?: Encrypted };
let session: { owner: string; url: string; key: string } | undefined;

export function modelSettingsKey(owner: string) {
  return `${legacyKey}:${owner}`;
}
function read(owner: string): Settings {
  const local = localStorage.getItem(modelSettingsKey(owner));
  if (local) return JSON.parse(local);
  return {
    model: JSON.parse(localStorage.getItem(legacyKey) || "null") ?? blank,
  };
}
export function readConfig(owner: string): Config {
  try {
    return read(owner).model;
  } catch {
    return blank;
  }
}
export function clearCredential() {
  session = undefined;
}

function algorithm(owner: string, url: string, iv: Uint8Array<ArrayBuffer>) {
  return {
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(JSON.stringify([owner, url])),
  };
}
export async function loadCredential(owner: string, url: string) {
  const saved = read(owner);
  if (owner && saved.savedKey && saved.model.baseUrl === url) {
    try {
      const { iv, data } = saved.savedKey;
      const wrappingKey = await deviceKey(false);
      const bytes = await crypto.subtle.decrypt(
        algorithm(owner, url, Uint8Array.from(iv)),
        wrappingKey,
        Uint8Array.from(data),
      );
      return { key: new TextDecoder().decode(bytes), remembered: true };
    } catch {
      throw Error(
        "无法读取本机密钥，请在「笔记助手 → 模型设置」重新填写 API Key 并保存。",
      );
    }
  }
  const key =
    session?.owner === owner && session.url === url ? session.key : "";
  return { key, remembered: false };
}
export async function saveModel(
  owner: string,
  model: Config,
  key: string,
  remember: boolean,
) {
  if (!owner) throw Error("请等待账号加载完成后保存。");
  const next: Settings = { model };
  if (remember && key) {
    const wrappingKey = await deviceKey(true);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      algorithm(owner, model.baseUrl, iv),
      wrappingKey,
      new TextEncoder().encode(key),
    );
    next.savedKey = { iv: [...iv], data: [...new Uint8Array(data)] };
  }
  localStorage.setItem(modelSettingsKey(owner), JSON.stringify(next));
  session = next.savedKey ? undefined : { owner, url: model.baseUrl, key };
}

export function saveSelection(owner: string, connection: Config, id: string) {
  const saved = read(owner);
  if (
    saved.model.baseUrl !== connection.baseUrl ||
    saved.model.api !== connection.api
  )
    return;
  saved.model = { ...saved.model, model: id };
  localStorage.setItem(modelSettingsKey(owner), JSON.stringify(saved));
  return saved.model;
}
