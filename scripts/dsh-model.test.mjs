import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { desktopModel, withDshProfile } from './dsh-model.mjs';

function desktopFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'we-note-test-home-'));
  const original = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  t.after(() => {
    if (original === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, 'profiles/desktop/cordis.patch.yml');
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

test('overlay keeps the selected gateway and credential plugins through a retry', t => {
  const file = desktopFixture(t);
  const route = { apiKeyEnv: 'TEST_GATEWAY_KEY', models: [{ id: 'a/b' }] };
  const config = { provider: 'gateway', model: 'a/b', reasoningEffort: 'high' };
  writeFileSync(file, JSON.stringify([
    { id: 'ui-chat', config: { enabled: true } },
    { id: 'llm-pi-ai', config: { providers: { gateway: route, other: {} } } },
    { id: 'agent-default-model', config },
  ]));
  const model = desktopModel('auto');
  writeFileSync(file, '[]');
  let lastPath;
  function inspect(args) {
    assert.deepEqual(args.slice(0, -1), ['--profile', 'headless', '--patch']);
    lastPath = args.at(-1);
    assert.equal(statSync(lastPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(lastPath, 'utf8')), [
      { id: 'agent-default-model', config },
      { id: 'llm-pi-ai', disabled: false, config: { providers: { gateway: route } } },
      ...['credentials', 'authorization', 'deepseek-account'].map(id => ({ id, disabled: false })),
    ]);
  }
  withDshProfile(model, inspect);
  assert.ok(!existsSync(lastPath));
  assert.throws(() => withDshProfile(model, args => { inspect(args); throw new Error('test failure'); }), /test failure/);
  assert.ok(!existsSync(lastPath));
});

test('missing selection allows native mode, and broken desktop settings stop auto selection', t => {
  const file = desktopFixture(t);
  assert.equal(desktopModel('auto'), null);
  assert.throws(() => desktopModel('desktop'), /未找到/);
  writeFileSync(file, '[]');
  assert.equal(desktopModel('auto'), null);
  assert.throws(() => desktopModel('desktop'), /保存默认模型/);
  writeFileSync(file, '- id: agent-default-model\n  config: { provider: gateway, model: example }');
  assert.throws(() => desktopModel('auto'), /提供方/);
  writeFileSync(file, 'broken: [');
  assert.throws(() => desktopModel('auto'), /YAML/);
  assert.deepEqual(withDshProfile(desktopModel('headless'), args => args), ['--profile', 'headless']);
});
