import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('document actions respect the manifest, permissions and unique IDs', async () => {
  const server = await createServer({configFile:false, server:{middlewareMode:true, watch:null, hmr:false}, optimizeDeps:{noDiscovery:true}, appType:'custom'});
  try {
    const { documentActions } = await server.ssrLoadModule('/src/plugins/registry.ts');
    const edit = { id:'uppercase', label:'转为大写', kind:'edit' };
    const inspect = { id:'summary', label:'查看摘要', kind:'message' };
    const manifest = {capabilities:['parse', 'edit', 'serialize']};
    assert.deepEqual(documentActions(manifest), []);
    assert.deepEqual(documentActions({...manifest, actions:[edit, inspect]}), [edit, inspect]);
    assert.deepEqual(documentActions({capabilities:['parse'], actions:[inspect]}), [inspect]);
    for (const actions of [[edit, edit], [{...edit, id:'save.file'}], [{...edit, label:' '}], [null], {}, [{...edit,kind:'save'}]])
      assert.throws(() => documentActions({...manifest, actions}), /插件操作/);
    assert.throws(() => documentActions({capabilities:['parse'], actions:[edit]}), /编辑权限/);
  } finally { await server.close(); }
});
