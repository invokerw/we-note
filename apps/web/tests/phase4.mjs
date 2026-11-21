import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { pack } from "../plugin-sdk/pack.mjs";
const origin = process.env.WENOTE_TEST_ORIGIN;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
});
try {
  let token = "";
  async function api(route, method = "GET", body) {
    const r = await fetch(origin + route, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: body && JSON.stringify(body),
    });
    assert.ok(r.ok, await r.clone().text());
    return r;
  }
  const credentials = {
    email: randomUUID() + "@example.invalid",
    password: "plugins-phase-four",
  };
  await api("/api/v1/auth/register", "POST", credentials);
  token = (await (await api("/api/v1/auth/login", "POST", credentials)).json())
    .access_token;
  const vault = (
      await (await api("/api/v1/vaults", "POST", { name: "插件验收" })).json()
    ).id,
    route = `/api/v1/vaults/${vault}/files`;
  const create = async (path, bytes) =>
    (
      await (
        await api(route, "POST", {
          path,
          content: Buffer.from(bytes).toString("base64"),
        })
      ).json()
    ).file_id;
  const content = async (id) =>
    Buffer.from(await (await api(`${route}/${id}/content`)).arrayBuffer());
  const raw = await readFile(
    new URL("./fixtures/sdk-workbook.xmind", import.meta.url),
  );
  const fixture = unzipSync(raw),
    original = JSON.parse(strFromU8(fixture["content.json"]));
  const jsonId = await create(
    "values.json",
    '\uFEFF{"a/b":{"~key":1},"large":9007199254740993}\r\n',
  );
  const marked = await create("prefixed.txt", "WN1\n磁盘字节");
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(origin);
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  const button = (name) => page.getByRole("button", { name, exact: true }),
    click = (name) => button(name).click();
  async function exportBytes(name) {
    const event = page.waitForEvent("download");
    await click(name);
    return readFile(await (await event).path());
  }
  await click("登录");
  await click("values.json");
  await click("格式化");
  await page.getByLabel("JSON Pointer", { exact: true }).fill("/a~1b/~0key");
  await click("定位值");
  assert.equal(await page.getByLabel("节点 JSON 值").inputValue(), "1");
  await page.getByLabel("节点 JSON 值").fill("2");
  await click("替换节点");
  await click("压缩");
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal(
    (await content(jsonId)).toString(),
    '\uFEFF{"a/b":{"~key":2},"large":9007199254740993}',
  );
  assert.deepEqual(await exportBytes("导出当前文件"), await content(jsonId));
  await page.getByLabel("JSON 源码").fill("{");
  await click("保存");
  await page.locator(".plugin-document [role=alert]").waitFor();
  assert.match((await content(jsonId)).toString(), /9007199254740993/);
  await page.getByLabel("JSON 源码").fill('{"draft":true}');
  const latest = (await (await api(`${route}/${jsonId}`)).json())
    .current_version_id;
  await api(`${route}/${jsonId}/content`, "PUT", {
    base_version_id: latest,
    content: Buffer.from('{"remote":true}').toString("base64"),
  });
  await click("保存");
  await page
    .getByRole("status")
    .filter({ hasText: "文件已有新版本" })
    .waitFor();
  assert.match(await page.getByLabel("JSON 源码").innerText(), /draft/);
  assert.equal((await content(jsonId)).toString(), '{"remote":true}');
  page.once("dialog", (d) => d.accept());
  await click("prefixed.txt");
  const upload = async (name, buffer) => {
    page.once("dialog", (d) => d.accept(name));
    await page
      .locator("main.workspace > input[type=file]")
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  await upload("路线.xmind", raw);
  await page.getByLabel("主题标题").fill("实施");
  await click("添加子主题");
  await page.getByLabel("主题标题").fill("校验");
  await page.getByLabel("目标主题").selectOption(original[0].rootTopic.id);
  await click("添加关系线");
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  const mapId = (await (await api(route)).json()).files.find(
    (x) => x.path === "路线.xmind",
  ).file_id;
  const saved = unzipSync(await content(mapId)),
    sheets = JSON.parse(strFromU8(saved["content.json"]));
  assert.equal(sheets[0].rootTopic.title, "实施");
  assert.equal(sheets[0].rootTopic.children.attached[1].title, "校验");
  assert.equal(sheets[0].relationships[0].end2Id, sheets[0].rootTopic.id);
  assert.deepEqual(
    sheets[0].rootTopic.children.attached[0],
    original[0].rootTopic.children.attached[0],
  );
  assert.deepEqual(sheets[1], original[1]);
  for (const [name, bytes] of Object.entries(fixture))
    if (name !== "content.json") assert.deepEqual(saved[name], bytes);
  await page.getByLabel("工作表").selectOption("1");
  assert.match(
    (await exportBytes("导出 Markdown")).toString(),
    /^# 保留工作表/,
  );
  await page.getByLabel("工作表").selectOption("0");
  const markdown = await exportBytes("导出 Markdown");
  assert.match(markdown.toString(), /# 实施\n\n## 交付\n\n周五验收\n\n## 校验/);
  await upload("转换.md", markdown);
  const rebuilt = JSON.parse(
    strFromU8(unzipSync(await exportBytes("导出 XMind"))["content.json"]),
  );
  assert.equal(
    rebuilt[0].rootTopic.children.attached[0].notes.plain.content,
    "周五验收",
  );
  await click("思维导图");
  await page.getByText("编辑标题树", { exact: true }).click();
  await page.getByLabel("目标标题").selectOption("2");
  await page.getByLabel("标题文本").fill("复核");
  await click("更新标题");
  await click("上移整个章节");
  await click("保存");
  const editedMap = JSON.parse(
    strFromU8(unzipSync(await exportBytes("导出 XMind"))["content.json"]),
  );
  assert.deepEqual(
    editedMap[0].rootTopic.children.attached.map((n) => n.title),
    ["复核", "交付"],
  );
  assert.equal(
    editedMap[0].rootTopic.children.attached[1].notes.plain.content,
    "周五验收",
  );
  const legacy = Buffer.from(
    zipSync({ "content.xml": strToU8("<xmap-content/>") }),
  );
  await upload("旧版.xmind", legacy);
  await page.getByRole("alert").filter({ hasText: "XMind 8 XML" }).waitFor();
  assert.deepEqual(await exportBytes("下载原文件"), legacy);
  await click("插件");
  await click("禁用 XMind");
  await click("路线.xmind");
  await page.getByText(/此格式的插件已禁用/).waitFor();
  assert.deepEqual(await exportBytes("下载原文件"), await content(mapId));
  const sample = await pack(
    fileURLToPath(new URL("../plugin-sdk/example", import.meta.url)),
  );
  const entries = unzipSync(sample);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
  const install = async (bytes) =>
    page.getByLabel("安装本地插件包").setInputFiles({
      name: "example.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(bytes),
    });
  await click("插件");
  await install(
    zipSync({
      ...entries,
      "manifest.json": strToU8(
        JSON.stringify({ ...manifest, api_version: "2" }),
      ),
    }),
  );
  await page.getByRole("alert").filter({ hasText: "不兼容" }).waitFor();
  const withCaps = (caps) =>
    zipSync({
      ...entries,
      "manifest.json": strToU8(
        JSON.stringify({ ...manifest, capabilities: caps }),
      ),
    });
  await install(withCaps(["parse", "network"]));
  await page.getByRole("alert").filter({ hasText: "权限不受支持" }).waitFor();
  await install(withCaps(["parse"]));
  await click("授权并安装");
  await click("prefixed.txt");
  await page.getByLabel("插件文档").waitFor();
  assert.equal(await page.getByLabel("插件文档").isEditable(), false);
  assert.equal(await button("保存").count(), 0);
  await click("插件");
  await install(sample);
  await click("授权并安装");
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "磁盘字节");
  await page.getByLabel("插件文档").fill("修改后");
  await click("保存");
  await page.getByRole("status").filter({ hasText: "已保存新版本" }).waitFor();
  assert.equal((await content(marked)).toString(), "WN1\n修改后");
  await page.reload();
  await click("prefixed.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "修改后");
  await click("插件");
  await click("禁用 带标记的文本");
  await click("prefixed.txt");
  await page.locator("article pre").getByText("WN1").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Phase 4 browser passed: JSON Pointer and precision, XMind SDK resource/multi-sheet round trip, Markdown conversion, WASM installation, persistence, and permissions.",
  );
} finally {
  await browser.close();
}
