import { isMindMap, mindSuffix } from "./mindFile";
import { TextFile } from "../markdown/textFile";
import { base64 } from "../api";
import { decodeText, fromBase64, noteLimit, unpack } from "./archive";
const key = "wenote-plugins-v1";
export type Capability = "parse" | "edit" | "serialize" | "export";
export const permissionNames: Record<Capability, string> = {
  parse: "读取当前文件",
  edit: "编辑当前文档",
  serialize: "保存当前文件",
  export: "导出文件副本",
};
export type Manifest = {
  id: string;
  name: string;
  version: string;
  api_version: string;
  file_extensions: string[];
  capabilities: Capability[];
  entry?: { core: string };
};
export type Plugin = {
  manifest: Manifest;
  source: string;
  hash?: string;
  wasm?: string;
  enabled: boolean;
};
export const defaultEditorId = "com.wenote.txt";
const builtin: Plugin[] = [
  { id: "com.wenote.md", name: "Markdown", file_extensions: [".md"] },
  { id: "com.wenote.mind.json", name: "Mind Elixir", file_extensions: [mindSuffix] },
  { id: defaultEditorId, name: "默认文本编辑器", file_extensions: [] },
].map(format => ({
  manifest: {
    ...format,
    version: "1.0.0",
    api_version: "1",
    capabilities: ["parse", "edit", "serialize", "export"],
  },
  source: "随应用安装",
  enabled: true,
}));
type Settings = { disabled: string[]; packages: Plugin[] };
function settings(): Settings {
  return JSON.parse(
    localStorage.getItem(key) || '{"disabled":[],"packages":[]}',
  );
}
export function plugins() {
  const s = settings();
  return [...s.packages, ...builtin].map((p) => ({
    ...p,
    enabled: p.manifest.id === defaultEditorId || !s.disabled.includes(p.manifest.id),
  }));
}
export function handler(path: string) {
  const name = path.split("/").at(-1)!.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = isMindMap(name) ? mindSuffix : dot < 0 ? "" : name.slice(dot);
  const items = plugins();
  return items.find(p => p.enabled && p.manifest.file_extensions.includes(ext))
    ?? items.find(p => p.manifest.id === defaultEditorId)!;
}
export function handlerKey(path: string) {
  const plugin = handler(path);
  return `${plugin.manifest.id}:${plugin.hash || plugin.manifest.version}`;
}
export function openTextDocument(plugin: Plugin, bytes: Uint8Array): TextFile | null {
  if (plugin.manifest.id !== "com.wenote.md" && plugin.manifest.id !== defaultEditorId) return null;
  try {
    return new TextFile(decodeText(bytes));
  } catch {
    // Keep the original bytes available for download when text decoding fails.
    return null;
  }
}
export function setEnabled(id: string, enabled: boolean) {
  const s = settings();
  s.disabled = s.disabled.filter((k) => k !== id);
  if (!enabled) s.disabled.push(id);
  localStorage.setItem(key, JSON.stringify(s));
}
export function install(p: Plugin) {
  const s = settings();
  for (const old of s.packages)
    if (
      old.manifest.id !== p.manifest.id &&
      old.manifest.file_extensions.some((ext) =>
        p.manifest.file_extensions.includes(ext),
      )
    )
      throw Error("此格式已由其他本地插件注册，请先卸载该插件");
  s.packages = [
    p,
    ...s.packages.filter((old) => old.manifest.id !== p.manifest.id),
  ];
  s.disabled = s.disabled.filter((k) => k !== p.manifest.id);
  localStorage.setItem(key, JSON.stringify(s));
}
export function uninstall(id: string) {
  const s = settings();
  s.packages = s.packages.filter((p) => p.manifest.id !== id);
  s.disabled = s.disabled.filter((k) => k !== id);
  localStorage.setItem(key, JSON.stringify(s));
}
export async function inspectPackage(file: File): Promise<Plugin> {
  if (file.size > 512 * 1024) throw Error("插件包超过 512 KiB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = unpack(bytes, 512 * 1024, 32);
  if (!entries["manifest.json"] || !entries["core.wasm"])
    throw Error("缺少 manifest.json 或 core.wasm");
  const m: Manifest = JSON.parse(decodeText(entries["manifest.json"]));
  if (m.api_version !== "1")
    throw Error(`不兼容的插件 API ${m.api_version}，宿主支持版本 1`);
  if (
    typeof m.id !== "string" ||
    !/^([a-z][a-z0-9-]*\.)+[a-z][a-z0-9-]*$/.test(m.id) ||
    m.id.startsWith("com.wenote.") ||
    typeof m.name !== "string" ||
    !m.name.trim() ||
    typeof m.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(m.version) ||
    m.entry?.core !== "core.wasm"
  )
    throw Error("插件标识、版本或入口无效");
  if (
    !Array.isArray(m.file_extensions) ||
    !m.file_extensions.length ||
    m.file_extensions.some(ext => typeof ext !== "string" || (ext !== mindSuffix && !/^\.[a-z0-9][a-z0-9_-]*$/.test(ext)))
  )
    throw Error("此宿主不支持清单中的文件扩展名");
  if (
    !Array.isArray(m.capabilities) ||
    !m.capabilities.includes("parse") ||
    m.capabilities.some((c) => !Object.hasOwn(permissionNames, c)) ||
    m.capabilities.includes("edit") !== m.capabilities.includes("serialize")
  )
    throw Error("权限不受支持，编辑和保存权限须同时声明");
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const plugin = {
    manifest: m,
    source: file.name,
    hash,
    wasm: base64(entries["core.wasm"]),
    enabled: true,
  };
  await invoke(plugin, "check", new Uint8Array());
  return plugin;
}
export function invoke(
  plugin: Plugin,
  op: "open" | "serialize" | "check",
  input: Uint8Array,
): Promise<Uint8Array> {
  if (
    !plugin.wasm ||
    input.length > noteLimit ||
    (op === "serialize" && !plugin.manifest.capabilities.includes("serialize"))
  )
    throw Error("插件权限或输入大小无效");
  if (
    op !== "check" &&
    !plugins().some(
      (p) =>
        p.enabled &&
        p.hash === plugin.hash &&
        p.manifest.id === plugin.manifest.id,
    )
  )
    throw Error("此插件已禁用或更新，请重新打开文件");
  const worker = new Worker(new URL("./wasm.worker.ts", import.meta.url), {
    type: "module",
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => end(Error("插件执行超时")), 2500);
    function end(error?: Error, result?: Uint8Array) {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(error);
      else resolve(result ?? new Uint8Array());
    }
    worker.onerror = (e) => end(Error(e.message || "插件运行失败"));
    worker.onmessage = ({ data }) =>
      end(data.error ? Error(data.error) : undefined, data.output);
    worker.postMessage({
      code: fromBase64(plugin.wasm!),
      required: plugin.manifest.capabilities.includes("serialize")
        ? ["open", "serialize"]
        : ["open"],
      op,
      input,
    });
  });
}
