import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pack } from "../plugin-sdk/pack.mjs";
import { fileURLToPath } from "node:url";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
const credentials = {
  email: `${randomUUID()}@example.invalid`,
  password: randomUUID(),
};
let token;
async function api(path, method = "GET", body) {
  const r = await fetch(origin + "/api/v1/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body && JSON.stringify(body),
  });
  assert.ok(r.ok, `${method} ${path}: ${await r.clone().text()}`);
  return r;
}
await api("auth/register", "POST", credentials);
token = (await (await api("auth/login", "POST", credentials)).json())
  .access_token;
const vault = (
  await (await api("vaults", "POST", { name: "MCP 验收库" })).json()
).id;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  executablePath: process.env.CHROME_PATH,
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.addInitScript(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await page.goto(`${origin}/?vault=${vault}`);
  const btn = (name) => page.getByRole("button", { name, exact: true });
  await btn("打开个人设置").click();
  await btn("MCP 连接").click();
  let secret = "";
  async function grant(write) {
    if (write) await page.getByLabel("允许新建、修改和移入回收站").check();
    await btn("授权当前笔记库").click();
    const el = page.getByLabel("连接令牌（仅此次显示）");
    await el.waitFor();
    await page.waitForFunction(old => { const input=document.querySelector("dialog[open] input[readonly]"); return !!input?.value && input.value !== old; },secret);
    secret = await el.inputValue();
    await page.waitForFunction(() => !!window.weNoteMCP);
  }
  async function rpc(method, params) {
    const reply = await page.evaluate(
      ([token, method, params]) =>
        window.weNoteMCP.request(
          { jsonrpc: "2.0", id: 1, method, params },
          token,
        ),
      [secret, method, params],
    );
    assert.ok(!reply.error, JSON.stringify(reply));
    return reply.result;
  }
  const call = async (name, args, code) => {
    const result = await rpc("tools/call", { name, arguments: args });
    if (code) assert.equal(result.structuredContent.code, code);
    else assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  await grant(false);
  assert.equal((await rpc("initialize", {})).protocolVersion, "2025-11-25");
  assert.equal((await rpc("tools/list", {})).tools.length, 3);
  const create = {
    kind: "markdown",
    path: "周报.md",
    text: "第一天\r\n",
    operation_id: randomUUID(),
  };
  await call("create_note", create, "ACCESS_DENIED");
  await btn("撤销连接").click();
  await grant(true);
  assert.equal((await rpc("tools/list", {})).tools.length, 8);
  const writer = secret;
  await btn("添加连接").click();
  await page.getByLabel("连接名称").fill("只读检查");
  await grant(false);
  const reader = secret;
  assert.equal((await rpc("tools/list", {})).tools.length, 3);
  secret = writer;
  assert.equal((await rpc("tools/list", {})).tools.length, 8);
  await page
    .getByRole("group", { name: "只读检查" })
    .getByRole("button", { name: "撤销连接" })
    .click();
  await page.getByRole("group", { name: "只读检查" }).waitFor({state:"hidden"});
  secret = reader;
  await assert.rejects(() => rpc("tools/list", {}), /ACCESS_DENIED|连接已撤销/);
  secret = writer;
  let note = await call("create_note", create);
  assert.equal(note.sync_status, "synced");
  const id = note.file_id;
  assert.deepEqual(await call("create_note", create), note);
  const base = (d) => ({
    file_id: d.file_id,
    base_path: d.path,
    base_version_id: d.version_id,
    operation_id: randomUUID(),
  });
  assert.equal((await call("read_note", { file_id: id })).text, create.text);
  const append = { ...base(note), edit: { mode: "append", text: "第二天" } };
  note = await call("edit_note", append);
  await call(
    "edit_note",
    { ...append, operation_id: randomUUID() },
    "FILE_VERSION_CONFLICT",
  );
  assert.equal(
    (await call("search_notes", { query: "第二天" })).items[0].file_id,
    id,
  );
  note = await call("move_note", { ...base(note), new_path: "项目/新周报.md" });
  assert.equal(note.file_id, id);
  const map = await call("create_note", {
    kind: "mindmap",
    path: "路线.mind.json",
    root_topic: "中心",
    operation_id: randomUUID(),
  });
  const edit = {
    ...base(map),
    operations: [
      {
        op: "add_node",
        parent_id: map.root_node_id,
        topic: "调研",
        ref: "$study",
      },
      { op: "add_node", parent_id: "$study", topic: "访谈" },
    ],
  };
  const updated = await call("edit_mindmap", edit);
  assert.equal(updated.created_node_ids.length, 2);
  const tree = await call("read_mindmap_nodes", {
    file_id: map.file_id,
    node_id: updated.refs.$study,
  });
  assert.equal(tree.nodes.length, 2);
  await context.setOffline(true);
  note = await call("edit_note", {
    ...base(note),
    edit: { mode: "append", text: "离线" },
  });
  assert.equal(note.sync_status, "pending");
  assert.match((await call("read_note", { file_id: id })).text, /离线$/);
  await context.setOffline(false);
  const files = async () =>
    (await (await api(`vaults/${vault}/files`)).json()).files;
  const remote = (await files()).find((f) => f.path === note.path);
  for (let i = 0; i < 50; i++) {
    if (
      (
        await (
          await api(`vaults/${vault}/files/${remote.file_id}/content`)
        ).text()
      ).endsWith("离线")
    )
      break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.equal(
    await (await api(`vaults/${vault}/files/${remote.file_id}/content`)).text(),
    "第一天\r\n第二天离线",
  );
  // A different tab's editor has its own unsaved draft.
  const draft = await (
    await api(`vaults/${vault}/files`, "POST", {
      path: "guard.txt",
      content: btoa("saved"),
    })
  ).json();
  const second = await context.newPage();
  await second.addInitScript(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await second.goto(`${origin}/?vault=${vault}&note=${draft.file_id}`);
  await second.getByLabel("纯文本正文").fill("unsaved");
  const guarded = await call("read_note", { file_id: draft.file_id });
  await call(
    "edit_note",
    { ...base(guarded), edit: { mode: "append", text: " tool" } },
    "EDITOR_DIRTY",
  );
  await second.close();
  // An opt-in format uses the installed WASM for both reads and writes.
  const bundle = unzipSync(
    await pack(
      fileURLToPath(new URL("../plugin-sdk/example", import.meta.url)),
    ),
  );
  bundle["manifest.json"] = strToU8(
    JSON.stringify({
      ...JSON.parse(strFromU8(bundle["manifest.json"])),
      file_extensions: [".wn1"],
      mcp_model: "text",
    }),
  );
  await btn("编辑与插件").click();
  await page
    .getByLabel("安装本地插件包")
    .setInputFiles({
      name: "wenote-mcp-test.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(bundle)),
    });
  await btn("授权并安装").click();
  await btn("MCP 连接").click();
  const custom = await call("create_note", {
    kind: "text",
    path: "插件.wn1",
    text: "one",
    operation_id: randomUUID(),
  });
  assert.equal(
    (await call("read_note", { file_id: custom.file_id })).text,
    "one",
  );
  await call("edit_note", {
    ...base(custom),
    edit: { mode: "append", text: " two" },
  });
  const disk = (await files()).find((f) => f.path === "插件.wn1");
  assert.equal(
    await (await api(`vaults/${vault}/files/${disk.file_id}/content`)).text(),
    "WN1\none two",
  );
  const fresh = await call("read_note", { file_id: id });
  await call("delete_note", base(fresh));
  assert.ok(!(await files()).some((f) => f.path === note.path));
  await call("delete_note", base(updated));
  await btn("撤销连接").click();
  await page.waitForFunction(() => !window.weNoteMCP);
  console.log(
    "MCP browser acceptance passed: discovery, grants, revocation, file and node CRUD, conflict, replay and offline sync",
  );
} finally {
  await browser.close();
}
