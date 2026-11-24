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
  await api(route, "POST", {
    path: "路线.xmind",
    content: xmind.toString("base64"),
  });

  const page = await browser.newPage({ viewport: { width: 1900, height: 1046 } });
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
  assert.equal(await style(".sidebar", "backgroundColor"), "rgb(249, 250, 251)");
  assert.equal(await style(".reading", "fontSize"), "14px");
  assert.equal(await style(".reading", "backgroundColor"), "rgb(255, 255, 255)");
  assert.equal(await style(".reading h1", "fontSize"), "24px");
  assert.equal(await style(".document-head", "height"), "75px");
  assert.equal(await page.getByRole("button", { name: /切换到[深浅]色模式/ }).count(), 0);
  await button("编辑模式").click();
  await button("源码").click();
  const editor = page.locator(".cm-content[contenteditable=true]");
  await editor.focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("草稿位置");
  await button("单栏布局").click();
  await button("退出专注").click();
  assert.match(await editor.innerText(), /草稿位置/);
  await button("保存").click();
  await button("已保存").waitFor();
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
  await button("笔记").click();
  await button("路线.xmind").click();
  await page.locator('.mindmap-stage[data-xmind-theme="classic"]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log("Workspace geometry, light palette, draft, save and responsive navigation passed.");
} finally {
  await browser.close();
}
