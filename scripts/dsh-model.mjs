import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';

const credentialPlugins = ['credentials', 'authorization', 'deepseek-account'];

function readRows(text, source, allowDshTags = false) {
  // YAML diagnostics can quote the source, including provider configuration.
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length || (!allowDshTags && doc.warnings.length)) throw new Error(`${source} 的 YAML 无法解析。`);
  const rows = doc.toJS() ?? [];
  if (!Array.isArray(rows)) throw new Error(`${source} 应为 DSH 配置条目列表。`);
  return rows;
}

function entry(rows, id) {
  const matches = rows.filter(row => row?.id === id);
  if (matches.length > 1) throw new Error(`发现多个 ${id} 条目，无法确定生效配置。`);
  return matches[0];
}

function selection(config) {
  if (![config?.provider, config?.model].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('DSH 默认模型缺少 provider 或 model。');
  }
  return config;
}

export function desktopModel(source) {
  if (source === 'headless') return null;
  if (!['auto', 'desktop'].includes(source)) throw new Error('--dsh-model-source 可选 auto、desktop 或 headless。');
  const path = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles/desktop/cordis.patch.yml');
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (source === 'auto') return null;
    throw new Error(`未找到桌面模型配置 ${path}`);
  }
  const rows = readRows(text, path);
  const modelRow = entry(rows, 'agent-default-model');
  if (!modelRow && source === 'auto') return null;
  if (!modelRow) throw new Error('请先在 DSH 桌面端保存默认模型。');
  const config = selection(modelRow.config);
  const providers = entry(rows, 'llm-pi-ai')?.config?.providers ?? {};
  const providerConfig = Object.hasOwn(providers, config.provider) ? providers[config.provider] : undefined;
  const patch = [{ id: 'agent-default-model', config }];
  let adapterId = 'llm-pi-ai';
  let adapterConfig = providerConfig;
  if (providerConfig !== undefined) {
    if (!providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) throw new Error('桌面提供方配置应为映射。');
    patch.push({ id: 'llm-pi-ai', disabled: false, config: { providers: { [config.provider]: providerConfig } } });
  } else if (['deepseek-official', 'deepseek-account'].includes(config.provider)) {
    adapterId = config.provider === 'deepseek-official' ? 'llm-deepseek' : 'llm-deepseek-account';
    adapterConfig = entry(rows, adapterId)?.config ?? {};
    patch.push({ id: adapterId, disabled: false, config: adapterConfig });
  } else {
    throw new Error('桌面配置缺少所选提供方的 llm-pi-ai 定义。使用其他模型插件时请配置 headless 并选择 --dsh-model-source headless。');
  }
  patch.push(...credentialPlugins.map(id => ({ id, disabled: false })));
  return { config, adapterId, adapterConfig, patch };
}

// Keep the selection for every round, but put its overlay on disk only while DSH runs.
export function withDshProfile(model, run) {
  const args = ['--profile', 'headless'];
  if (!model) return run(args);
  const dir = mkdtempSync(join(tmpdir(), 'we-note-dsh-'));
  try {
    const file = join(dir, 'model.yml');
    writeFileSync(file, JSON.stringify(model.patch), { mode: 0o600, flag: 'wx' });
    return run([...args, '--patch', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkModel(dsh, model) {
  const result = withDshProfile(model, args => spawnSync(dsh, [...args, '--dump-config'], { encoding: 'utf8' }));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DSH 无法组合 headless 配置（${result.signal ?? result.status}）。请检查所选 DSH 安装和 profile。`);
  // The shipped profile contains !!js expressions outside the model and credential rows.
  const rows = readRows(result.stdout, 'headless', true);
  const config = selection(entry(rows, 'agent-default-model')?.config);
  if (model) {
    const adapter = entry(rows, model.adapterId);
    const effectiveRoute = model.adapterId === 'llm-pi-ai' ? adapter?.config?.providers?.[config.provider] : adapter?.config ?? {};
    const routeMatches = adapter?.disabled === false && isDeepStrictEqual(effectiveRoute, model.adapterConfig);
    if (!isDeepStrictEqual(config, model.config) || !routeMatches ||
        !credentialPlugins.every(id => entry(rows, id)?.disabled === false)) {
      throw new Error('headless 合成结果与桌面模型或凭据配置不一致，请检查 headless profile 中的覆盖项。');
    }
  }
  console.log(`DSH 模型（${model ? '桌面默认' : 'headless 配置'}） ${config.provider} / ${config.model}`);
}
