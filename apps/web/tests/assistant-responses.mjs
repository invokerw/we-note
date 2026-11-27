import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
function createNoteStream(args) {
  const item = { type: "function_call", name: "create_note", id: "fc_create", call_id: "call_create", arguments: JSON.stringify(args) };
  return [
    { type: "response.created", response: { id: "resp_create" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
    { type: "response.function_call_arguments.done", output_index: 0, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { status: "completed", output: [item] } },
  ].map(frame).join("");
}

export async function checkResponsesTurn(page, origin, files) {
  const args = { kind: "markdown", path: "测试.md", operation_id: "model-id", root_topic: "测试", text: "# 测试笔记\n一段草稿。" };
  const capture = process.env.WENOTE_RESPONSE_CAPTURE;
  const source = capture ? await readFile(capture, "utf8") : createNoteStream(args);
  const split = source.indexOf("event: response.function_call_arguments.done");
  assert(split > 0);
  const completed = source.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === "response.completed");
  const expected = JSON.parse(completed.response.output[0].arguments);
  let invalid = false, calls = 0, finish;
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    for await (const _chunk of req) { /* drain request */ }
    calls++;
    res.setHeader("Content-Type", "text/event-stream");
    if (calls > 2) return res.writeHead(500).end();
    if (invalid) return res.end(createNoteStream({ ...args, kind: "invalid" }));
    if (calls === 2) return res.end(frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    res.write(source.slice(0, split));
    await new Promise((resolve) => { finish = resolve; });
    res.end(source.slice(split));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const button = (name) => page.getByRole("button", { name, exact: true });
  try {
    await button("打开个人设置").click();
    await button("笔记助手").click();
    await page.getByLabel("接口协议").selectOption("openai-responses");
    await page.getByLabel("服务地址", { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
    await button("保存模型设置").click();
    await button("关闭个人设置").click();
    await button("授权编辑").click();
    await page.getByLabel("助手消息").fill("写一篇测试笔记");
    await button("发送").click();
    await page.getByLabel("正在起草的笔记").filter({ hasText: expected.text }).waitFor();
    assert.equal(await button("应用修改").count(), 0);
    finish();
    await button("应用修改").waitFor();
    assert.equal(await page.locator(".assistant-preview pre").textContent(), expected.text);
    assert.equal((await files()).length, 0);
    assert.equal(calls, 1);
    await button("应用修改").click();
    await button("发送").waitFor();
    assert.deepEqual((await files()).map((f) => f.path), [expected.path]);
    assert.equal(calls, 2);
    invalid = true; calls = 0;
    await page.getByLabel("助手消息").fill("测试无效调用");
    await button("发送").click();
    await page.getByRole("alert").filter({ hasText: "已停止" }).waitFor();
    assert.equal(calls, 2);
    assert.equal((await files()).length, 1);
  } finally {
    finish?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
