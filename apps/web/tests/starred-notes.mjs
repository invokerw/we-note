import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error('Set WENOTE_TEST_ORIGIN to a disposable instance');
let token = '';
async function post(path, body) {
  const response = await fetch(`${origin}/api/v1/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const credentials = {email: `${randomUUID()}@example.invalid`, password: 'starred-notes-test'};
await post('auth/register', credentials);
token = (await post('auth/login', credentials)).access_token;
const {id} = await post('vaults', {name: '加星验收'});
const other = await post('vaults', {name: '另一个库'});
for (const [vault, path] of [[id,'当前.md'], [id,'工作/计划.md'], [id,'个人/计划.md'], [other.id,'工作/计划.md']]) {
  await post(`vaults/${vault}/files`, {path, content: Buffer.from(path).toString('base64')});
}
const browser = await chromium.launch({channel: 'chrome'});
try {
  const context = await browser.newContext({viewport: {width: 1360, height: 900}});
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(origin);
  await page.evaluate(t => sessionStorage.setItem('wenote-session', t), token);
  await page.goto(`${origin}/?vault=${id}`);
  const button = (scope, name) => scope.getByRole('button', {name, exact:true});
  const nav = page.locator('.sidebar');
  const list = page.getByRole('region', {name:'笔记列表'});
  const head = page.locator('.document-head');
  const row = path => list.locator(`[data-library-path="${path}"] .entry`);
  const stars = button(nav,'加星');
  async function menu(path, action) {
    await row(path).click({button:'right'});
    await page.getByRole('menuitem', {name:action, exact:true}).click();
  }
  await row('当前.md').click();
  await stars.click();
  await list.getByText('还没有加星的笔记', {exact:false}).waitFor();
  await button(nav,'全部笔记').click();
  await menu('工作/计划.md','加星');
  assert.equal(await button(head,'加星').getAttribute('aria-pressed'), 'false');
  await menu('个人/计划.md','加星');
  await stars.click();
  assert.equal(await button(list,'计划.md').count(), 2);
  await row('工作/计划.md').click();
  await button(head,'编辑模式').click();
  await button(page,'分屏编辑').click();
  const editor = page.getByLabel('笔记源码');
  await editor.fill('临时草稿');
  await editor.press('ArrowLeft');
  await button(head,'取消加星').click();
  await row('工作/计划.md').waitFor({state:'detached'});
  await page.keyboard.type('X');
  assert.equal(await editor.innerText(), '临时草X稿');
  await button(head,'加星').click();
  await menu('个人/计划.md','取消加星');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await stars.click();
  await row('工作/计划.md').waitFor();
  assert.equal(await button(list,'计划.md').count(), 1);
  await page.getByLabel('笔记库', {exact:true}).selectOption(other.id);
  await stars.click();
  await list.getByText('还没有加星的笔记', {exact:false}).waitFor();
  await page.getByLabel('笔记库', {exact:true}).selectOption(id);
  await stars.click();
  await menu('工作/计划.md','取消加星');
  await list.getByText('还没有加星的笔记', {exact:false}).waitFor();
  await button(nav,'全部笔记').click();
  await row('当前.md').click();
  await button(head,'加星').click();
  const phone = await context.newPage();
  phone.setDefaultTimeout(5000);
  await phone.setViewportSize({width: 390, height: 844});
  await phone.goto(origin);
  await phone.evaluate(t => sessionStorage.setItem('wenote-session', t), token);
  await phone.goto(`${origin}/?vault=${id}`);
  await button(phone,'打开笔记库目录').click();
  await button(phone.locator('.sidebar'),'加星').click();
  await button(phone,'当前.md').click();
  await button(phone.locator('.phone-document-head'),'取消加星').click();
  await button(head,'加星').waitFor();
  console.log('加星入口、右键目标、同名笔记、标题栏、草稿光标、刷新和切库通过');
} finally {
  await browser.close();
}
