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
  await button(a, "编辑模式").click();
  await button(a, "分屏编辑").click();
  await a.getByLabel("笔记源码").fill("# 浏览器快照");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aQAAAABJRU5ErkJggg==",
    "base64",
  );
  await a
    .locator("article input[type=file]")
    .setInputFiles({ name: "sample.png", mimeType: "image/png", buffer: png });
  await a.waitForFunction(() =>
    document.querySelector(".cm-content")?.textContent.includes("/assets/"),
  );
  await button(a, "保存").click();
  await a.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  await button(a, "编辑模式").click();
  await button(a, "预览").click();
  await a.getByRole("heading", { name: "浏览器快照" }).waitFor();
  await a.waitForFunction(
    () => document.querySelector("article img")?.naturalWidth === 1,
  );
  const downloaded = a.waitForEvent("download");
  await button(a, "更多操作").click();
  await button(a, "下载原文件").click();
  const file = await downloaded;
  assert.equal(file.suggestedFilename(), "验收.md");
  assert.match(await readFile(await file.path(), "utf8"), /^# 浏览器快照/);
  await button(a, "分享").click();
  await a.getByRole("dialog").waitFor();
  const link = await a.getByLabel("分享链接", { exact: true }).inputValue();
  await button(a, "关闭链接").click();
  await button(a, "编辑模式").click();
  await button(a, "分屏编辑").click();
  await a.getByLabel("笔记源码").fill("# 发件人后续修改");
  await button(a, "保存").click();
  await a.getByText("已保存新版本").waitFor();
  await button(a, "更多操作").click();
  await button(a, "历史版本").click();
  await a.getByRole("button", { name: /版本 2/ }).click();
  await a.locator("article pre").filter({ hasText: "浏览器快照" }).waitFor();
  const guest = await chrome.newPage({ viewport: { width: 390, height: 844 } });
  await guest.goto(link);
  await guest.getByRole("heading", { name: "浏览器快照" }).waitFor();
  assert.equal(await guest.getByRole("link", { name: "我的笔记库", exact: true }).count(), 0);
  await guest.waitForFunction(
    () => document.querySelector(".reading img")?.naturalWidth === 1,
  );
  const source = guest.waitForEvent("download");
  await button(guest, "下载源文件").click();
  const original = await source;
  assert.equal(original.suggestedFilename(), file.suggestedFilename());
  assert.deepEqual(
    await readFile(await original.path()),
    await readFile(await file.path()),
  );
  // Seed an existing nested directory in the recipient's vault.
  await b.evaluate(async () => {
    const headers = {
      Authorization: "Bearer " + sessionStorage.getItem("wenote-session"),
      "Content-Type": "application/json",
    };
    const { vaults } = await (
      await fetch("/api/v1/vaults", { headers })
    ).json();
    const res = await fetch(`/api/v1/vaults/${vaults[0].id}/files`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "工作/资料/目录示例.md", content: "" }),
    });
    if (!res.ok) throw Error("seed recipient folders");
  });
  await button(guest, "保存到我的笔记").click();
  const modal = guest.getByRole("dialog", { name: "保存到我的笔记" });
  await modal.waitFor({ timeout: 3000 });
  await modal.getByLabel("邮箱").fill(email);
  await modal.getByLabel("密码", { exact: true }).fill("phase-one-browser");
  await button(modal, "登录").click();
  await button(modal, "资料").click();
  await modal.getByText("Bob / 工作 / 资料", { exact: true }).waitFor();
  await button(modal, "取消").click();
  await modal.waitFor({ state: "hidden" });
  await button(guest, "保存到我的笔记").click();
  await button(modal, "资料").click();
  await button(modal, "确认保存").click();
  await guest.getByRole("link", { name: "打开已保存的笔记" }).click();
  await guest.getByRole("heading", { name: "验收.md" }).waitFor();
  await guest
    .getByRole("heading", { name: "验收.md" })
    .and(guest.locator('[title="工作/资料/验收.md"]'))
    .waitFor();
  await button(a, "打开个人设置").click();
  await button(a, "我的分享").click();
  a.once("dialog", d => d.accept());
  await button(a, "撤销链接").click();
  const expired = await chrome.newPage();
  await expired.goto(link);
  await expired.getByText("分享链接已失效").waitFor();
  await b.reload();
  await button(b, "验收.md").click();
  await button(b, "编辑模式").click();
  await button(b, "预览").click();
  await b.getByRole("heading", { name: "浏览器快照" }).waitFor();
  await b.waitForFunction(
    () => document.querySelector("article img")?.naturalWidth === 1,
  );
  await button(b, "编辑模式").click();
  await button(b, "分屏编辑").click();
  await b.getByLabel("笔记源码").fill("Bob 独立编辑");
  await button(b, "保存").click();
  await b.getByText("已保存新版本").waitFor();
  b.once("dialog", (d) => d.accept());
  await button(b, "更多操作").click();
  await button(b, "移入回收站").click();
  await b.getByLabel("笔记库菜单").click();
  await button(b, "回收站").click();
  b.once("dialog", (d) => d.accept("恢复.md"));
  await button(b, "恢复").click();
  await button(b, "恢复.md").click();
  await button(b, "编辑模式").click();
  await button(b, "预览").click();
  assert.equal(await b.locator(".reading").innerText(), "Bob 独立编辑");
  console.log(
    "Browser acceptance passed: registration, source editing, private asset preview, version history, mobile guest reading, source download, frozen note share, saved copy and revocation, trash and restore.",
  );
} finally {
  await chrome.close();
}
