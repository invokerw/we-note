import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import FilePickerButton from "../FilePickerButton";
import MarkdownSettings from "../markdown/Settings";
import { markdownPreferences, type UserPreferences } from "../preferences";
import {
  defaultEditorId,
  inspectPackage,
  install,
  permissionNames,
  plugins,
  setEnabled,
  uninstall,
  type Plugin,
} from "./registry";
function PluginSettingsDialog({ name, children, close }: {
  name: string;
  children: ReactNode;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog ref={dialog} className="plugin-settings-dialog" aria-labelledby="plugin-settings-title"
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}>
      <header>
        <h2 id="plugin-settings-title">{name} 设置</h2>
        <button aria-label={`关闭 ${name} 设置`} onClick={close}>×</button>
      </header>
      {children}
    </dialog>
  );
}

export default function Manager({
  preferences,
  updatePluginSetting,
}: {
  preferences: UserPreferences;
  updatePluginSetting: (pluginId: string, settings: unknown) => void;
}) {
  const [items, list] = useState(plugins),
    [pending, setPending] = useState<Plugin | null>(null),
    [settingsId, setSettingsId] = useState<string | null>(null),
    [error, notify] = useState("");
  const markdown = markdownPreferences(preferences);
  const panels: Partial<Record<string, ReactNode>> = {
    "com.wenote.md": (
      <MarkdownSettings
        value={markdown}
        onChange={(patch) => updatePluginSetting("com.wenote.md", { ...markdown, ...patch })}
      />
    ),
  };
  const selection = useRef(0);
  function change(fn: () => void) {
    try {
      fn();
      list(plugins());
      notify("");
    } catch (e) {
      notify(String(e));
    }
  }
  const permissions = (p: Plugin) =>
    p.manifest.capabilities.map((c) => permissionNames[c]).join("、");
  return (
    <article>
      <FilePickerButton
        label="安装本地插件包"
        accept=".zip"
        onSelect={async file => {
          const ticket = ++selection.current;
          setPending(null);
          notify("");
          try {
            const candidate = await inspectPackage(file);
            if (ticket === selection.current) setPending(candidate);
          } catch (err) {
            if (ticket === selection.current) notify(String(err));
          }
        }}
      />
      {error && <p role="alert">{error}</p>}
      {pending && (
        <section className="plugin-entry">
          <h2>
            确认安装 {pending.manifest.name} {pending.manifest.version}
          </h2>
          <p>申请权限 · {permissions(pending)}</p>
          <p>来源 · {pending.source}</p>
          <code>SHA-256 {pending.hash}</code>
          <p>适用格式 · {pending.manifest.file_extensions.join("、")}</p>
          <button
            onClick={() =>
              change(() => {
                install(pending);
                setPending(null);
              })
            }
          >
            授权并安装
          </button>
          <button onClick={() => setPending(null)}>取消</button>
        </section>
      )}
      {items.map((p) => (
        <section className="plugin-entry" key={p.manifest.id}>
          <h2>
            {p.manifest.name} <small>{p.manifest.version}</small>
          </h2>
          <p>
            {p.manifest.file_extensions.join("、") || "其他文本文件"} · API{" "}
            {p.manifest.api_version} · {p.source} ·{" "}
            {p.enabled ? "已启用" : "已禁用"}
          </p>
          <p>{permissions(p)}</p>
          {p.hash && <code>SHA-256 {p.hash}</code>}
          <div className="plugin-actions">
            {p.manifest.id !== defaultEditorId && <button
              aria-label={(p.enabled ? "禁用 " : "启用 ") + p.manifest.name}
              onClick={() =>
                change(() => setEnabled(p.manifest.id, !p.enabled))
              }
            >
              {p.enabled ? "禁用" : "启用"}
            </button>}
            {panels[p.manifest.id] && (
              <button
                aria-label={`${p.manifest.name} 设置`}
                aria-haspopup="dialog"
                onClick={() => setSettingsId(p.manifest.id)}
              >
                设置
              </button>
            )}
            {p.wasm && (
              <button onClick={() => change(() => uninstall(p.manifest.id))}>
                卸载 {p.manifest.name}
              </button>
            )}
          </div>
          {settingsId === p.manifest.id && (
            <PluginSettingsDialog name={p.manifest.name} close={() => setSettingsId(null)}>
              {panels[p.manifest.id]}
            </PluginSettingsDialog>
          )}
        </section>
      ))}
    </article>
  );
}
