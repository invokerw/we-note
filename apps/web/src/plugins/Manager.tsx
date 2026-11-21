import { useRef, useState } from "react";
import {
  inspectPackage,
  install,
  permissionNames,
  plugins,
  setEnabled,
  uninstall,
  type Plugin,
} from "./registry";
export default function Manager() {
  const [items, list] = useState(plugins),
    [pending, setPending] = useState<Plugin | null>(null),
    [error, notify] = useState("");
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
      <h1>插件</h1>
      <label>
        安装本地插件包{" "}
        <input
          type="file"
          accept=".zip"
          onChange={async (e) => {
            const ticket = ++selection.current;
            const f = e.target.files?.[0];
            e.target.value = "";
            setPending(null);
            notify("");
            if (f)
              try {
                const candidate = await inspectPackage(f);
                if (ticket === selection.current) setPending(candidate);
              } catch (err) {
                if (ticket === selection.current) notify(String(err));
              }
          }}
        />
      </label>
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
            {p.manifest.file_extensions.join("、")} · API{" "}
            {p.manifest.api_version} · {p.source} ·{" "}
            {p.enabled ? "已启用" : "已禁用"}
          </p>
          <p>{permissions(p)}</p>
          {p.hash && <code>SHA-256 {p.hash}</code>}
          <div>
            <button
              aria-label={(p.enabled ? "禁用 " : "启用 ") + p.manifest.name}
              onClick={() =>
                change(() => setEnabled(p.manifest.id, !p.enabled))
              }
            >
              {p.enabled ? "禁用" : "启用"}
            </button>
            {p.wasm && (
              <button onClick={() => change(() => uninstall(p.manifest.id))}>
                卸载 {p.manifest.name}
              </button>
            )}
          </div>
        </section>
      ))}
    </article>
  );
}
