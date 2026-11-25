import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("WENOTE_TEST_ORIGIN is required");
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
});
try {
  let token = "";
  async function api(route, method = "GET", body) {
    const response = await fetch(origin + route, {
      method,
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(response.ok, await response.clone().text());
    return response;
  }
  const credentials = {
    email: randomUUID() + "@example.invalid",
    password: "theme-toggle-test",
  };
  await api("/api/v1/auth/register", "POST", credentials);
  token = (await (await api("/api/v1/auth/login", "POST", credentials)).json())
    .access_token;
  const vault = (
    await (await api("/api/v1/vaults", "POST", { name: "主题验收" })).json()
  ).id;
  const route = `/api/v1/vaults/${vault}/files`;
  async function create(path, content) {
    await api(route, "POST", {
      path,
      content: Buffer.from(content).toString("base64"),
    });
  }
  const xmind = await readFile(
    new URL("./fixtures/sdk-workbook.xmind", import.meta.url),
  );
  await create(
    "主题.md",
    "# 深浅色验收\n\n正文内容。\n\n`inline`\n\n```js\nconst value = 1;\n```\n",
  );
  await api("/api/v1/me/plugin-settings/com.wenote.md", "PUT", {
    theme: "clean",
    defaultMode: "read",
  });
  await api("/api/v1/me/plugin-settings/com.wenote.xmind", "PUT", {
    theme: "classic",
  });
  await create("计划.mind.json", JSON.stringify({ nodeData: { id: "root", topic: "本周计划" } }));
  await api(route, "POST", {
    path: "路线.xmind",
    content: xmind.toString("base64"),
  });

  const page = await browser.newPage({ viewport: { width: 1900, height: 1046 }, timezoneId: "Asia/Shanghai", colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("wenote-color-scheme-v1", "dark"));
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  await button("登录").click();

  await button("主题.md").click();
  const reading = page.locator(".document-mode .reading");
  await reading.waitFor();
  const geometry = async () => Promise.all([".sidebar", ".note-list-pane", ".workspace"].map(async (selector) => {
    const box = await page.locator(selector).boundingBox();
    return box && [box.x, box.width];
  }));
  assert.deepEqual(await geometry(), [[0, 202], [202, 313], [515, 1385]]);
  const style = async (selector, property) => page.locator(selector).first().evaluate((el, key) => getComputedStyle(el)[key], property);
  const theme = (name) => page.waitForFunction((value) => document.documentElement.dataset.colorScheme === value && document.documentElement.dataset.mantineColorScheme === value, name);
  const openAppearance = async () => {
    await button("打开个人设置").click();
    await button("外观").click();
  };
  const radio = (name) => page.getByRole("radio", { name, exact: true });
  await openAppearance();
  assert.ok(await radio("深色").isChecked());
  await theme("dark");
  assert.equal(await style(".sidebar", "backgroundColor"), "rgb(21, 28, 39)");
  assert.notEqual(await style(".reading", "backgroundColor"), "rgb(255, 255, 255)");
  await radio("浅色").check();
  await theme("light");
  assert.equal(await style(".sidebar", "backgroundColor"), "rgb(249, 250, 251)");
  assert.equal(await style(".reading", "fontSize"), "14px");
  assert.equal(await style(".reading", "backgroundColor"), "rgb(255, 255, 255)");
  assert.equal(await style(".reading h1", "fontSize"), "24px");
  assert.equal(await style(".document-head", "height"), "75px");
  await page.emulateMedia({ colorScheme: "dark" });
  await theme("light");
  await radio("跟随系统").check();
  await theme("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await theme("light");
  await page.clock.install({ time: new Date("2026-11-25T18:58:00+08:00") });
  await radio("按时间切换").check();
  assert.equal(await page.getByLabel("浅色开始").inputValue(), "07:00");
  const darkStart = page.getByLabel("深色开始");
  await darkStart.fill("07:00");
  await page.getByText("两个开始时间需要不同。", {exact:true}).waitFor();
  await darkStart.fill("18:59");
  await button("关闭个人设置").click();
  await button("编辑模式").click();
  await button("分屏编辑").click();
  const editor = page.getByLabel("笔记源码");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("草稿位置");
  const position = () => page.evaluate(() => [getSelection().anchorNode?.textContent, getSelection().anchorOffset]);
  const cursor = await position();
  await page.clock.fastForward(60000);
  await theme("dark");
  assert.deepEqual(await position(), cursor);
  assert.match(await editor.innerText(), /草稿位置/);
  await button("单栏布局").click();
  await button("退出专注").click();
  assert.match(await editor.innerText(), /草稿位置/);
  await button("保存").click();
  await button("已保存").waitFor();
  await page.reload();
  await openAppearance();
  assert.ok(await radio("按时间切换").isChecked());
  assert.equal(await darkStart.inputValue(), "18:59");
  await page.clock.setSystemTime(new Date("2026-11-26T08:00:00+08:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await theme("light");
  await button("关闭个人设置").click();
  await button("计划.mind.json").click();
  const map = page.locator(".native-mind .map-container");
  await map.waitFor();
  const lightCanvas = await style(".native-mind .map-container", "backgroundColor");
  await openAppearance();
  await radio("深色").check();
  await button("关闭个人设置").click();
  assert.notEqual(await style(".native-mind .map-container", "backgroundColor"), lightCanvas);
  assert.equal(await style(".native-mind .map-container", "backgroundColor"), "rgb(17, 23, 32)");
  await page.setViewportSize({ width: 800, height: 800 });
  await button("打开目录").waitFor();
  assert.deepEqual((await geometry()).slice(1), [[0, 240], [240, 560]]);
  await button("打开目录").click();
  await page.getByRole("button", {name:"我的文件夹",exact:true}).click({button:"right"});
  await page.getByRole("menuitem", {name:"新建",exact:true}).focus();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "menuitem");
  await page.keyboard.press("Escape");
  await button("全部笔记").click();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await button("文件夹").click();
  await button("打开个人设置").click();
  await button("外观").click();
  await radio("深色").check();
  await button("关闭个人设置").click();
  await button("笔记").click();
  await button("路线.xmind").click();
  await page.locator('.mindmap-stage[data-xmind-theme="classic"]').waitFor();
  assert.equal(await style('.mindmap-stage', 'backgroundColor'), 'rgb(20, 27, 38)');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("Appearance settings, automatic changes, draft selection, persistence and responsive layout passed.");
} finally {
  await browser.close();
}
