import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error('Set WENOTE_TEST_ORIGIN to a disposable server');
let browser, token;
async function api(route, method, body) {
  const response = await fetch(`${origin}/api/v1/${route}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}`, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, await response.clone().text());
  if (response.status !== 204) return response.json();
}
before(async () => {
  const credentials = {email: `${randomUUID()}@example.invalid`, password: 'library-ui-review'};
  await api('auth/register', 'POST', credentials);
  token = (await api('auth/login', 'POST', credentials)).access_token;
  const vault = (await api('vaults','POST',{name:'设计验收'})).id;
  const files = `vaults/${vault}/files`;
  for (const path of ['示例.md', '旧笔记.md']) {
    const note = await api(files,'POST',{path, content:Buffer.from('# 恢复预览\n\n测试正文').toString('base64')});
    if (path === '旧笔记.md') await api(`${files}/${note.file_id}`, 'DELETE', {base_version_id:note.version_id});
  }
  browser = await chromium.launch({channel:'chrome'});
});
after(async () => browser?.close());
async function open(t, dark = false, width = 1280) {
  const page = await browser.newPage({viewport:{width,height:800}});
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  await page.addInitScript(({token,dark}) => {
    sessionStorage.setItem('wenote-session', token);
    localStorage.setItem('wenote-color-scheme-v1',dark?'dark':'light');
  }, {token,dark});
  await page.goto(origin);
  await button(page,'示例.md').waitFor();
  return page;
}
const button = (page,name) => page.getByRole('button',{name,exact:true});
const color = (locator,key) => locator.evaluate((el,key) => getComputedStyle(el)[key],key);
function contrast(a,b) {
  const luminance = rgb => rgb.match(/\d+/g).slice(0,3).map(Number).reduce((sum, v, i) => {
    const c = v/255;
    return sum + [0.2126,0.7152,0.0722][i]*(c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4);
  },0);
  const [low,high] = [luminance(a),luminance(b)].sort((x,y)=>x-y);
  return (high+0.05)/(low+0.05);
}
test('新建笔记与命名弹窗使用相同的主按钮', async t => {
  const page=await open(t);
  const create=button(page,'新建笔记');
  const background=await color(create,'backgroundColor');
  await create.click(); await button(page,'Markdown').click();
  assert.equal(await color(button(page,'创建'),'backgroundColor'),background);
});
test('深色回收站正文和标题可读', async t => {
  const page=await open(t,true);
  await button(page,'回收站').click(); await button(page,'旧笔记.md').click();
  const bg=await color(page.locator('main.workspace'),'backgroundColor');
  for (const element of ['p','h1']) {
    const text=page.locator(`.trash-preview-content .reading ${element}`).first();
    await text.waitFor(); assert.ok(contrast(await color(text,'color'),bg)>=4.5,element);
  }
});
test('手机深色目录和条目右键状态可读', async t => {
  const page=await open(t,true,390);
  await button(page,'打开笔记库目录').click();
  const sidebar=page.getByRole('navigation',{name:'笔记库目录'});
  assert.ok(contrast(await color(sidebar,'color'),await color(sidebar,'backgroundColor'))>=4.5);
  await page.setViewportSize({width:1280,height:800});
  await button(page,'示例.md').click({button:'right'});
  const target=page.locator('.entry-row[data-context]');
  assert.ok(contrast(await color(target,'color'),await color(target,'backgroundColor'))>=4.5);
});
test('手机回收站条目操作从底部打开', async t => {
  const page=await open(t,true,390);
  await button(page,'打开笔记库目录').click(); await button(page,'回收站').click();
  await button(page,'旧笔记.md 的回收站操作').click();
  const sheet=page.getByRole('dialog',{name:'回收站操作'});
  await button(sheet,'恢复').waitFor(); await button(sheet,'取消').click();
  await button(page,'旧笔记.md').waitFor();
});
test('新建库和上传路径使用库内表单', async t => {
  const page = await open(t);
  await button(page, '新建笔记库').click();
  const vaultDialog = page.getByRole('dialog', { name: '新建笔记库' });
  await vaultDialog.getByLabel('笔记库名称').fill('取消建库');
  await button(vaultDialog, '取消').click();
  const chooser = page.waitForEvent('filechooser');
  await button(page, '上传笔记').click();
  await (await chooser).setFiles({name:'上传.md', mimeType:'text/plain', buffer:Buffer.from('验收')});
  const upload = page.getByRole('dialog', { name: '上传笔记' });
  await upload.getByLabel('保存路径').fill('归档/上传.md');
  await button(upload, '上传').click();
  await page.getByRole('heading',{name:'上传.md'}).waitFor();
});
test('从正文重命名使用同一个文件表单，取消与提交都可用', async t => {
  const page=await open(t);
  await button(page,'示例.md').click();
  for (const confirm of [false,true]) {
    await button(page,'更多操作').click(); await button(page,'重命名').click();
    const dialog=page.getByRole('dialog',{name:'重命名'});
    assert.equal(await dialog.getByLabel('名称').inputValue(),'示例.md');
    await dialog.getByLabel('名称').fill('重命名.md');
    await button(dialog,confirm?'确定':'取消').click();
    await button(page,confirm?'重命名.md':'示例.md').waitFor();
  }
});
