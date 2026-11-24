import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("set WENOTE_TEST_ORIGIN to a disposable test server");
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  executablePath: process.env.CHROME_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  page.setDefaultTimeout(6000);
  let token = "";
  async function api(route, method = "GET", body) {
    const r = await fetch(origin + "/api/v1/" + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        "Idempotency-Key": randomUUID(),
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r.json();
  }
  const credentials = {
    email: randomUUID() + "@example.invalid",
    password: "context-acceptance",
  };
  await api("auth/register", "POST", credentials);
  token = (await api("auth/login", "POST", credentials)).access_token;
  const vault = (await api("vaults", "POST", { name: "菜单验收" })).id,
    base = "vaults/" + vault;
  const write = (path, content) =>
    api(base + "/files", "POST", {
      path,
      content: Buffer.from(content).toString("base64"),
    });
  await write("当前.md", "# 正在编辑");
  await write("资料/说明.md", "# 导出目标");
  await write("资料/内部/示例.txt", "原文");
  await write("存档/其他.txt", "归档");
  await write(
    "资料/旧白板.md",
    "```wenote-whiteboard\n[\"20,20 100,100\"]\n```\n",
  );
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  const button = (n) => page.getByRole("button", { name: n, exact: true }),
    item = (n) => page.getByRole("menuitem", { name: n, exact: true }),
    dialog = page.getByRole("dialog");
  await button("登录").click();
  await button("当前.md").click();
  await button("编辑模式").click();
  await button("源码").click();
  await page.getByLabel("笔记源码").fill("待保存草稿");
  const context = async (path, pane = "list") => {
    await page
      .locator(
        `${pane === "list" ? ".entry-row" : ".folder-row"}[data-library-path="${path}"]`,
      )
      .click({ button: "right" });
    await page.getByRole("menu", { name: "项目操作" }).waitFor();
  };
  const done = async (n) => {
    await dialog.getByRole("button", { name: n, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  await context("资料/说明.md");
  await item("导出为PDF").click();
  await dialog.getByRole("heading", { name: "导出目标" }).waitFor();
  await page.emulateMedia({ media: "print" });
  assert(await page.locator(".print-sheet").isVisible());
  assert(!(await page.locator(".sidebar").isVisible()));
  assert((await page.pdf()).length > 1024);
  await page.emulateMedia({ media: "screen" });
  await done("关闭");
  await button("说明.md 的操作").click();
  const dl = page.waitForEvent("download");
  await item("下载").click();
  assert.equal(await readFile(await (await dl).path(), "utf8"), "# 导出目标");
  await dialog.waitFor({ state: "hidden" });
  await context("资料/", "nav");
  await item("复制").click();
  await dialog.getByLabel("目标文件夹").selectOption("存档/");
  await done("确定");
  await button("资料 副本").waitFor();
  await context("资料/", "nav");
  await item("重命名").click();
  await dialog.getByLabel("名称").fill("参考");
  await done("确定");
  await button("参考").waitFor();
  await context("参考/说明.md");
  await item("移动到").click();
  await dialog.getByLabel("目标文件夹").selectOption("存档/");
  await done("确定");
  await context("存档/说明.md");
  await item("删除").click();
  await done("确认删除");
  assert.equal(await page.getByLabel("笔记源码").innerText(), "待保存草稿");
  await context("参考/内部/", "nav");
  await item("新建").click();
  await item("Markdown").click();
  await dialog.getByLabel("名称").fill("嵌套");
  await done("创建");
  await button("嵌套.md").waitFor();
  assert.equal(await page.getByLabel("笔记源码").innerText(), "待保存草稿");
  await context("存档/资料 副本/", "nav");
  await item("删除").click();
  await done("确认删除");
  const entries = (await api(base + "/files")).files.map((f) => f.path);
  assert(entries.includes("参考/内部/示例.txt"));
  assert(entries.includes("参考/内部/嵌套.md"));
  assert(!entries.some((p) => p.startsWith("存档/资料 副本/")));
  // Creating from another folder must preserve the active draft, even after a batch import.
  await context("参考/", "nav");
  await item("新建").hover();
  assert.deepEqual(
    await page
      .getByRole("menu", { name: "新建", exact: true })
      .getByRole("menuitem")
      .allTextContents(),
    ["Markdown", "思维导图", "上传文件", "上传文件夹"],
  );
  await item("上传文件").click();
  await dialog
    .locator("input[type=file]")
    .setInputFiles({
      name: "文稿.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("导入正文"),
    });
  await done("导入");
  await button("文稿.md").waitFor();
  const imported = (await api(base + "/files")).files.find(
    (f) => f.path === "参考/文稿.md",
  );
  assert.equal(
    await (
      await fetch(
        origin + "/api/v1/" + base + "/files/" + imported.file_id + "/content",
        { headers: { Authorization: "Bearer " + token } },
      )
    ).text(),
    "导入正文",
  );
  await button("保存").click();
  await page.getByText("已保存新版本").waitFor();
  await button("旧白板.md").click();
  await button("编辑模式").click();
  await button("预览模式").click();
  await button("编辑白板").click();
  const board = await page.getByLabel("白板画布").boundingBox();
  await page.mouse.move(board.x + 20, board.y + 20);
  await page.mouse.down();
  await page.mouse.move(board.x + 90, board.y + 40, { steps: 4 });
  await page.mouse.up();
  await button("保存").click();
  await page.getByText("已保存新版本").waitFor();
  await button("文稿.md").click();
  await button("旧白板.md").click();
  await page.locator(".whiteboard polyline").first().waitFor();
  // A new member invalidates the whole folder operation. No sibling may be deleted.
  const before = (await api(base + "/files")).files;
  const expected = Object.fromEntries(
    before
      .filter((f) => f.path.startsWith("参考/"))
      .map((f) => [f.path, f.current_version_id]),
  );
  await write("参考/并发写入.md", "新内容");
  const stale = await fetch(origin + "/api/v1/" + base + "/entry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      operation: "delete",
      source: "参考/",
      destination: "",
      expected,
    }),
  });
  assert.equal(stale.status, 409);
  const after = (await api(base + "/files")).files;
  assert(before.every((f) => after.some((g) => g.file_id === f.file_id)));
  await page.setViewportSize({ width: 360, height: 640 });
  await button("返回笔记列表").click();
  await button("文件夹").click();
  const row = page.locator('.entry-row[data-library-path="参考/"]');
  const { x, y } = await row.boundingBox();
  await row.dispatchEvent("pointerdown", {
    pointerType: "touch",
    pointerId: 6,
    button: 0,
    clientX: x + 10,
    clientY: y + 5,
  });
  await item("新建").waitFor();
  await row.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 6 });
  await item("新建").click();
  const rect = await page
    .getByRole("menu", { name: "新建", exact: true })
    .boundingBox();
  assert(
    rect.x >= 0 && rect.x + rect.width <= 360 && rect.y + rect.height <= 640,
  );
  await page.keyboard.press("Escape");
  console.log(
    "Entry menu acceptance passed: both panes, nested actions, empty folders, independent drafts, move/copy/delete, download, print layout and touch.",
  );
} finally {
  await browser.close();
}
