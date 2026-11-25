import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
const chrome = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
});
try {
  const email = randomUUID() + "@example.invalid",
    password = "phase-two-browser";
  let token = "";
  async function api(path, method = "GET", body) {
    const r = await fetch(origin + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r;
  }
  await api("/api/v1/auth/register", "POST", { email, password });
  const session = await (
    await api("/api/v1/auth/login", "POST", { email, password })
  ).json();
  token = session.access_token;
  await api("/api/v1/me/plugin-settings/com.wenote.md", "PUT", {
    defaultMode: "read",
    rememberNoteMode: false,
  });
  const { id } = await (
    await api("/api/v1/vaults", "POST", { name: "阶段二" })
  ).json();
  const base = `/api/v1/vaults/${id}`;
  const text = [
    "---",
    "tags: [例会]",
    "owner: 编辑组",
    "---",
    "# 路线图",
    "",
    "保持原样。",
    "",
    "## 交付",
    "",
    "[[目标|相关笔记]] #计划",
    "",
    "- [ ] 准备",
    "",
    "| 项目 | 数量 |",
    "| --- | --- |",
    "| 子项 | 3 |",
    "",
    "> [!NOTE]",
    "> 下一步",
    "",
    "公式 $a^2+b^2=c^2$",
    "",
    "```mermaid",
    "graph TD",
    "  A[草稿] --> B[发布]",
    "```",
    "",
  ]
    .join("\r\n")
    .replace("保持原样。\r\n", "保持原样。\n");
  const first = await (
    await api(base + "/files", "POST", {
      path: "工作/路线.md",
      content: Buffer.from("\ufeff" + text).toString("base64"),
    })
  ).json();
  await api(base + "/files", "POST", {
    path: "工作/目标.md",
    content: Buffer.from("# 目标文件").toString("base64"),
  });
  const page = await chrome.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && /CodeMirror plugin crashed/.test(m.text()))
      errors.push(m.text());
  });
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("登录").click();
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByLabel("搜索笔记").fill("路线");
  await button("路线.md").waitFor();
  assert.equal(await button("目标.md").count(), 0);
  await button("文件夹").click();
  await page.getByRole("button", { name: /^工作.*篇笔记$/ }).click();
  await button("路线.md").click();
  await button("返回笔记列表").waitFor();
  await page.setViewportSize(wide);
  await page.locator(".reading table td").first().waitFor();
  await page.locator(".reading .katex").waitFor();
  await page.locator(".reading .callout").waitFor();
  await page.waitForFunction(
    () => document.querySelector('img[alt="Mermaid 图表"]')?.naturalWidth > 0,
  );
  await button("编辑模式").click();
  await button("分屏编辑").click();
  const split = page.locator(".split-editor");
  const panelToggle = button("笔记信息");
  const metadata = page.getByRole("complementary", { name: "笔记信息" });
  assert.equal(await panelToggle.getAttribute("aria-expanded"), "false");
  await panelToggle.click();
  await metadata.getByRole("button", { name: "交付" }).waitFor();
  await metadata.getByText("编辑组", { exact: true }).waitFor();
  await metadata.getByText("没有笔记链接到此处。", { exact: true }).waitFor();
  const panelBox = await metadata.boundingBox(),
    splitBox = await split.boundingBox();
  assert.ok(Math.abs(panelBox.x - splitBox.x - splitBox.width) <= 1);
  await panelToggle.click();
  assert.equal(await metadata.isVisible(), false);
  const divider = split.getByRole("separator");
  await split.locator('[aria-orientation="vertical"]').waitFor();
  await divider.scrollIntoViewIfNeeded();
  const grip = await divider.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  const resizedBox = await split.boundingBox();
  await page.mouse.move(resizedBox.x + resizedBox.width * 0.65, grip.y + grip.height / 2, {steps:8});
  await page.mouse.up();
  assert.ok(Number(await divider.getAttribute("aria-valuenow")) > 50);
  await divider.dblclick();
  await divider.press("ArrowRight");
  assert.equal(await divider.getAttribute("aria-valuenow"), "55");
  await divider.dblclick();
  assert.equal(await divider.getAttribute("aria-valuenow"), "50");
  await page.setViewportSize({ width: 390, height: 800 });
  await split.locator('[aria-orientation="horizontal"]').waitFor();
  const narrow = await split.boundingBox();
  await panelToggle.click();
  const drawer = await metadata.boundingBox();
  assert.equal((await split.boundingBox()).width, narrow.width);
  assert.ok(Math.abs(drawer.x + drawer.width - narrow.x - narrow.width) <= 1);
  assert.ok(Math.abs((await split.boundingBox()).y + (await split.boundingBox()).height - drawer.y) <= 1);
  await panelToggle.click();
  await divider.press("ArrowDown");
  assert.equal(await divider.getAttribute("aria-valuenow"), "55");
  await page.setViewportSize(wide);
  await split.locator('[aria-orientation="vertical"]').waitFor();
  const sections = Array.from(
    { length: 50 },
    (_, i) => `## 章节 ${i}\n\n${"带有 **加粗** 的段落。".repeat((i % 6) + 1)}`,
  );
  await split.getByLabel("笔记源码").fill(sections.join("\n\n"));
  const sourceScroll = split.locator(".cm-scroller"),
    previewScroll = split.locator(".split-preview");
  const top = (el) => el.scrollTop;
  await divider.focus();
  await sourceScroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForFunction(
    () => document.querySelector(".split-preview").scrollTop === 0,
  );
  await sourceScroll.evaluate((el) => {
    el.scrollTop = 900;
  });
  await page.waitForFunction(
    () => document.querySelector(".split-preview").scrollTop > 100,
  );
  await previewScroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForFunction(
    () => document.querySelector(".split-editor .cm-scroller").scrollTop === 0,
  );
  await button("同步滚动").click();
  await previewScroll.evaluate((el) => {
    el.scrollTop = 500;
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await sourceScroll.evaluate(top), 0);
  await button("同步滚动").click();
  assert.equal(await previewScroll.evaluate(top), 0);
  await split.getByLabel("笔记源码").fill("父项\n子项");
  await split.getByLabel("笔记源码").press("ControlOrMeta+End");
  await split.getByLabel("笔记源码").press("Tab");
  assert.equal(
    (await split.getByLabel("笔记源码").locator(".cm-line").allTextContents()).join(
      "\n",
    ),
    "父项\n  子项",
  );
  await split.getByLabel("笔记源码").fill("分屏草稿");
  await split.getByLabel("笔记源码").press("ControlOrMeta+a");
  await button("加粗").click();
  assert.equal(await split.locator(".reading strong").innerText(), "分屏草稿");
  await button("我的文件夹").click();
  assert.equal(await split.getByLabel("笔记源码").innerText(), "**分屏草稿**");
  await button("编辑模式").click();
  await button("可视化编辑").click();
  const writing = page.getByLabel("可视化编辑器").locator(".ProseMirror[contenteditable=true]");
  const keys = page.keyboard;
  async function switchMode(name) {
    await button("编辑模式").click();
    await button(name).click();
  }
  async function checkSource(expected) {
    await switchMode("分屏编辑");
    const lines = page.getByLabel("笔记源码").locator(".cm-line");
    assert.equal((await lines.allTextContents()).join("\n"), expected);
    await switchMode("可视化编辑");
  }
  async function writeDraft(value) {
    await writing.press("ControlOrMeta+a");
    if (value) await keys.insertText(value);
    else await keys.press("Backspace");
  }
  async function clickTextAt(locator, text, offset) {
    const point = await locator.evaluate(
      (el, { text, offset }) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode,
            index = node.textContent.indexOf(text);
          if (index < 0) continue;
          const r = document.createRange();
          r.setStart(node, index + offset);
          r.collapse(true);
          const rect = r.getBoundingClientRect();
          return { x: rect.x, y: rect.y + rect.height / 2 };
        }
        throw Error("Missing editable text: " + text);
      },
      { text, offset },
    );
    await page.mouse.click(point.x, point.y);
  }
  assert.equal(
    await writing.evaluate((el) => el === document.activeElement),
    true,
  );
  await writeDraft("父项\n子项");
  await writing.press("ControlOrMeta+End");
  await keys.press("Tab");
  await checkSource("父项\n  子项");
  await writeDraft("**分屏草稿**");
  await clickTextAt(writing, "分屏草稿", 2);
  const ime = await page.context().newCDPSession(page);
  for (const text of ["z", "zhong"])
    await ime.send("Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  await writing.evaluate((el) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        isComposing: true,
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await ime.send("Input.insertText", { text: "中" });
  await ime.detach();
  await checkSource("**分屏中草稿**");

  await writeDraft("清晨整理笔记");
  await clickTextAt(writing, "清晨整理笔记", 2);
  await keys.press("Enter");
  await checkSource("清晨\n\n整理笔记");
  await keys.press("Backspace");
  await checkSource("清晨整理笔记");
  await keys.press("ControlOrMeta+z");
  await checkSource("清晨\n\n整理笔记");
  await keys.press("ControlOrMeta+Shift+z");
  await keys.press("Shift+Enter");
  await checkSource("清晨  \n整理笔记");

  await writeDraft("第一段\n\n第二段");
  await clickTextAt(writing, "第一段", 3);
  await keys.insertText("补记");
  await clickTextAt(writing, "第二段", 2);
  await keys.press("ControlOrMeta+z");
  await checkSource("第一段\n\n第二段");
  await clickTextAt(writing, "第一段", 1);
  await keys.down("Shift");
  await keys.press("ArrowDown");
  await keys.up("Shift");
  await keys.insertText("起");
  await checkSource("第起二段");
  await keys.press("ControlOrMeta+z");
  await writing.press("ControlOrMeta+a");
  await writing.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "从剪贴板\r\n\r\n粘贴全文");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await checkSource("从剪贴板\n\n粘贴全文");
  await keys.press("ControlOrMeta+z");
  await checkSource("第一段\n\n第二段");

  await writing.press("ControlOrMeta+a");
  await keys.press("ControlOrMeta+b");
  await checkSource("**第一段**\n\n**第二段**");
  await keys.press("ControlOrMeta+b");
  await checkSource("第一段\n\n第二段");
  await writeDraft("");
  await keys.press("ControlOrMeta+b");
  await keys.insertText("行内撰写");
  await keys.press("ControlOrMeta+b");
  await keys.insertText("收尾");
  await checkSource("**行内撰写**收尾");
  await clickTextAt(writing, "行内撰写", 2);
  await keys.press("Enter");
  await checkSource("**行内**\n\n**撰写**收尾");
  await writeDraft("写清楚");
  await button("标题").click();
  await checkSource("## 写清楚");
  await writeDraft("- [x] 第一项");
  await keys.press("Enter");
  await keys.insertText("第二项");
  await keys.press("Enter");
  await keys.press("Enter");
  await keys.insertText("正文");
  await checkSource("- [x] 第一项\n- [ ] 第二项\n\n正文");
  await writeDraft("1. 一");
  await keys.press("Enter");
  await keys.insertText("二");
  await checkSource("1. 一\n2. 二");
  await writeDraft("```js");
  await keys.press("Enter");
  await keys.insertText("let n = 1");
  await keys.press("Enter");
  await keys.insertText("n++");
  await checkSource("```js\nlet n = 1\nn++\n```");
  await button("工作").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await button("目标.md").click();
  await button("路线.md").click();
  await button("编辑模式").click();
  await button("可视化编辑").click();
  await writing.locator(".live-preview table td").first().waitFor();
  await writing.locator(".katex").waitFor();
  await writing.locator(".callout").waitFor();
  await writing.locator('img[alt="Mermaid 图表"]').waitFor();
  await clickTextAt(writing.locator("table"), "子项", 1);
  await keys.insertText("表");
  await writing.getByText("保持原样。", { exact: true }).click();
  assert.equal(
    await writing.locator("table tbody td").first().innerText(),
    "子表项",
  );
  await keys.press("ControlOrMeta+z");
  await clickTextAt(writing, "保持原样。", 0);
  for (let i = 0; i < "保持原样。".length; i++)
    await keys.press("Shift+ArrowRight");
  await keys.insertText("新的正文。");
  await button("更多操作").click();
  await button("专注模式").click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await button("退出专注").click();
  await writing.getByText("新的正文。", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: "任务完成" }).click();
  await writing.press("ControlOrMeta+s");
  await page.getByText("已保存新版本").waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "笔记正文",
  );
  const bytes = Buffer.from(
    await (
      await api(base + "/files/" + first.file_id + "/content")
    ).arrayBuffer(),
  );
  assert.deepEqual(
    bytes,
    Buffer.from(
      "\ufeff" +
        text.replace("保持原样。", "新的正文。").replace("- [ ]", "- [x]"),
    ),
  );
  await button("编辑模式").click();
  await button("思维导图").click();
  const map = page.getByRole("navigation", { name: "标题树思维导图" });
  await map.getByRole("button", { name: "交付" }).click();
  await page.locator(".reading h2").waitFor();
  await panelToggle.click();
  await page.getByText("编辑组", { exact: true }).waitFor();
  await page.getByRole("link", { name: "相关笔记" }).click();
  await page.getByRole("heading", { name: "目标文件" }).waitFor();
  await panelToggle.click();
  await metadata
    .getByRole("region", { name: "反向链接" })
    .getByRole("button", { name: "工作/路线.md" })
    .click();
  await switchMode("可视化编辑");
  await clickTextAt(writing, "新的正文。", "新的正文。".length);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aQAAAABJRU5ErkJggg==";
  await writing.evaluate((el, b64) => {
    const data = new DataTransfer();
    data.items.add(
      new File(
        [Uint8Array.from(atob(b64), (s) => s.charCodeAt(0))],
        "剪贴板.png",
        { type: "image/png" },
      ),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, png);
  await writing.locator('img[alt="剪贴板.png"]').waitFor();
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("aria-label") === "笔记正文",
  );
  await keys.insertText("图注");
  await switchMode("分屏编辑");
  const withImage = (
    await page.getByLabel("笔记源码").locator(".cm-line").allTextContents()
  ).join("\n");
  assert.match(withImage, /新的正文。\n!\[剪贴板.png\]\([^)]+\)\n图注/);
  await button("保存").click();
  await page.getByText("已保存新版本").waitFor();
  await switchMode("预览");
  await page.waitForFunction(() => document.querySelector('img[alt="剪贴板.png"]')?.naturalWidth === 1);
  await page.getByRole("searchbox", {name:"搜索笔记"}).fill("新的正文");
  await button("路线.md").click();
  await page.locator(".reading").getByText("新的正文。").waitFor();
  await button("打开个人设置").click();
  await button("导出").click();
  await button("创建导出").click();
  const wait = page.waitForEvent("download");
  await button("下载 ZIP").click();
  assert.equal((await wait).suggestedFilename(), "wenote-all.zip");
  await page.getByLabel("图片链接").selectOption("portable");
  await button("创建导出").click();
  const portableDownload = page.waitForEvent("download");
  await page
    .locator(".row")
    .filter({ hasText: "离线便携" })
    .getByRole("button", { name: "下载 ZIP" })
    .click();
  const saved = await portableDownload;
  assert.equal(saved.suggestedFilename(), "wenote-all-portable.zip");
  await button("关闭个人设置").click();
  const zip = unzipSync(await readFile(await saved.path()));
  const localDir = await mkdtemp(join(tmpdir(), "wenote-portable-"));
  const offline = await chrome.newContext({ offline: true });
  try {
    const note = "notes/工作/路线.md";
    const manifest = JSON.parse(Buffer.from(zip["manifest.json"]));
    const img = manifest.assets.find((a) => a.original_name === "剪贴板.png");
    for (const path of [note, img.path]) {
      const filename = join(localDir, path);
      await mkdir(dirname(filename), { recursive: true });
      await writeFile(filename, zip[path]);
    }
    const markdown = await readFile(join(localDir, note), "utf8");
    const relative = markdown.match(/!\[剪贴板.png\]\(([^)]+)\)/)?.[1];
    assert.ok(relative?.startsWith("../../assets/"), markdown);
    const image = new URL(relative, pathToFileURL(join(localDir, note)));
    assert.equal(fileURLToPath(image), join(localDir, img.path));
    const viewer = await offline.newPage();
    await viewer.goto(image.href);
    assert.equal(
      await viewer.locator("img").evaluate((el) => el.naturalWidth),
      1,
    );
  } finally {
    await offline.close();
    await rm(localDir, { recursive: true, force: true });
  }
  await button("路线.md").click();
  await button("编辑模式").click();
  await button("分屏编辑").click();
  const file = {
    name: "resume.png",
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(4 << 20, 0x6a)]),
  };
  const seen = [];
  let interrupt = true;
  await page.route("**/assets/*/parts/*", (route) => {
    const number = Number(route.request().url().split("/").pop());
    seen.push(number);
    if (interrupt && number === 2)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: "模拟传输中断" }),
      });
    return route.continue();
  });
  const picker = page.locator("input[type=file]").last();
  await picker.setInputFiles(file);
  await page.getByText(/模拟传输中断/).waitFor();
  interrupt = false;
  seen.length = 0;
  await page.reload();
  await button("路线.md").click();
  await button("编辑模式").click();
  await button("分屏编辑").click();
  await picker.setInputFiles(file);
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent.includes("resume.png"),
  );
  assert.deepEqual(seen.sort(), [2, 4]);
  const assets = await (await api(base + "/assets")).json();
  const completed = assets.filter((a) => a.name === "resume.png");
  assert.equal(completed.length, 1);
  assert.deepEqual(
    Buffer.from(
      await (await api("/assets/" + completed[0].asset_id)).arrayBuffer(),
    ),
    file.buffer,
  );
  console.log(
    "Multipart browser acceptance passed: reload, missing parts only, verified original bytes.",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Phase 2 browser acceptance passed: rich Markdown, byte-preserving live edits, heading map, links, search, clipboard, asset preview, online ZIP and offline portable ZIP image.",
  );
} finally {
  await chrome.close();
}
