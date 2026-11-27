import { useEffect, useState } from "react";
import { baseModels, withEfforts, type ModelOption } from "./catalog";
import { catalogVersion } from "./clientVersion";
import { loadCredential } from "./credentials";
import { modelFetch } from "./modelFetch";
import { checkedConfig, type Config } from "./policy";
import { missingKeyHint } from "./Settings";

export function useCatalog(
  owner: string,
  config: Config,
  open: boolean,
  revision: number,
) {
  const [options, setOptions] = useState<ModelOption[]>([]),
    [notice, setNotice] = useState("");
  const scope = JSON.stringify([
    owner,
    config.baseUrl,
    config.api,
    config.usesApiKey,
    open,
    revision,
  ]);
  const [loadedScope, setLoadedScope] = useState("");
  useEffect(() => {
    setLoadedScope(scope);
    const controller = new AbortController();
    const signal = controller.signal;
    setOptions([]);
    setNotice("");
    if (!open || !config.baseUrl) return;
    async function load() {
      const { baseUrl } = checkedConfig(config, false);
      const { key } = await loadCredential(owner, baseUrl);
      signal.throwIfAborted();
      if (config.usesApiKey && !key) throw Error(missingKeyHint);
      const get = modelFetch(baseUrl, key);
      const url = baseUrl + "/models";
      const request = (address: string) =>
        get(address, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        });
      setNotice("正在获取模型…");
      const response = await request(url);
      if (!response.ok) {
        if ([401, 403].includes(response.status))
          throw Error("无法获取模型，请在模型设置中检查 API Key。");
        if ([404, 405].includes(response.status))
          throw Error("此服务未提供模型列表，可手动输入模型 ID。");
        throw Error(`模型列表读取失败（HTTP ${response.status}）`);
      }
      const base = baseModels(await response.json());
      signal.throwIfAborted();
      setOptions(base);
      setNotice(base.length ? "" : "暂无可选模型，可手动输入模型 ID。");
      if (!base.length) return;
      try {
        const version = await catalogVersion();
        signal.throwIfAborted();
        const extended = await request(`${url}?client_version=${version}`);
        if (!extended.ok) return;
        const enriched = withEfforts(base, await extended.json());
        if (!signal.aborted) setOptions(enriched);
      } catch {
        /* extensions are optional on OpenAI-compatible gateways */
      }
    }
    void load().catch((e) => {
      if (!signal.aborted)
        setNotice(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [owner, config.baseUrl, config.api, config.usesApiKey, open, revision]);
  return loadedScope === scope
    ? { options, notice }
    : { options: [], notice: "" };
}
