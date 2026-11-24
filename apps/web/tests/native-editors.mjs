import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const root = resolve(import.meta.dirname, "../../..");
const temp = await mkdtemp(join(tmpdir(), "wenote-native-test-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const addr = "127.0.0.1:" + probe.address().port;
await new Promise((r) => probe.close(r));
const origin = "http://" + addr;
const server = spawn(
  join(root, "dist/local/wenote-api"),
  ["-addr", addr, "-web-dir", join(root, "apps/web/dist")],
  {
    cwd: temp,
    stdio: "ignore",
  },
);

let browser;
try {
  browser = await chromium.launch({ channel: "chrome" });
  const email = randomUUID() + "@example.invalid",
    password = "browser-editors";
  let token = "";
  async function api(path, body) {
    const r = await fetch(origin + "/api/v1" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r;
  }
  for (
    let i = 0;
    i < 100 &&
    !(await fetch(origin + "/healthz")
      .then((r) => r.ok)
      .catch(() => false));
    i++
  )
    await delay(50);
  const signup = await browser.newPage();
  await signup.goto(origin);
  await signup.getByRole("button", { name: "创建账户", exact: true }).click();
  await signup.getByLabel("邮箱").fill(email);
  await signup.getByLabel("密码").fill(password);
  const [login] = await Promise.all([
    signup.waitForResponse(origin + "/api/v1/auth/login"),
    signup.getByRole("button", { name: "注册并登录" }).click(),
  ]);
  assert.equal(login.status(), 200);
  token = (await login.json()).access_token;
  await signup.getByRole("heading", { name: "创建你的第一个笔记库" }).waitFor();
  await signup.close();
  await fetch(origin + "/api/v1/me/plugin-settings/com.wenote.md", {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ autoFormatOnSave: false, defaultMode: "read" }),
  });
  const { id } = await (await api("/vaults", { name: "原生编辑验收" })).json();
  const folder = "/vaults/" + id + "/files";
  const source =
    "---\r\nowner: WeNote # 元数据\r\n---\r\n##  章节\r\n\r\n\r\n编辑段落\r\n\r\n_tail_\r\n";
  const create = async (path, raw) =>
    (
      await api(folder, { path, content: Buffer.from(raw).toString("base64") })
    ).json();
  const md = await create("笔记.md", source);
  const map = await create(
    "路线.mind.json",
    JSON.stringify({
      nodeData: {
        id: "root",
        topic: "产品路线",
        children: [{ id: "study", topic: "调研" }],
      },
    }),
  );
  await create("普通.json", "{}");
  const page = await browser.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.error(e.message);
  });
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await button("登录").click();
  await button("笔记.md").click();
  await button("编辑模式").click();
  await button("可视化编辑").click();
  const para = page
    .locator(".milkdown .ProseMirror p")
    .filter({ hasText: "编辑段落" });
  await para.click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("完成");
  async function saveFile(file) {
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/" + file.file_id + "/content") &&
        r.request().method() === "PUT",
    );
    await button("保存").click();
    assert.ok((await response).ok());
    return (await api(folder + "/" + file.file_id + "/content")).text();
  }
  assert.equal(await saveFile(md), source.replace("编辑段落", "编辑段落完成"));
  await button("编辑模式").click();
  await button("思维导图").click();
  await page.locator(".me-tpc").filter({ hasText: "章节" }).click();
  await page.locator(".reading h2").waitFor();
  await button("路线.mind.json").click();
  const branch = page.locator(".me-tpc").filter({ hasText: "调研" });
  await branch.click();
  await button("备注").click();
  await page.getByLabel("备注", { exact: true }).fill("下周访谈");
  await button("确定").click();
  const saved = JSON.parse(await saveFile(map));
  assert.equal(saved.nodeData.children[0].note, "下周访谈");
  await button("普通.json").click();
  assert.equal(await page.locator(".native-mind").count(), 0);
  await button("路线.mind.json").click();
  await branch.click();
  await button("备注").click();
  assert.equal(
    await page.getByLabel("备注", { exact: true }).inputValue(),
    "下周访谈",
  );
  await button("取消").click();
  await button("子主题").click();
  const input = page.locator("#input-box");
  if (await input.count()) {
    await input.fill("访谈");
    await input.press("Enter");
  }
  await button("撤销").click();
  await button("重做").click();
  await branch.click();
  await button("关系箭头").click();
  await page.getByLabel("关系箭头", { exact: true }).selectOption("root");
  await button("确定").click();
  await button("切换布局").click();
  await button("切换导图主题").click();
  const expanded = JSON.parse(await saveFile(map));
  assert.equal(expanded.arrows.length, 1);
  assert.ok(expanded.theme.name);
  assert.equal(expanded.nodeData.children[0].children.length, 1);
  await page
    .locator('.entry-row[data-library-path="路线.mind.json"]')
    .click({ button: "right" });
  const item = (name) => page.getByRole("menuitem", { name, exact: true });
  await item("新建").hover();
  await item("思维导图").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称").fill("第二张");
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await page.locator(".me-tpc").filter({ hasText: "第二张" }).waitFor();
  await button("第二张.mind.json").waitFor();
  if (process.argv.includes("--android")) {
    await (
      await import("./native-android.mjs")
    ).verifyAndroid(origin, email, password);
    for (let i=0;i<50;i++) {
      const remote=await (await api(folder+'/'+map.file_id+'/content')).json();
      if (remote.nodeData.children[0].note==='手机草稿') break;
      assert.ok(i < 49,'Android map sync timed out'); await delay(200);
    }
    assert.match(await (await api(folder+'/'+md.file_id+'/content')).text(),/手机/);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Crepe edit/save, heading navigation, native diagram save/reopen and JSON dispatch passed",
  );
} finally {
  await browser?.close();
  server.kill();
  await once(server, "exit");
  await rm(temp, { recursive: true, force: true });
}
