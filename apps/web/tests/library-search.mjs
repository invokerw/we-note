import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("Set WENOTE_TEST_ORIGIN to a disposable instance");
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(4500);
  const credentials = {
    email: randomUUID() + "@example.invalid",
    password: "library-search-test",
  };
  let token = "";
  async function post(path, body) {
    const r = await fetch(origin + "/api/v1/" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r.json();
  }
  await post("auth/register", credentials);
  token = (await post("auth/login", credentials)).access_token;
  const { id } = await post("vaults", { name: "验收" });
  for (const [path, body] of [
    ["工作/命令.md", "# 终端\n\nUbuntu 使用 LiNuX 内核"],
    ["书摘/Linux.md", "参考"],
    ["Linux资料/手册.md", "说明"],
    ["项目.md", "abc"],
  ])
    await post(`vaults/${id}/files`, {
      path,
      content: Buffer.from(body).toString("base64"),
    });
  await page.goto(origin);
  await page.evaluate(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await page.reload();
  const list = page.getByRole("region", { name: "笔记列表" }),
    input = list.getByRole("searchbox"),
    button = (scope, name) => scope.getByRole("button", { name, exact: true });
  await input.fill("linux");
  await button(list, "命令.md").waitFor();
  assert.equal(await button(page, "搜索").count(), 0);
  await button(list, "Linux.md").waitFor();
  await list.locator("mark").first().waitFor();
  await button(list, "命令.md").click();
  await button(page, "编辑模式").click();
  await button(page, "预览").click();
  await page.waitForFunction(
    () => CSS.highlights?.get("note-search")?.size > 0,
  );
  await input.fill("");
  await button(page.locator(".folders"), "工作").click();
  await input.fill("linux");
  await page.getByRole("radio", { name: "当前目录：工作" }).check();
  await button(list, "命令.md").waitFor();
  assert.equal(await button(list, "Linux.md").count(), 0);
  await page.getByRole("radio", { name: "全部笔记" }).check();
  await button(list, "Linux.md").waitFor();
  await input.fill("");
  await button(list, "linux").click();
  assert.equal(await input.inputValue(), "linux");
  await button(list, "清空最近搜索").click();
  assert.equal(await button(list, "linux").count(), 0);
  await input.fill("无此关键词");
  await list.getByText("没有匹配的笔记").waitFor();
  console.log("正文、路径、范围、历史记录、正文高亮和统一入口通过");
} finally {
  await browser.close();
}
