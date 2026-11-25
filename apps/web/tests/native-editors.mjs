import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(import.meta.dirname, "../../..");
const temp = await mkdtemp(join(tmpdir(), "wenote-native-test-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const addr = "127.0.0.1:" + probe.address().port;
await new Promise((r) => probe.close(r));
const origin = "http://" + addr;
const server = spawn(
  join(root, "dist/local/wenote-api"),
  ["-addr", addr, "-web-dir", join(root, "apps/web/dist")],
  {
    cwd: temp,
    stdio: "ignore",
  },
);

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const email = randomUUID() + "@example.invalid",
    password = "browser-editors";
  let token = "";
  async function api(path, body) {
    const r = await fetch(origin + "/api/v1" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r;
  }
  for (
    let i = 0;
    i < 100 &&
    !(await fetch(origin + "/healthz")
      .then((r) => r.ok)
      .catch(() => false));
    i++
  )
    await delay(50);
  const signup = await browser.newPage();
  await signup.goto(origin);
  await signup.getByRole("button", { name: "创建账户", exact: true }).click();
  await signup.getByLabel("邮箱").fill(email);
  await signup.getByLabel("密码").fill(password);
  const [login] = await Promise.all([
    signup.waitForResponse(origin + "/api/v1/auth/login"),
    signup.getByRole("button", { name: "注册并登录" }).click(),
  ]);
  assert.equal(login.status(), 200);
  token = (await login.json()).access_token;
  await signup.getByRole("heading", { name: "创建你的第一个笔记库" }).waitFor();
  await signup.close();
  await fetch(origin + "/api/v1/me/plugin-settings/com.wenote.md", {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ autoFormatOnSave: false, defaultMode: "live" }),
  });
  const { id } = await (await api("/vaults", { name: "原生编辑验收" })).json();
  const folder = "/vaults/" + id + "/files";
  const source =
    "---\r\nowner: WeNote # 元数据\r\n---\r\n##  章节\r\n\r\n\r\n编辑段落\r\n\r\n_tail_\r\n";
  const create = async (path, raw) =>
    (
      await api(folder, { path, content: Buffer.from(raw).toString("base64") })
    ).json();
  const md = await create("笔记.md", source);
  const map = await create(
    "路线.mind.json",
    JSON.stringify({
      nodeData: {
        id: "root",
        topic: "产品路线",
        children: [{ id: "study", topic: "调研" }],
      },
    }),
  );
  const typed = await create("手写双链.md", "参考资料");
  await create("链接索引.md", "# 项目索引\n\n[[笔记|会议记录]] 和 [路线图](路线.mind.json)\n");
  await create("普通.json", "{}");
  await create("引用.md", "[首页][home]\n\n[home]: /home");
  const readingSource = [
    "# 关于城市散步的读书手记",
    "这周重读《街道的美学》。把书里谈到的观察方法记下来，周末带着这些问题，再走一次熟悉的街区。",
    "## 从一条街开始",
    "选一段每天路过的街道，慢一点走。先记下看到的细节，再写自己的判断。",
    "> 同一条路，早晨和傍晚往往像两个地方。",
    "## 下次散步时",
    "- 在街口停五分钟，看看人们在哪里停留。\n- 用 `街区观察` 标记当天的笔记。",
  ].join("\n\n");
  const readingNote = await create("读书手记.md", readingSource);
  const page = await browser.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.error(e.message);
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await button("登录").click();
  await button("读书手记.md").click();
  await page.locator(".mode-crepe .milkdown").waitFor();
  await button("编辑模式").click();
  const modeNames = await page.locator(".popup-list button").allTextContents();
  await button("可视化编辑").click();
  await (await import("./crepe-appearance.mjs")).verifyAppearance(page);
  assert.equal(await button("插入附件").count(), 0);
  assert.deepEqual(modeNames, ["分屏编辑", "可视化编辑", "预览"]);
  await page.locator(".mode-crepe .ProseMirror > p").last().click();
  await page.keyboard.insertText("周日再读。");
  assert.equal(await saveFile(readingNote), readingSource + "\n\n周日再读。");
  await page.evaluate(({ vault, file }) => {
    const key = "wenote-note-modes-v1";
    const modes = JSON.parse(localStorage.getItem(key) || "{}");
    modes[vault + ":" + file] = "map";
    localStorage.setItem(key, JSON.stringify(modes));
  }, { vault: id, file: md.file_id });
  await button("笔记.md").click();
  await page.locator(".mode-read .reading h2").waitFor();
  await button("编辑模式").click();
  await button("可视化编辑").click();
  const para = page
    .locator(".milkdown .ProseMirror p")
    .filter({ hasText: "编辑段落" });
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("完成");
  async function saveFile(file, save = () => button("保存").click()) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/" + file.file_id + "/content") &&
        r.request().method() === "PUT",
    );
    await save();
    assert.ok((await response).ok());
    return (await api(folder + "/" + file.file_id + "/content")).text();
  }
  assert.equal(await saveFile(md), source.replace("编辑段落", "编辑段落完成"));
  await button("编辑模式").click();
  await button("分屏编辑").click();
  await button("插入附件").waitFor();
  assert.match(await page.getByLabel("笔记源码").innerText(), /编辑段落完成/);
  await button("编辑模式").click();
  await button("预览").click();
  await page.locator(".reading h2").waitFor();
  await button("路线.mind.json").click();
  const infoButton = button("笔记信息");
  const infoPanel = page.getByRole("complementary", {name: "笔记信息"});
  async function verifyDock(content, stacked = false) {
    await infoButton.click();
    const box = await content.boundingBox();
    const info = await infoPanel.boundingBox();
    assert.ok(stacked ? Math.abs(box.y + box.height - info.y) <= 1 : Math.abs(box.x + box.width - info.x) <= 1,
      `panel overlaps content: ${JSON.stringify({box, info})}`);
    assert.equal(await infoPanel.getByRole("button", {name: /关闭/}).count(), 0);
  }
  const mapCanvas = page.locator(".mind-host .map-container");
  await verifyDock(mapCanvas);
  await infoPanel.getByRole("button", {name:"链接索引.md"}).click();
  await verifyDock(page.locator(".mode-crepe"));
  const outgoing = infoPanel.getByRole("region", { name: "本文链接" });
  if (process.env.WENOTE_INFO_PREVIEW) await page.locator(".document").screenshot({path:process.env.WENOTE_INFO_PREVIEW});
  await outgoing.getByRole("button", { name:"笔记.md" }).click();
  await infoButton.click();
  await infoPanel.getByRole("button", {name:"链接索引.md"}).click();
  await button("编辑模式").click();
  await button("预览").click();
  await page.locator(".reading").getByRole("link", {name:"路线图"}).click();
  await verifyDock(mapCanvas);
  await infoButton.click();
  await button("手写双链.md").click();
  const typedParagraph = page.locator(".milkdown .ProseMirror > p").first();
  await typedParagraph.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" [[笔记]]");
  assert.match(await saveFile(typed), /\[\[笔记\]\]/);
  await button("笔记.md").click();
  await infoButton.click();
  await infoPanel.getByRole("button", { name: "手写双链.md" }).waitFor();
  await infoPanel.getByRole("button", { name: "手写双链.md" }).click();
  await typedParagraph.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("补充");
  assert.match(await saveFile(typed), /\[\[笔记\]\]补充/);
  await button("路线.mind.json").click();
  const branch = page.locator(".me-tpc").filter({ hasText: "调研" });
  const surface = page.locator(".mind-host .map-container");
  const menuItem = (name) => page.getByRole("menuitem", { name, exact: true });
  async function canvasAction(name) {
    await surface.click({ button: "right", position: { x: 12, y: 14 } });
    await menuItem(name).click();
  }
  async function nodeAction(name) {
    await branch.click({ button: "right" });
    await menuItem(name).click();
  }
  async function checkCanvasBounds() {
    const edges = await surface.evaluate((el) => {
      const doc = el.closest(".document");
      const area = doc.getBoundingClientRect();
      const heading = doc.querySelector(":scope > header").getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return [box.left - area.left, box.top - heading.bottom, area.right - box.right, area.bottom - box.bottom];
    });
    assert.ok(edges.every((gap) => Math.abs(gap) <= 1), `canvas edge gaps: ${edges}`);
  }
  await branch.waitFor();
  await checkCanvasBounds();
  assert.equal(await page.locator(".plugin-document .toolbar:visible").count(), 0);
  await branch.click({ button: "right" });
  await menuItem("备注").waitFor();
  if (process.env.WENOTE_MIND_PREVIEW) await page.locator(".document").screenshot({ path: process.env.WENOTE_MIND_PREVIEW });
  await page.keyboard.press("Escape");
  await menuItem("备注").waitFor({ state: "hidden" });
  await nodeAction("备注");
  await page.getByRole("dialog", { name: "备注" }).getByRole("textbox").fill("下周访谈");
  await checkCanvasBounds();
  await button("确定").click();
  const saveMap = () => saveFile(map, () => canvasAction("保存"));
  const saved = JSON.parse(await saveMap());
  assert.equal(saved.nodeData.children[0].note, "下周访谈");
  await button("普通.json").click();
  assert.equal(await page.locator(".native-mind").count(), 0);
  await button("路线.mind.json").click();
  await nodeAction("备注");
  assert.equal(await page.getByRole("dialog").getByRole("textbox").inputValue(), "下周访谈");
  await button("取消").click();
  await nodeAction("子主题");
  const input = page.locator("#input-box");
  if (await input.count()) {
    await input.fill("访谈");
    await input.press("Enter");
  }
  await canvasAction("撤销");
  await canvasAction("重做");
  await nodeAction("关系箭头");
  await page.getByRole("dialog").getByRole("combobox").selectOption("root");
  await button("确定").click();
  await canvasAction("切换布局");
  await canvasAction("切换导图主题");
  const expanded = JSON.parse(await saveMap());
  assert.equal(expanded.arrows.length, 1);
  assert.ok(expanded.theme.name);
  assert.equal(expanded.nodeData.children[0].children.length, 1);
  const [download] = await Promise.all([page.waitForEvent("download"), canvasAction("导出当前文件")]);
  assert.equal(download.suggestedFilename(), "路线.mind.json");
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".phone-document-head").waitFor();
  await verifyDock(mapCanvas, true);
  await infoButton.click();
  await checkCanvasBounds();
  await page.setViewportSize(desktopViewport);
  await page
    .locator('.entry-row[data-library-path="路线.mind.json"]')
    .click({ button: "right" });
  const item = (name) => page.getByRole("menuitem", { name, exact: true });
  await item("新建").hover();
  await item("思维导图").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称").fill("第二张");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".me-tpc").filter({ hasText: "第二张" }).waitFor();
  await button("第二张.mind.json").waitFor();
  await button("引用.md").click();
  await button("打开分屏编辑").click();
  assert.match(await page.getByLabel("笔记源码").innerText(), /\[home\]: \/home/);
  await button("打开个人设置").click();
  await button("编辑与插件").click();
  await button("Markdown 设置").click();
  assert.deepEqual(await page.getByLabel("默认打开模式").locator("option").allTextContents(), modeNames);
  if (process.argv.includes("--android")) {
    await (
      await import("./native-android.mjs")
    ).verifyAndroid(origin, email, password);
    for (let i=0;i<50;i++) {
      const remote=await (await api(folder+'/'+map.file_id+'/content')).json();
      if (remote.nodeData.children[0].note==='手机草稿') break;
      assert.ok(i < 49,'Android map sync timed out'); await delay(200);
    }
    assert.match(await (await api(folder+'/'+md.file_id+'/content')).text(),/手机/);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Three Markdown modes, Crepe edit/save, native diagram save/reopen and JSON dispatch passed",
  );
} finally {
  await browser?.close();
  server.kill();
  await once(server, "exit");
  await rm(temp, { recursive: true, force: true });
}
