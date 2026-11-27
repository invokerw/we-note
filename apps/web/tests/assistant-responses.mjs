import {assistantUI} from "./assistant-ui.mjs";
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
  const firstChunk = Promise.withResolvers();
  const continuation = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method === "GET") return res.end(JSON.stringify({data:[{id:"test"}]}));
    for await (const _chunk of req) { /* drain request */ }
    calls++;
    res.setHeader("Content-Type", "text/event-stream");
    if (calls > 2) return res.writeHead(500).end();
    if (invalid) return res.end(createNoteStream({ ...args, kind: "invalid" }));
    if (calls === 2) {
      await continuation.promise;
      return res.end(frame({ type: "response.completed", response: { status: "completed", output: [] } }));
    }
    await firstChunk.promise;
    if (!capture) res.write(frame({ type: 'response.reasoning_summary_text.delta', delta: '将可见摘要与本轮草稿关联。' }) + frame({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_TRACE_FIXTURE' }));
    res.write(source.slice(0, split));
    await new Promise((resolve) => { finish = resolve; });
    res.end(source.slice(split));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const button = (name) => page.getByRole("button", { name, exact: true });
  try {
    const ui=assistantUI(page); await ui.settings(); await ui.protocol('OpenAI Responses');
    await page.getByLabel("服务地址", { exact: true }).fill(`http://127.0.0.1:${server.address().port}/v1`);
    await ui.save();
    await button("授权编辑").click();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const input = page.getByRole("textbox", { name: "助手消息" });
    await input.fill("写一篇");
    await button("发送").and(page.locator(":enabled")).waitFor();
    await input.press("Shift+Enter");
    await page.keyboard.insertText("测试笔记");
    const prompt = "写一篇\n测试笔记";
    assert.equal(await input.inputValue(), prompt);
    await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await input.dispatchEvent("compositionend");
    // WebKit can send the IME confirmation after compositionend with keyCode 229.
    const imeKeptDefault = await input.evaluate(el => el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }),
    ));
    assert(imeKeptDefault, "输入法的确认键应交给输入法处理");
    assert.equal(await input.inputValue(), prompt);
    assert.equal(calls, 0);
    await input.press("Enter");
    const sent = page.locator(".assistant-line.role-user").last();
    await sent.waitFor();
    assert.equal(await sent.textContent(), prompt);
    const activity = page.locator(".assistant-reply .assistant-generation-status");
    await activity.filter({ hasText: "正在生成" }).waitFor();
    const isMoving = () => activity.evaluate(el =>
      el.getAnimations({ subtree: true }).some(animation => animation.playState === "running"),
    );
    assert(await isMoving(), "等待首个响应时应有持续动效");
    await input.fill("下一条草稿");
    await input.press("Enter");
    assert.equal(await input.inputValue(), "下一条草稿");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await isMoving(), false);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    firstChunk.resolve();
    await page.getByLabel("正在起草的笔记").filter({ hasText: expected.text }).waitFor();
    await activity.filter({ hasText: "正在起草" }).waitFor();
    assert(await isMoving());
    const reply=page.locator('.assistant-reply').last();
    await reply.evaluate(el=>el.dataset.stable='stream');
    if (!capture) await reply.getByText('思考摘要',{exact:true}).waitFor();
    assert.equal(await page.getByText('PRIVATE_TRACE_FIXTURE',{exact:true}).count(),0);
    assert.equal(await button("应用修改").count(), 0);
    finish();
    await button("应用修改").waitFor();
    await activity.waitFor({ state: "detached" });
    assert.equal(await page.locator(".assistant-preview pre").textContent(), expected.text);
    assert.equal((await files()).length, 0);
    assert.equal(calls, 1);
    await button("应用修改").click();
    await activity.filter({ hasText: "正在生成" }).waitFor();
    continuation.resolve();
    await button("发送").waitFor();
    assert.equal(await activity.count(), 0);
    assert.deepEqual((await files()).map((f) => f.path), [expected.path]);
    assert.equal(await reply.getAttribute('data-stable'),'stream');
    if (!capture) {
      await reply.getByText('思考摘要', {exact:true}).click();
      await reply.getByText('将可见摘要与本轮草稿关联。',{exact:true}).waitFor();
    }
    assert.equal(await reply.locator('.ant-sources').count(),0);
    assert.equal(calls, 2);
    calls = 0;
    await input.fill("停止这次起草");
    await button('发送').click();
    await page.getByLabel('正在起草的笔记').waitFor();
    await button('停止').click();
    await reply.getByText('本轮已停止',{exact:true}).waitFor();
    assert.equal(await activity.count(), 0);
    assert.equal(await button('应用修改').count(),0);
    assert.equal((await files()).length,1);
    finish();
    invalid = true; calls = 0;
    await input.fill("测试无效调用");
    await button("发送").click();
    await page.getByRole("alert").filter({ hasText: "已停止" }).waitFor();
    assert.equal(await activity.count(), 0);
    assert.equal(calls, 2);
    assert.equal((await files()).length, 1);
  } finally {
    firstChunk.resolve();
    continuation.resolve();
    finish?.();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await page.emulateMedia({ reducedMotion: null });
  }
}
