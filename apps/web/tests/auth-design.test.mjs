import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [main, library, webStyle, clientHtml, clientStyle, desktopScript, appIcon, mobileBackground, mobileForeground] = await Promise.all([
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/LibraryUI.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../../client/ui/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../client/ui/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../../client/ui/auth-style.js', import.meta.url), 'utf8'),
  readFile(new URL('../../client/src-tauri/icons/icon.svg', import.meta.url), 'utf8'),
  readFile(new URL('../../client/src-tauri/gen/android/app/src/main/res/drawable/ic_launcher_background.xml', import.meta.url), 'utf8'),
  readFile(new URL('../../client/src-tauri/gen/android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml', import.meta.url), 'utf8'),
]);

test('auth entry exposes day and night visual directions and the new brand mark', () => {
  for (const style of ['paper', 'night']) {
    assert.match(library, new RegExp(`id: "${style}"`));
    assert.match(webStyle, new RegExp(`auth-style-${style}`));
  }
  assert.doesNotMatch(library, /garden|花园/);
  assert.doesNotMatch(webStyle, /garden|花园/);
  assert.doesNotMatch(clientHtml, /garden|花园/);
  assert.doesNotMatch(clientStyle, /garden|花园/);
  assert.doesNotMatch(desktopScript, /garden|花园/);
  assert.match(main, /auth-style-\$\{authStyle\}/);
  assert.match(main, /auth-style-switcher/);
  assert.match(library, /brand-mark/);
  assert.match(webStyle, /brand-mark/);
  assert.match(library, /白昼/);
  assert.match(library, /黑夜/);
  assert.match(webStyle, /white-space: pre-line/);
  assert.match(clientStyle, /#e8f2fc/);
  assert.match(clientHtml, /auth-style-switcher/);
  assert.match(clientHtml, /brand-mark/);
  assert.match(appIcon, /linearGradient id="background"/);
  assert.match(appIcon, /linearGradient id="page"/);
  assert.match(appIcon, /#F5A16D/);
  assert.match(mobileBackground, /#FF4E82BC/);
  assert.match(mobileForeground, /#FFF5A16D/);
});
