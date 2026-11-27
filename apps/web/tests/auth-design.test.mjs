import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [main, library, webStyle, clientHtml] = await Promise.all([
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/LibraryUI.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../../client/ui/index.html', import.meta.url), 'utf8'),
]);

test('auth entry exposes three selectable visual directions and the new brand mark', () => {
  for (const style of ['paper', 'night', 'garden']) {
    assert.match(library, new RegExp(`id: "${style}"`));
    assert.match(webStyle, new RegExp(`auth-style-${style}`));
  }
  assert.match(main, /auth-style-\$\{authStyle\}/);
  assert.match(main, /auth-style-switcher/);
  assert.match(library, /brand-mark/);
  assert.match(webStyle, /brand-mark/);
  assert.match(clientHtml, /auth-style-switcher/);
  assert.match(clientHtml, /brand-mark/);
});
