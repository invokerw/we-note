import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

test('a rebuilt website serves the previous lazy module until a newer release replaces it', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wenote-web-release-')));
  const assets = join(root, 'dist/static');
  const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
  async function release(version) {
    await writeFile(join(root, 'turn.js'), `export const version = '${version}';`);
    await build({ root, configFile, logLevel: 'silent' });
    const files = await readdir(assets);
    for (const file of files.filter((name) => name.startsWith('turn-'))) {
      if ((await readFile(join(assets, file), 'utf8')).includes(version)) return file;
    }
    assert.fail('expected built chat module');
  }
  try {
    await writeFile(join(root, 'index.html'), '<script type="module" src="/app.js"></script>');
    await writeFile(join(root, 'app.js'), 'window.start = () => import("./turn.js");');
    const first = await release('first-release');
    const second = await release('second-release');
    assert((await readdir(assets)).includes(first));
    await release('second-release');
    assert((await readdir(assets)).includes(first));
    await release('third-release');
    assert((await readdir(assets)).includes(second));
    assert(!(await readdir(assets)).includes(first));
  } finally { await rm(root, { recursive: true, force: true }); }
});
