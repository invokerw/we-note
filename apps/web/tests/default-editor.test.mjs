import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('matching enabled plugins precede the default text editor', async () => {
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, appType: 'custom' });
  let settings;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => settings, setItem: (_, value) => { settings = value; },
  } });
  try {
    const { handler, plugins, setEnabled, install } = await server.ssrLoadModule('/src/plugins/registry.ts');
    assert.deepEqual(plugins().map(p => p.manifest.name).sort(), ['Markdown', 'Mind Elixir', '默认文本编辑器'].sort());
    for (const name of ['a.txt', 'a.json', 'a.xmind', 'a.csv', 'folder.name/README'])
      assert.equal(handler(name).manifest.name, '默认文本编辑器');
    assert.equal(handler('notes.md').manifest.name, 'Markdown');
    assert.equal(handler('a.MIND.JSON').manifest.name, 'Mind Elixir');
    setEnabled('com.wenote.md', false);
    assert.equal(handler('notes.md').manifest.name, '默认文本编辑器');
    install({ manifest: { id: 'org.example.csv', file_extensions: ['.csv'] } });
    assert.equal(handler('a.CSV').manifest.id, 'org.example.csv');
    setEnabled('org.example.csv', false);
    assert.equal(handler('a.csv').manifest.name, '默认文本编辑器');
  } finally { delete globalThis.localStorage; await server.close(); }
});
