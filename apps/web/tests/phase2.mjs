import assert from "node:assert/strict";
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
  await button("路线.md").click();
  await page.locator(".reading table td").first().waitFor();
  await page.locator(".reading .katex").waitFor();
  await page.locator(".reading .callout").waitFor();
  await page.waitForFunction(
    () => document.querySelector('img[alt="Mermaid 图表"]')?.naturalWidth > 0,
  );
  await button("实时预览").click();
  await page.getByText("保持原样。", { exact: true }).click();
  await page.getByLabel("当前段落源码").fill("新的正文。");
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
  await button("思维导图").click();
  const map = page.getByRole("navigation", { name: "标题树思维导图" });
  await map.getByRole("button", { name: "交付" }).click();
  await page.locator(".reading h2").waitFor();
  await page.getByText("目录与属性", { exact: true }).click();
  await page.getByText("编辑组", { exact: true }).waitFor();
  await page.getByRole("link", { name: "相关笔记" }).click();
  await page.getByRole("heading", { name: "目标文件" }).waitFor();
  await page.getByText("反向链接", { exact: true }).click();
  await button("工作/路线.md").click();
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
  assert.deepEqual(errors, []);
  console.log(
    "Phase 2 browser acceptance passed: rich Markdown, byte-preserving live edits, heading map, links, search, clipboard, asset preview and ZIP download.",
  );
} finally {
  await chrome.close();
}
