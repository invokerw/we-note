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
  const page = await chrome.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("登录").click();
  const wide = page.viewportSize();
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByLabel("筛选笔记路径").fill("路线");
  await button("路线.md").waitFor();
  assert.equal(await button("目标.md").count(), 0);
  await button("目录").click();
  await button("工作").click();
  await button("路线.md").click();
  assert.equal(await button("正文").getAttribute("aria-pressed"), "true");
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
  const grip = await divider.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + 65, grip.y + grip.height / 2);
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
  await split.getByLabel("笔记源码").fill("分屏草稿");
  await split.getByLabel("笔记源码").press("ControlOrMeta+a");
  await button("加粗").click();
  assert.equal(await split.locator(".reading strong").innerText(), "分屏草稿");
  await button("我的文件夹").click();
  assert.equal(await split.getByLabel("笔记源码").innerText(), "**分屏草稿**");
  await button("编辑模式").click();
  await button("所见所得").click();
  const draft = page.locator(".live strong [data-text-start]");
  const caret = await draft.evaluate((el) => {
    const range = document.createRange();
    range.setStart(el.firstChild, 2);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(caret.x, caret.y);
  const currentBlock = page.getByLabel("当前段落源码");
  const ime = await page.context().newCDPSession(page);
  await ime.send("Input.imeSetComposition", {
    text: "zhong",
    selectionStart: 5,
    selectionEnd: 5,
  });
  await ime.send("Input.insertText", { text: "中" });
  await ime.detach();
  await currentBlock.press("Escape");
  assert.equal(await page.locator(".live strong").innerText(), "分屏中草稿");
  await page.locator(".live strong").click();
  await currentBlock.fill("行内撰写");
  await currentBlock.press("ControlOrMeta+a");
  await currentBlock.press("ControlOrMeta+b");
  await currentBlock.locator(".live-strong").waitFor();
  await currentBlock.press("ControlOrMeta+b");
  assert.equal(await currentBlock.textContent(), "行内撰写");
  await currentBlock.press("ControlOrMeta+b");
  await currentBlock.locator(".live-strong").waitFor();
  await currentBlock.press("ArrowRight");
  await currentBlock.press("End");
  await currentBlock.press("Enter");
  await page.keyboard.insertText("接着写。");
  await currentBlock.press("Escape");
  await page
    .locator(".live .reading strong")
    .filter({ hasText: "行内撰写" })
    .waitFor();
  await page
    .locator(".live .reading > p")
    .filter({ hasText: "接着写。" })
    .focus();
  await page.keyboard.press("Enter");
  await currentBlock.press("Home");
  await currentBlock.press("ArrowUp");
  await currentBlock.filter({ hasText: "行内撰写" }).waitFor();
  await currentBlock.press("Escape");
  await button("工作").first().click();
  page.once("dialog", (dialog) => dialog.accept());
  await button("目标.md").click();
  await button("路线.md").click();
  await button("编辑模式").click();
  await button("所见所得").click();
  await page.getByText("保持原样。", { exact: true }).click();
  await page.getByLabel("当前段落源码").fill("新的正文。");
  await button("更多操作").click();
  await button("专注模式").click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await button("退出专注").click();
  assert.equal(await page.getByLabel("当前段落源码").innerText(), "新的正文。");
  await button("完成段落").click();
  await page.getByRole("checkbox", { name: "任务完成" }).click();
  await button("保存").click();
  await page.getByText("已保存新版本").waitFor();
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
  await button("编辑模式").click();
  await button("源码").click();
  const source = page.getByLabel("笔记源码");
  await source.click();
  await source.press("Control+End");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aQAAAABJRU5ErkJggg==";
  await source.evaluate((el, b64) => {
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
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent.includes("/assets/"),
  );
  await button("保存").click();
  await page.getByText("已保存新版本").waitFor();
  await button("附件").click();
  await page.getByText("剪贴板.png", { exact: true }).waitFor();
  await button("预览").click();
  await page.waitForFunction(
    () => document.querySelector(".asset-row img")?.naturalWidth === 1,
  );
  await button("搜索").click();
  await page.getByLabel("全文搜索").fill("新的正文");
  await button("#例会 · 1").click();
  await button("工作/路线.md").click();
  await page.locator(".reading").getByText("新的正文。").waitFor();
  await button("导出").click();
  await button("创建导出").click();
  const wait = page.waitForEvent("download");
  await button("下载 ZIP").click();
  assert.equal((await wait).suggestedFilename(), "wenote-all.zip");
  await page.getByLabel("附件链接").selectOption("portable");
  await button("创建导出").click();
  const portableDownload = page.waitForEvent("download");
  await page
    .locator(".row")
    .filter({ hasText: "离线便携" })
    .getByRole("button", { name: "下载 ZIP" })
    .click();
  const saved = await portableDownload;
  assert.equal(saved.suggestedFilename(), "wenote-all-portable.zip");
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
  await button("源码").click();
  const file = {
    name: "resume.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc((4 << 20) + 17, 0x6a),
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
  await button("源码").click();
  await picker.setInputFiles(file);
  await page.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent.includes("resume.bin"),
  );
  assert.deepEqual(seen.sort(), [2, 4]);
  const assets = await (await api(base + "/assets")).json();
  const completed = assets.filter((a) => a.name === "resume.bin");
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
