import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("set WENOTE_TEST_ORIGIN to a disposable test server");
const chrome = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  headless: true,
});
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function register(name) {
  const page = await (
    await chrome.newContext({ ignoreHTTPSErrors: true })
  ).newPage();
  page.setDefaultTimeout(10000);
  const email = `${name}-${randomUUID()}@example.invalid`;
  await page.goto(origin);
  await button(page, "创建账户").click();
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("phase-one-browser");
  await button(page, "注册并登录").click();
  page.once("dialog", (d) => d.accept(name));
  await button(page, "新建笔记库").click();
  await page.getByRole("heading", { name: "笔记库", exact: true }).waitFor();
  return { page, email };
}
try {
  const { page: a } = await register("Alice"),
    { page: b, email } = await register("Bob");
  a.once("dialog", (d) => d.accept("daily/验收.md"));
  await button(a, "新建笔记").click();
  await button(a, "源码").click();
  await a.getByLabel("笔记源码").fill("# 浏览器快照");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aQAAAABJRU5ErkJggg==",
    "base64",
  );
  await a
    .locator("article input[type=file]")
    .setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: png });
  await a.waitForFunction(() =>
    document.querySelector("textarea")?.value.includes("/assets/"),
  );
  await button(a, "保存").click();
  await a.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  await button(a, "阅读").click();
  await a.getByRole("heading", { name: "浏览器快照" }).waitFor();
  await a.waitForFunction(
    () => document.querySelector("article img")?.naturalWidth === 1,
  );
  const downloaded = a.waitForEvent("download");
  await button(a, "下载原文件").click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), "验收.md");
  assert.match(await readFile(await file.path(), "utf8"), /^# 浏览器快照/);
  const answers = [email, "daily/"];
  const dialogs = (d) => d.accept(answers.shift());
  a.on("dialog", dialogs);
  await button(a, "分享快照").click();
  await a.getByText("快照已发送").waitFor();
  a.off("dialog", dialogs);
  await button(a, "源码").click();
  await a.getByLabel("笔记源码").fill("# 发件人后续修改");
  await button(a, "保存").click();
  await a.getByText("已保存新版本").waitFor();
  await button(a, "历史").click();
  await button(a, "历史").waitFor();
  await a.getByRole("button", { name: /版本 2/ }).click();
  await a.locator("article pre").filter({ hasText: "浏览器快照" }).waitFor();
  await button(b, "收件箱").click();
  b.once("dialog", (d) => d.accept("导入"));
  await button(b, "导入快照").click();
  await b.getByText(/已导入/).waitFor();
  await button(b, "验收.md").click();
  await b.getByRole("heading", { name: "浏览器快照" }).waitFor();
  await b.waitForFunction(
    () => document.querySelector("article img")?.naturalWidth === 1,
  );
  await button(b, "源码").click();
  await b.getByLabel("笔记源码").fill("Bob 独立编辑");
  await button(b, "保存").click();
  await b.getByText("已保存新版本").waitFor();
  b.once("dialog", (d) => d.accept());
  await button(b, "移入回收站").click();
  await button(b, "回收站").click();
  b.once("dialog", (d) => d.accept("恢复.md"));
  await button(b, "恢复").click();
  await button(b, "恢复.md").click();
  await button(b, "阅读").click();
  assert.equal(await b.locator(".reading").innerText(), "Bob 独立编辑");
  console.log(
    "Browser acceptance passed: registration, source editing, private asset preview, version history, frozen directory share, recipient copy, trash and restore.",
  );
} finally {
  await chrome.close();
}
