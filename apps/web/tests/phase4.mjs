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
  const fixture = unzipSync(raw),
    original = JSON.parse(strFromU8(fixture["content.json"]));
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
    if (name === "导出 XMind") await click("更多操作");
    await click(name);
    return readFile(await (await event).path());
  }
  await click("登录");
  await create("设置验收.md", '# 设置验收\n\n`answer`\n\n```python\nanswer = "ok" if True else 0\n```');
  const formatId = await create("自动格式化.md", "占位");
  await click("插件");
  await click("禁用 Markdown");
  await click("Markdown 设置");
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
  for (const theme of ["clean", "developer", "paper"]) {
    if (theme !== "clean") await setRule("主题", theme);
    const preview = page.locator(`.theme-preview[data-markdown-theme="${theme}"]`);
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
    assert.ok(contrast.every(ratio => ratio >= 4.5), `${theme}: ${contrast}`);
  }
  await setRule("默认打开模式", "split");
  await click("XMind 设置");
  await setRule("主题", "youdao", "com.wenote.xmind");
  await page.locator('.mindmap-theme-preview[data-xmind-theme="youdao"] .mindmap-preview-root').waitFor();
  await click("启用 Markdown");
  await page.reload();
  await click("自动格式化.md");
  await page.locator('.document-mode.mode-split[data-markdown-theme="paper"]').waitFor();
  await click("编辑模式");
  await click("源码");
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
  await sourceEditor.press("ControlOrMeta+Shift+z");
  assert.deepEqual(await sourceLines(), formattedMarkdown.split("\n"));
  await click("设置验收.md");
  await page.locator('.document-mode.mode-split[data-markdown-theme="paper"]').waitFor();
  await page.locator('.split-preview [data-language="python"] .md-keyword').first().waitFor();
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith("/me/plugin-settings/com.wenote.md") && r.status() === 204),
    click("同步滚动"),
  ]);
  const stored = await (await api("/api/v1/me/plugin-settings")).json();
  assert.equal(stored.plugins["com.wenote.md"].syncScroll, false);
  await click("编辑模式");
  await click("所见所得");
  // Sample painted pixels: the caret is in a separate blinking layer above the text.
  await page.addStyleTag({ content: ".cm-cursorLayer { animation: none !important }" });
  async function caretContrast() {
    await page.keyboard.press("End");
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const cursor = await page.locator(".mode-live .cm-focused .cm-cursor-primary").boundingBox();
    assert.ok(cursor && cursor.height > 0);
    const strip = await page.screenshot({ clip: {
      x: Math.floor(cursor.x), y: Math.floor(cursor.y + cursor.height / 2), width: 6, height: 1,
    }, scale: "css", caret: "initial" });
    return page.evaluate(async (png) => {
      const img = new Image();
      img.src = "data:image/png;base64," + png;
      await img.decode();
      const ctx = document.createElement("canvas").getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, 6, 1);
      function luminance(x) {
        const [r, g, b] = Array.from(data.slice(x * 4, x * 4 + 3), v => v / 255)
          .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      const bg = luminance(5);
      return Math.max(...[0, 1, 2].map(x => {
        const ink = luminance(x);
        return (Math.max(ink, bg) + 0.05) / (Math.min(ink, bg) + 0.05);
      }));
    }, strip.toString("base64"));
  }
  const carets = [];
  for (const theme of ["clean", "developer", "paper"]) {
    await click("插件");
    await click("Markdown 设置");
    await setRule("主题", theme);
    await click("设置验收.md");
    const live = page.locator(`.mode-live[data-markdown-theme="${theme}"]`);
    await live.locator(".cm-line.live-h1").click();
    const prose = await caretContrast();
    await live.locator('.live-preview [data-language="python"] .md-keyword').first().click();
    await live.locator('.live-fence .md-string').first().click();
    carets.push({ theme, prose, code: await caretContrast() });
  }
  console.log("Caret contrast:", carets);
  assert.ok(carets.every(({ prose, code }) => prose >= 4.5 && code >= 4.5), JSON.stringify(carets));
  assert.equal(await button("Markdown 设置").count(), 0);
  await click("插件");
  await click("Markdown 设置");
  assert.equal(await page.getByRole("combobox", { name: "主题" }).inputValue(), "paper");
  assert.equal(await page.getByLabel("分屏编辑同步滚动").isChecked(), false);
  await click("values.json");
  await click("格式化");
  await page.getByLabel("JSON Pointer", { exact: true }).fill("/a~1b/~0key");
  await click("定位值");
  assert.equal(await page.getByLabel("节点 JSON 值").inputValue(), "1");
  await page.getByLabel("节点 JSON 值").fill("2");
  await click("替换节点");
  await click("压缩");
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal(
    (await content(jsonId)).toString(),
    '\uFEFF{"a/b":{"~key":2},"large":9007199254740993}',
  );
  assert.deepEqual(await exportBytes("导出当前文件"), await content(jsonId));
  await page.getByLabel("JSON 源码").fill("{");
  await click("保存");
  await page.locator(".plugin-document [role=alert]").waitFor();
  assert.match((await content(jsonId)).toString(), /9007199254740993/);
  await page.getByLabel("JSON 源码").fill('{"draft":true}');
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
  assert.match(await page.getByLabel("JSON 源码").innerText(), /draft/);
  assert.equal((await content(jsonId)).toString(), '{"remote":true}');
  page.once("dialog", (d) => d.accept());
  await click("prefixed.txt");
  const upload = async (name, buffer) => {
    page.once("dialog", (d) => d.accept(name));
    await page
      .locator("main.workspace > input[type=file]")
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  await upload("路线.xmind", raw);
  await page.locator('.mindmap-stage[data-xmind-theme="youdao"]').waitFor();
  const lineMarker = page.locator('.mindmap-stage[data-xmind-theme="youdao"] .mindmap-line-node-marker').first();
  await lineMarker.waitFor({ state: "attached" });
  const markerStyle = await lineMarker.evaluate((el) => getComputedStyle(el));
  assert.notEqual(markerStyle.stroke, "none");
  assert.equal(markerStyle.strokeWidth, "2px");
  const mapLineWidths = await page
    .locator(
      '.mindmap-stage[data-xmind-theme="youdao"] .mindmap-edges path, .mindmap-stage[data-xmind-theme="youdao"] .mindmap-relationships path, .mindmap-stage[data-xmind-theme="youdao"] .mindmap-line-node-marker, .mindmap-stage[data-xmind-theme="youdao"] .mindmap-summary',
    )
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).strokeWidth),
    );
  assert.ok(mapLineWidths.length > 0);
  assert.equal(new Set(mapLineWidths).size, 1);
  const childNode = lineMarker.locator("..");
  await childNode.click({ force: true });
  const childBoxStyle = await childNode
    .locator("rect.mindmap-line-node")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { stroke: style.stroke, opacity: style.strokeOpacity };
    });
  assert.ok(
    childBoxStyle.opacity === "0" ||
      childBoxStyle.stroke === "transparent" ||
      childBoxStyle.stroke === "rgba(0, 0, 0, 0)",
  );
  const rootNode = page.locator(".mindmap-node").first();
  async function editMapTitle(nodeLocator, title) {
    await nodeLocator.dblclick();
    await page.getByLabel("主题标题").fill(title);
    await page.getByLabel("主题标题").press("Enter");
  }
  await editMapTitle(rootNode, "实施");
  await rootNode.click({ button: "right" });
  await page.getByRole("menuitem", { name: "插入下级主题", exact: true }).click();
  const addedNode = page.locator(".mindmap-node").last();
  await editMapTitle(addedNode, "校验");
  const addedBox = await addedNode.boundingBox();
  assert.ok(addedBox);
  await page.mouse.move(
    addedBox.x + addedBox.width / 2,
    addedBox.y + addedBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    addedBox.x + addedBox.width / 2 + 120,
    addedBox.y + addedBox.height / 2 + 60,
  );
  await page.mouse.up();
  await page.locator(".mindmap-stage").focus();
  await page.keyboard.press("Control+s");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  const mapId = (await (await api(route)).json()).files.find(
    (x) => x.path === "路线.xmind",
  ).file_id;
  const saved = unzipSync(await content(mapId)),
    sheets = JSON.parse(strFromU8(saved["content.json"]));
  assert.equal(sheets[0].rootTopic.title, "实施");
  const addedTopic = sheets[0].rootTopic.children.attached.find(
    (n) => n.title === "校验",
  );
  assert.ok(addedTopic);
  assert.equal(addedTopic.position, undefined);
  assert.deepEqual(sheets[0].relationships, original[0].relationships);
  assert.deepEqual(
    sheets[0].rootTopic.children.attached[0],
    original[0].rootTopic.children.attached[0],
  );
  assert.deepEqual(sheets[1], original[1]);
  for (const [name, bytes] of Object.entries(fixture))
    if (name !== "content.json") assert.deepEqual(saved[name], bytes);
  const markdown = Buffer.from(
    "# 实施\n\n## 交付\n\n周五验收\n\n## 校验\n",
  );
  await upload("转换.md", markdown);
  const rebuilt = JSON.parse(
    strFromU8(unzipSync(await exportBytes("导出 XMind"))["content.json"]),
  );
  assert.equal(
    rebuilt[0].rootTopic.children.attached[0].notes.plain.content,
    "周五验收",
  );
  await click("编辑模式");
  await click("思维导图");
  await page.getByText("编辑标题树", { exact: true }).click();
  await page.getByLabel("目标标题").selectOption("2");
  await page.getByLabel("标题文本").fill("复核");
  await click("更新标题");
  await click("上移整个章节");
  await click("保存");
  const editedMap = JSON.parse(
    strFromU8(unzipSync(await exportBytes("导出 XMind"))["content.json"]),
  );
  assert.deepEqual(
    editedMap[0].rootTopic.children.attached.map((n) => n.title),
    ["复核", "交付"],
  );
  assert.equal(
    editedMap[0].rootTopic.children.attached[1].notes.plain.content,
    "周五验收",
  );
  const legacy = Buffer.from(
    zipSync({ "content.xml": strToU8("<xmap-content/>") }),
  );
  await upload("旧版.xmind", legacy);
  await page.getByRole("alert").filter({ hasText: "XMind 8 XML" }).waitFor();
  const legacyId = (await (await api(route)).json()).files.find(
    (x) => x.path === "旧版.xmind",
  ).file_id;
  assert.deepEqual(await content(legacyId), legacy);
  await click("插件");
  await click("禁用 XMind");
  await click("路线.xmind");
  await page.getByText(/此格式的插件已禁用/).waitFor();
  assert.deepEqual(await exportBytes("下载原文件"), await content(mapId));
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
  await click("插件");
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
        JSON.stringify({ ...manifest, capabilities: caps }),
      ),
    });
  await install(withCaps(["parse", "network"]));
  await page.getByRole("alert").filter({ hasText: "权限不受支持" }).waitFor();
  await install(withCaps(["parse"]));
  await click("授权并安装");
  await click("prefixed.txt");
  await page.getByLabel("插件文档").waitFor();
  assert.equal(await page.getByLabel("插件文档").isEditable(), false);
  assert.equal(await button("保存").count(), 0);
  await click("插件");
  await install(sample);
  await click("授权并安装");
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "磁盘字节");
  await page.getByLabel("插件文档").fill("修改后");
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal((await content(marked)).toString(), "WN1\n修改后");
  await page.reload();
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "修改后");
  await click("插件");
  await click("禁用 带标记的文本");
  await click("prefixed.txt");
  await page.locator("article pre").getByText("WN1").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Phase 4 browser passed: JSON Pointer and precision, XMind canvas editing and round trip, Markdown conversion, WASM installation, persistence, and permissions.",
  );
} finally {
  await browser.close();
}
