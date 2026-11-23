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

  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  await button("登录").click();

  const lightToggle = button("切换到深色模式");
  await lightToggle.waitFor();
  assert.equal(await page.locator("html").getAttribute("data-color-scheme"), "light");
  await page.getByRole("button", { name: "主题.md", exact: true }).click();
  await page.locator('.document-mode[data-markdown-theme="clean"] .reading').waitFor();
  const lightMarkdown = await page.locator('.document-mode[data-markdown-theme="clean"] .reading').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
  }));
  assert.notEqual(lightMarkdown.background, "rgb(18, 24, 33)");
  await lightToggle.click();
  await button("切换到浅色模式").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-color-scheme"), "dark");
  assert.equal(await page.evaluate(() => localStorage.getItem("wenote-color-scheme-v1")), "dark");
  const darkMarkdown = await page.locator('.document-mode[data-markdown-theme="clean"] .reading').evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
    inlineCode: getComputedStyle(element.querySelector("code")).color,
  }));
  assert.equal(darkMarkdown.background, "rgb(18, 24, 33)");
  assert.notEqual(darkMarkdown.color, "rgb(41, 52, 70)");
  assert.notEqual(darkMarkdown.inlineCode, "rgb(40, 67, 108)");
  for (const [theme, background] of [
    ["clean", "rgb(18, 24, 33)"],
    ["paper", "rgb(33, 28, 25)"],
    ["developer", "rgb(17, 26, 44)"],
  ]) {
    await api("/api/v1/me/plugin-settings/com.wenote.md", "PUT", {
      theme,
      defaultMode: "read",
    });
    await page.reload();
    await button("切换到浅色模式").waitFor();
    await page.getByRole("button", { name: "主题.md", exact: true }).click();
    const reading = page.locator(`.document-mode[data-markdown-theme="${theme}"] .reading`);
    await reading.waitFor();
    assert.equal(await reading.evaluate((element) => getComputedStyle(element).backgroundColor), background);
  }

  await api("/api/v1/me/plugin-settings/com.wenote.xmind", "PUT", {
    theme: "classic",
  });
  await page.reload();
  await button("切换到浅色模式").waitFor();
  await page.getByRole("button", { name: "路线.xmind", exact: true }).click();
  const darkMap = page.locator('.mindmap-stage[data-xmind-theme="classic"]');
  await darkMap.waitFor();
  const darkMapStyle = await darkMap.evaluate((element) => {
    const node = element.querySelectorAll(".mindmap-node")[1];
    return {
      background: getComputedStyle(element).backgroundColor,
      node: getComputedStyle(node.querySelector("rect")).fill,
      text: getComputedStyle(node.querySelector(".mindmap-node-title")).fill,
    };
  });
  assert.equal(darkMapStyle.background, "rgb(20, 27, 38)");
  assert.equal(darkMapStyle.node, "rgb(35, 47, 62)");
  assert.notEqual(darkMapStyle.text, "rgb(47, 58, 74)");
  for (const theme of ["classic", "ocean", "forest", "midnight", "youdao"]) {
    await api("/api/v1/me/plugin-settings/com.wenote.xmind", "PUT", { theme });
    await page.reload();
    await button("切换到浅色模式").waitFor();
    await page.getByRole("button", { name: "路线.xmind", exact: true }).click();
    const stage = page.locator(`.mindmap-stage[data-xmind-theme="${theme}"]`);
    await stage.waitFor();
    assert.notEqual(await stage.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(255, 255, 255)");
  }

  await api("/api/v1/me/plugin-settings/com.wenote.xmind", "PUT", {
    theme: "classic",
  });
  await page.reload();
  await button("切换到浅色模式").waitFor();
  await page.getByRole("button", { name: "路线.xmind", exact: true }).click();
  const lightClassicMap = page.locator('.mindmap-stage[data-xmind-theme="classic"]');
  await lightClassicMap.waitFor();
  await button("切换到浅色模式").click();
  await button("切换到深色模式").waitFor();
  const lightMapStyle = await lightClassicMap.evaluate((element) => {
    const node = element.querySelectorAll(".mindmap-node")[1];
    return {
      background: getComputedStyle(element).backgroundColor,
      node: getComputedStyle(node.querySelector("rect")).fill,
      text: getComputedStyle(node.querySelector(".mindmap-node-title")).fill,
    };
  });
  assert.equal(lightMapStyle.background, "rgb(255, 255, 255)");
  assert.equal(lightMapStyle.node, "rgb(255, 255, 255)");
  assert.equal(lightMapStyle.text, "rgb(47, 58, 74)");
  console.log("Theme toggle browser test passed: persistence, Markdown and XMind themes in light and dark mode.");
} finally {
  await browser.close();
}
