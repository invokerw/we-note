import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("Set WENOTE_TEST_ORIGIN to a disposable instance");
const browser = await chromium.launch({ channel: "chrome" });
const email = `${randomUUID()}@example.invalid`;
const password = "settings-test-password";
const api = (path, body, token) =>
  fetch(origin + "/api/v1/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: "Bearer " + token }),
    },
    body: JSON.stringify(body),
  });
const button = (page, name) => page.getByRole("button", { name, exact: true });
async function login(page, pass = password) {
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码", { exact: true }).fill(pass);
  await button(page, "登录").click();
}
try {
  assert.ok((await api("auth/register", { email, password })).ok);
  const { access_token: token } = await (
    await api("auth/login", { email, password })
  ).json();
  const { id } = await (
    await api("vaults", { name: "头像验收" }, token)
  ).json();
  await api(
    `vaults/${id}/files`,
    { path: "草稿.md", content: Buffer.from("已保存").toString("base64") },
    token,
  );
  const desktop = await browser.newPage();
  desktop.setDefaultTimeout(10000);
  await login(desktop);
  await button(desktop, "全部笔记").waitFor();
  assert.equal(await desktop.getByLabel("笔记库菜单").count(), 0);
  await desktop.locator(".side-files .folders + button", {hasText: "回收站"}).click();
  await desktop.getByRole("heading", {name:"回收站"}).waitFor();
  assert.equal(await button(desktop, "草稿.md").count(), 0);
  await button(desktop, "全部笔记").click();
  await button(desktop, "草稿.md").click();
  await button(desktop, "编辑模式").click();
  await button(desktop, "分屏编辑").click();
  await desktop.getByLabel("笔记源码").fill("未保存的草稿");
  await button(desktop, "打开个人设置").click();
  await desktop.getByText(email, { exact: true }).waitFor();
  assert.equal(await desktop.getByText("收件箱", { exact: true }).count(), 0);
  assert.equal(await desktop.getByText("已发送", { exact: true }).count(), 0);
  assert.equal(
    await desktop.getByText("服务端管理", { exact: true }).count(),
    0,
  );
  await button(desktop, "导出").click();
  const settings = desktop.getByRole("dialog", {name:"个人设置"});
  await button(settings, "创建导出").click();
  const download = desktop.waitForEvent("download");
  await button(settings, "下载 ZIP").click();
  assert.equal((await download).suggestedFilename(), "wenote-all.zip");
  await button(desktop, "账户与安全").click();
  const png = await desktop.evaluate(
    () => document.createElement("canvas").toDataURL().split(",")[1],
  );
  const image = {
    name: "头像.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  };
  await desktop.getByLabel("更换头像").setInputFiles(image);
  await button(desktop, "取消更换").click();
  assert.equal(await desktop.locator(".profile-heading img").count(), 0);
  await desktop.getByLabel("更换头像").setInputFiles(image);
  await button(desktop, "保存头像").click();
  await desktop.getByText("头像已保存").waitFor();
  await button(desktop, "编辑与插件").click();
  await button(desktop, "Markdown 设置").click();
  await desktop.getByRole("dialog", {name:"Markdown 设置"})
    .getByRole("combobox", { name: "正文字号", exact: true })
    .selectOption("large");
  await button(desktop, "关闭 Markdown 设置").click();
  await desktop.keyboard.press("Escape");
  assert.equal(
    await desktop.getByLabel("笔记源码").innerText(),
    "未保存的草稿",
  );
  assert.equal(
    await desktop
      .locator(".document-mode")
      .first()
      .getAttribute("data-markdown-font-size"),
    "large",
  );
  await button(desktop, "分享").click();
  await desktop.getByText("有尚未保存的修改。").waitFor();
  await button(desktop, "取消").click();
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  mobile.setDefaultTimeout(10000);
  await login(mobile);
  await button(mobile, "打开笔记库目录").click();
  await button(mobile, "回收站").click();
  await mobile.getByRole("heading", {name:"回收站"}).waitFor();
  await button(mobile, "笔记").click();
  await button(mobile, "打开个人设置").click();
  await button(mobile, "编辑与插件").click();
  await button(mobile, "Markdown 设置").click();
  const plugin = mobile.getByRole("dialog", {name:"Markdown 设置", exact:true});
  assert.equal(await plugin.getByRole("combobox", {name:"正文字号", exact:true}).inputValue(), "large");
  await plugin.getByLabel("整理连续空行").scrollIntoViewIfNeeded();
  const box = await plugin.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
  await button(plugin, "关闭 Markdown 设置").click();
  await button(mobile, "返回设置分类").click();
  await button(mobile, "导出").click();
  await button(mobile, "下载 ZIP").waitFor();
  await button(mobile, "返回设置分类").click();
  await button(mobile, "账户与安全").click();
  await mobile.locator(".profile-heading img").waitFor();
  mobile.once("dialog", (d) => d.accept());
  await button(mobile, "恢复默认头像").click();
  await mobile.locator(".profile-heading img").waitFor({ state: "detached" });
  await mobile.keyboard.press("Escape");
  await button(mobile, "编辑与插件").waitFor();
  await button(desktop, "打开个人设置").click();
  await button(desktop, "修改密码").click();
  await desktop.getByLabel("当前密码", { exact: true }).fill(password);
  await desktop
    .getByLabel("新密码", { exact: true })
    .fill(password + "-changed");
  await desktop
    .getByLabel("确认新密码", { exact: true })
    .fill(password + "-changed");
  desktop.once("dialog", (d) => d.dismiss());
  await button(desktop, "确认修改密码").click();
  await button(desktop, "关闭个人设置").click();
  assert.equal(
    await desktop.getByLabel("笔记源码").innerText(),
    "未保存的草稿",
  );
  await button(desktop, "保存").click();
  await desktop.getByText("已保存新版本").waitFor();
  await button(desktop, "打开个人设置").click();
  await button(desktop, "修改密码").click();
  await desktop.getByLabel("当前密码", { exact: true }).fill(password);
  await desktop
    .getByLabel("新密码", { exact: true })
    .fill(password + "-changed");
  await desktop
    .getByLabel("确认新密码", { exact: true })
    .fill(password + "-changed");
  desktop.once("dialog", (d) => d.accept());
  await button(desktop, "确认修改密码").click();
  await button(desktop, "登录").waitFor();
  assert.equal((await api("me", undefined, token)).status, 401);
  assert.equal((await api("auth/login", { email, password })).status, 401);
  await login(desktop, password + "-changed");
  await button(desktop, "打开个人设置").waitFor();
  console.log(
    "通过桌面与手机宽度设置、头像保存/恢复、草稿保留、字号和改密会话撤销验收。",
  );
} finally {
  await browser.close();
}
