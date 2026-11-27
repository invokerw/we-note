import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { pack } from "../plugin-sdk/pack.mjs";
const origin = process.env.WENOTE_TEST_ORIGIN;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
});
try {
  let token = "";
  async function api(route, method = "GET", body) {
    const r = await fetch(origin + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r;
  }
  const credentials = {
    email: randomUUID() + "@example.invalid",
    password: "plugins-phase-four",
  };
  await api("/api/v1/auth/register", "POST", credentials);
  token = (await (await api("/api/v1/auth/login", "POST", credentials)).json())
    .access_token;
  const vault = (
      await (await api("/api/v1/vaults", "POST", { name: "插件验收" })).json()
    ).id,
    route = `/api/v1/vaults/${vault}/files`;
  const create = async (path, bytes) =>
    (
      await (
        await api(route, "POST", {
          path,
          content: Buffer.from(bytes).toString("base64"),
        })
      ).json()
    ).file_id;
  const content = async (id) =>
    Buffer.from(await (await api(`${route}/${id}/content`)).arrayBuffer());
  const raw = await readFile(
    new URL("./fixtures/sdk-workbook.xmind", import.meta.url),
  );
  const jsonId = await create(
    "values.json",
    '\uFEFF{"a/b":{"~key":1},"large":9007199254740993}\r\n',
  );
  const marked = await create("prefixed.txt", "WN1\n磁盘字节");
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  const button = (name) => page.getByRole("button", { name, exact: true }),
    click = (name) => button(name).click();
  async function exportBytes(name) {
    const event = page.waitForEvent("download");
    await click(name);
    return readFile(await (await event).path());
  }
  await click("登录");
  await create("设置验收.md", '# 设置验收\n\n`answer`\n\n```python\nanswer = "ok" if True else 0\n```');
  const formatId = await create("自动格式化.md", "占位");
  await click("打开个人设置");
  await click("编辑与插件");
  assert.equal(await page.getByRole("combobox", { name: "默认打开模式" }).count(), 0);
  assert.equal(await page.locator('.plugin-entry button[aria-haspopup="dialog"]').count(), 1);
  await click("禁用 Markdown");
  await click("Markdown 设置");
  const pluginSettings = page.getByRole("dialog", {name:"Markdown 设置", exact:true});
  assert.ok(await pluginSettings.evaluate(el => el.matches(":modal")));
  assert.ok(await pluginSettings.getByLabel("记住每篇笔记上次打开的模式").isChecked());
  for (const label of [
    "启用保存时自动格式化",
    "中日韩文字与英文之间加空格",
    "中日韩文字与数字之间加空格",
    "英文与数字之间加空格",
    "清理普通行尾空格",
    "整理连续空行",
  ]) {
    assert.equal(await page.getByLabel(label).isChecked(), true, label);
  }
  async function setRule(label, value, pluginId = "com.wenote.md") {
    const [saved] = await Promise.all([
      page.waitForResponse((r) =>
        r.url().endsWith("/me/plugin-settings/" + pluginId) && r.request().method() === "PUT",
      ),
      page.getByRole("combobox", { name: label }).selectOption(value),
    ]);
    assert.equal(saved.status(), 204);
  }
  {
    const preview = page.locator('.theme-preview[data-markdown-theme="clean"]');
    await preview.locator(".md-keyword").waitFor();
    const contrast = await preview.evaluate((el) => {
      function luminance(color) {
        const rgb = color.match(/\d+/g).slice(0, 3).map(n => Number(n) / 255)
          .map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      }
      const inline = el.querySelector("p code");
      return [inline, ...el.querySelectorAll("pre code span")].map(token => {
        const ink = luminance(getComputedStyle(token).color);
        const bg = luminance(getComputedStyle(token.closest("pre") || inline).backgroundColor);
        return (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05);
      });
    });
    assert.ok(contrast.every(ratio => ratio >= 4.5), String(contrast));
  }
  await setRule("默认打开模式", "split");
  await page.keyboard.press("Escape");
  await pluginSettings.waitFor({state:"hidden"});
  assert.ok(await button("Markdown 设置").evaluate(el => el === document.activeElement));
  assert.equal(await button("XMind 设置").count(), 0);
  assert.equal(await button("禁用 JSON").count(), 0);
  await click("启用 Markdown");
  await page.reload();
  await click("自动格式化.md");
  await page.locator('.document-mode.mode-split[data-markdown-theme="clean"]').waitFor();
  await click("编辑模式");
  await click("分屏编辑");
  const messyMarkdown = [
    "---",
    "title: 你好world",
    "count: 100",
    "---",
    "",
    "你好world 共100个 Python3   ",
    "",
    "",
    "`你好world`",
    "```js",
    "你好world",
    "",
    "",
    "```",
    "",
    "",
  ].join("\n");
  const formattedMarkdown = [
    "---",
    "title: 你好world",
    "count: 100",
    "---",
    "",
    "你好 world 共 100 个 Python 3  ",
    "",
    "`你好world`",
    "```js",
    "你好world",
    "",
    "",
    "```",
    "",
  ].join("\n");
  const sourceEditor = page.getByLabel("笔记源码");
  await sourceEditor.fill(messyMarkdown);
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal((await content(formatId)).toString(), formattedMarkdown);
  const sourceLines = () => sourceEditor.locator(".cm-line").allTextContents();
  await sourceEditor.press("ControlOrMeta+z");
  assert.deepEqual(await sourceLines(), messyMarkdown.split("\n"));
  await sourceEditor.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+y");
  assert.deepEqual(await sourceLines(), formattedMarkdown.split("\n"));
  await click("设置验收.md");
  await page.locator('.document-mode.mode-split[data-markdown-theme="clean"]').waitFor();
  await page.locator('.split-preview [data-language="python"] .md-keyword').first().waitFor();
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith("/me/plugin-settings/com.wenote.md") && r.status() === 204),
    click("同步滚动"),
  ]);
  const stored = await (await api("/api/v1/me/plugin-settings")).json();
  assert.equal(stored.plugins["com.wenote.md"].syncScroll, false);
  await click("编辑模式");
  await click("可视化编辑");
  const visual = page.getByLabel("可视化编辑器");
  const heading = visual.getByRole("heading", { name: "设置验收" });
  const code = visual.locator(".milkdown-code-block .cm-content");
  for (const target of [heading, code]) {
    await target.click();
    const contrast = await target.evaluate((el) => {
      const luminance = (color) => {
        const [r, g, b] = color.match(/\d+/g).slice(0, 3).map(Number)
          .map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
        return .2126 * r + .7152 * g + .0722 * b;
      };
      let surface = el;
      while (surface.parentElement && getComputedStyle(surface).backgroundColor === "rgba(0, 0, 0, 0)")
        surface = surface.parentElement;
      const style = getComputedStyle(el);
      const drawnCursor = el.closest(".cm-editor")?.querySelector(".cm-cursor-primary");
      const color = drawnCursor ? getComputedStyle(drawnCursor).borderLeftColor : style.caretColor;
      if (color === "transparent" || color === "rgba(0, 0, 0, 0)") return 0;
      const ink = luminance(color === "auto" ? style.color : color);
      const bg = luminance(getComputedStyle(surface).backgroundColor);
      return (Math.max(ink, bg) + .05) / (Math.min(ink, bg) + .05);
    });
    assert.ok(contrast >= 4.5, `caret contrast ${contrast}`);
  }
  assert.equal(await button("Markdown 设置").count(), 0);
  await click("打开个人设置");
  await click("编辑与插件");
  await click("Markdown 设置");
  assert.equal(await page.getByRole("combobox", { name: "主题" }).count(), 0);
  assert.equal(await page.getByLabel("分屏编辑同步滚动").isChecked(), false);
  assert.equal(await pluginSettings.getByLabel("默认打开模式").inputValue(), "split");
  await click("关闭 Markdown 设置");
  await click("关闭个人设置");
  await click("values.json");
  assert.equal(await page.locator(".document .plugin-document .toolbar").count(), 0, "纯文本正文不显示插件工具栏");
  const plain = page.locator('.note-content:not([inert]) .document-mode:not([data-markdown-theme]) .cm-content');
  const headerSave = page.locator('.document-head .head-actions').getByRole('button', {name:'保存', exact:true});
  async function plainValue() {
    await plain.waitFor();
    return (await plain.locator('.cm-line').allTextContents()).join('\n');
  }
  async function replacePlain(value) {
    await plain.focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(value);
  }
  await plain.waitFor();
  assert.match(await plainValue(), /9007199254740993/);
  await replacePlain('{"changed":true}\n');
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal((await content(jsonId)).toString(), '\uFEFF{"changed":true}\r\n');
  assert.equal(await page.getByRole("button", {name:"导出当前文件",exact:true}).count(), 0);
  await replacePlain('{"draft":true}');
  const latest = (await (await api(`${route}/${jsonId}`)).json())
    .current_version_id;
  await api(`${route}/${jsonId}/content`, "PUT", {
    base_version_id: latest,
    content: Buffer.from('{"remote":true}').toString("base64"),
  });
  await click("保存");
  await page
    .getByRole("status")
    .filter({ hasText: "文件已有新版本" })
    .waitFor();
  assert.match(await plainValue(), /draft/);
  assert.equal((await content(jsonId)).toString(), '{"remote":true}');
  page.once("dialog", (d) => d.accept());
  await click("prefixed.txt");
  const upload = async (name, buffer) => {
    await page
      .locator("main.workspace > input[type=file]")
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    const form = page.getByRole("dialog", {name:"上传笔记"});
    await form.getByLabel("保存路径").fill(name);
    await form.getByRole("button", {name:"上传", exact:true}).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  for (const name of ["表格.csv", "运行.log", "README"]) {
    await upload(name, Buffer.from("初稿\r\n"));
    assert.equal(await plainValue(), "初稿\n");
    const editorBox = await plain.locator('xpath=ancestor::div[contains(@class,"cm-editor")]').boundingBox();
    const bodyBox = await page.locator('.document-body.note-workspace').boundingBox();
    assert.ok(editorBox.width >= bodyBox.width - 32 && editorBox.height >= bodyBox.height - 32, JSON.stringify({editorBox, bodyBox}));
    await replacePlain("# 原样的 **文本**\n");
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/content'));
    await headerSave.click();
    assert.equal((await saved).status(), 200);
    const note = (await (await api(route)).json()).files.find(file => file.path === name);
    assert.deepEqual(await content(note.file_id), Buffer.from("# 原样的 **文本**\r\n"));
  }
  await upload("路线.xmind", raw);
  await page.getByRole("alert").filter({hasText: "UTF-8"}).waitFor();
  assert.equal(await button("保存").count(), 0);
  assert.deepEqual(await exportBytes("下载原文件"), raw);
  const invalid = await fetch(origin + route, {
    method: "POST", headers: {Authorization: "Bearer " + token, "Content-Type": "application/json"},
    body: JSON.stringify({path: "invalid.csv", content: raw.toString("base64")}),
  });
  assert.equal(invalid.status, 400);
  const sample = await pack(
    fileURLToPath(new URL("../plugin-sdk/example", import.meta.url)),
  );
  const entries = unzipSync(sample);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const install = async (bytes) =>
    page.getByLabel("安装本地插件包").setInputFiles({
      name: "example.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(bytes),
    });
  await click("打开个人设置");
  await click("编辑与插件");
  await install(
    zipSync({
      ...entries,
      "manifest.json": strToU8(
        JSON.stringify({ ...manifest, api_version: "2" }),
      ),
    }),
  );
  await page.getByRole("alert").filter({ hasText: "不兼容" }).waitFor();
  const withCaps = (caps) =>
    zipSync({
      ...entries,
      "manifest.json": strToU8(
        JSON.stringify({ ...manifest, capabilities: caps, actions: undefined, mcp_model: undefined }),
      ),
    });
  await install(withCaps(["parse", "network"]));
  await page.getByRole("alert").filter({ hasText: "权限不受支持" }).waitFor();
  await install(withCaps(["parse"]));
  await click("授权并安装");
  const readOnlyAction = { id: "uppercase", label: "查看转换结果", kind: "message" };
  const readOnlyPackage = action => zipSync({ ...entries, "manifest.json": strToU8(JSON.stringify({
    ...manifest, capabilities: ["parse"], actions: [action], mcp_model: undefined,
  })) });
  await install(readOnlyPackage({ ...readOnlyAction, id: "missing" }));
  await page.getByRole("alert").filter({ hasText: "缺少 action_missing" }).waitFor();
  await install(readOnlyPackage(readOnlyAction));
  await click("授权并安装");
  await click("关闭个人设置");
  await click("prefixed.txt");
  await page.getByLabel("插件文档").waitFor();
  assert.equal(await page.getByLabel("插件文档").isEditable(), false);
  assert.equal(await button("保存").count(), 0);
  await click("查看转换结果");
  await page.getByRole("status").filter({hasText:"磁盘字节"}).waitFor();
  assert.equal(await page.getByLabel("插件文档").inputValue(), "磁盘字节");
  await click("打开个人设置");
  await click("编辑与插件");
  await install(sample);
  await click("授权并安装");
  await click("关闭个人设置");
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "磁盘字节");
  async function checkHeadingOrder() {
    const buttons = page.locator('.document-head:visible, .phone-document-head:visible').getByRole('button');
    const labels = await buttons.evaluateAll(items => items.map(el => el.getAttribute('aria-label') || el.textContent.trim()));
    assert.deepEqual(labels.slice(-5), ['保存', '加星', '分享', '反向链接', '更多操作']);
  }
  const pluginText = page.getByLabel("插件文档");
  await pluginText.fill("修改abc");
  await checkHeadingOrder();
  await page.locator('.document-head').getByRole('button', {name:'英文转大写'}).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="插件文档"]').value === '修改ABC');
  assert.equal((await content(marked)).toString(), 'WN1\n磁盘字节');
  const beforeTheme = await pluginText.evaluate(el => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(color => getComputedStyle(document.querySelector('textarea[aria-label="插件文档"]')).backgroundColor !== color, beforeTheme);
  assert.equal(await pluginText.inputValue(), '修改ABC');
  await page.emulateMedia({colorScheme:'light'});
  const area = await page.locator('.note-aux-view:visible').boundingBox();
  const field = await pluginText.boundingBox();
  assert.ok(Math.abs(area.width - field.width) < 2 && Math.abs(area.height - field.height) < 2);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const phoneHead = page.locator('.phone-document-head');
    await phoneHead.waitFor();
    await checkHeadingOrder();
    const more = await phoneHead.getByRole('button', {name:'更多操作'}).boundingBox();
    assert.ok(more.x + more.width <= width, `更多操作超出 ${width}px 标题栏`);
  }
  await click('文件操作');
  await page.getByRole('button',{name:'英文转大写'}).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:1280,height:720});
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal((await content(marked)).toString(), "WN1\n修改ABC");
  await page.reload();
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "修改ABC");
  await click("打开个人设置");
  await click("编辑与插件");
  await click("禁用 带标记的文本");
  await click("关闭个人设置");
  await click("prefixed.txt");
  assert.equal(await plainValue(), "WN1\n修改ABC");
  assert.equal(await button("英文转大写").count(), 0);
  await click("打开个人设置");
  await click("编辑与插件");
  await click("禁用 Markdown");
  await click("关闭个人设置");
  await click("自动格式化.md");
  await replacePlain("# 标题 **原样**\n你好world  ");
  const fallbackSave = page.waitForResponse(r => r.request().method() === "PUT" && r.url().endsWith("/content"));
  await headerSave.click();
  assert.ok((await fallbackSave).ok());
  assert.equal((await content(formatId)).toString(), "# 标题 **原样**\n你好world  ");
  await click("编辑模式");
  await click("预览模式");
  const preview = page.locator('.document-mode.mode-read > pre');
  assert.equal(await preview.textContent(), "# 标题 **原样**\n你好world  ");
  assert.equal(await preview.locator('h1, strong').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Phase 4 browser passed: text fallback, binary original download, Markdown editing, WASM installation, persistence, and permissions.",
  );
} finally {
  await browser.close();
}
