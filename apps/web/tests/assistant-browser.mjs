import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
const credentials = {
  email: randomUUID() + "@example.invalid",
  password: randomUUID(),
};
let token = "";
async function api(path, body) {
  const res = await fetch(`${origin}/api/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body && JSON.stringify(body),
  });
  assert(res.ok, await res.clone().text());
  return res.json();
}
await api("auth/register", credentials);
token = (await api("auth/login", credentials)).access_token;
const vault = (await api("vaults", { name: "助手验收" })).id;
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  executablePath: process.env.CHROME_PATH,
});
const page = await browser.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const btn = (name) => page.getByRole("button", { name, exact: true });
async function checkBrowserTransport() {
  const received = [];
  const gateway = createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    if (req.url.startsWith("/denied/")) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
    if (req.method === "OPTIONS") res.writeHead(204).end();
    else res.writeHead(401, { "Content-Type": "application/json" }).end(
      JSON.stringify({ error: { message: "credential rejected" } }),
    );
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  try {
    const service = `http://127.0.0.1:${gateway.address().port}`;
    const address = page.getByLabel("服务地址", { exact: true });
    await address.fill(`${service}/denied/v1`);
    await page.getByLabel("模型 ID").fill("test");
    await page.getByLabel("API Key").fill("test-only");
    await btn("测试连接").click();
    const status = page.locator(".assistant-config [role=status]");
    await status.filter({ hasText: "桌面客户端" }).waitFor();
    const diagnostic = await status.innerText();
    assert(diagnostic.includes(origin) && diagnostic.includes(service));
    assert(diagnostic.includes("跨域"));
    assert(!diagnostic.includes("test-only"));
    assert.deepEqual(received, ["OPTIONS /denied/v1/chat/completions"]);
    await address.fill(`${service}/allowed/v1`);
    await page.getByLabel("API Key").fill("test-only");
    await btn("测试连接").click();
    await status.filter({ hasText: "credential rejected" }).waitFor();
    assert(!(await status.innerText()).includes("跨域"));
    assert(received.includes("POST /allowed/v1/chat/completions"));
  } finally {
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
  }
}
try {
  await page.addInitScript(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await page.goto(`${origin}/?vault=${vault}`);
  await btn("展开笔记助手").waitFor();
  await btn("打开个人设置").click();
  await btn("笔记助手").click();
  await checkBrowserTransport();
  let requested = 0;
  let modelCalls = 0;
  const expectedKey = "test-chat-key";
  const model = "http://127.0.0.1:19456/v1";
  await page.route(model + "/**", async (route) => {
    const req = route.request(),
      body = req.postDataJSON();
    modelCalls++;
    const anonymous = body.model === "anonymous";
    if (!req.headers().authorization && !anonymous) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "API_KEY_REQUIRED", message: "API key is required" } }) });
      return;
    }
    assert.equal(req.headers().authorization, anonymous ? undefined : `Bearer ${expectedKey}`);
    if (req.url().endsWith("/responses")) {
      assert(body.tools.some((t) => t.name === "check_connection"));
      const item = {
        type: "function_call",
        name: "check_connection",
        arguments: "{}",
        call_id: "call_check",
        id: "fc_check",
      };
      const events = [
        { type: "response.created", response: { id: "resp_check" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, arguments: "" },
        },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: "resp_check", status: "completed", output: [item] },
        },
      ];
      await route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
          .join(""),
      });
      return;
    }
    const check = body.tools?.some(
      (t) => t.function?.name === "check_connection",
    );
    const tool = check
      ? "check_connection"
      : body.messages.at(-1)?.role === "tool"
        ? ""
        : "create_note";
    const args = check
      ? {}
      : {
          path: "周报.md",
          text: "联调定于周五。",
          kind: "markdown",
          operation_id: "model-key",
        };
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_" + ++requested,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { role: "assistant", content: "已完成周报。" };
    const events = [
      { delta, finish_reason: null },
      { delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
    ]
      .map(
        (c) =>
          `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, ...c }] })}\n\n`,
      )
      .join("");
    await route.fulfill({
      contentType: "text/event-stream",
      body: events + "data: [DONE]\n\n",
    });
  });
  await page.getByLabel("服务地址", { exact: true }).fill(model);
  await page.getByLabel("模型 ID").fill("anonymous");
  await btn("测试连接").click();
  await page.getByText("可用于写笔记，模型设置已保存").waitFor();
  await page.getByLabel("模型 ID").fill("test");
  await page.getByLabel("API Key").fill(expectedKey);
  await page.getByLabel("接口协议").selectOption("openai-responses");
  await btn("测试连接").click();
  await page.getByText("可用于写笔记，模型设置已保存").waitFor();
  await page.getByLabel("接口协议").selectOption("openai-completions");
  await btn("测试连接").click();
  await page.getByText("可用于写笔记，模型设置已保存").waitFor();
  await btn("关闭个人设置").click();
  await btn("展开笔记助手").click();
  await btn("授权编辑").click();
  const draft = page.getByLabel("助手消息");
  const turnModule = /\/static\/turn-[^/]+\.js$/;
  await page.route(turnModule, (route) => route.fulfill({ status: 404, body: "missing" }));
  const prompt = "帮我写一篇周报";
  await draft.fill(prompt);
  const callsBeforeSend = modelCalls;
  await btn("发送").click();
  await page.getByRole("alert").filter({ hasText: "刷新" }).waitFor();
  assert.equal(await draft.inputValue(), prompt);
  assert.equal(await page.locator(".assistant-line.role-user").count(), 0);
  await page.unroute(turnModule);
  await page.reload();
  await btn("展开笔记助手").click();
  await btn("发送").click();
  await page.getByRole("alert").filter({ hasText: "API Key" }).waitFor();
  assert.equal(await draft.inputValue(), prompt);
  assert.equal(await page.locator(".assistant-line.role-user").count(), 0);
  assert.equal(modelCalls, callsBeforeSend);
  assert(!(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).includes(expectedKey));
  // A model configuration saved by the previous release has no credential hint.
  await page.evaluate(() => {
    const storageKey = "wenote-assistant-model";
    const { api, baseUrl, model } = JSON.parse(localStorage.getItem(storageKey));
    localStorage.setItem(storageKey, JSON.stringify({ api, baseUrl, model }));
  });
  await page.reload();
  await btn("展开笔记助手").click();
  await btn("发送").click();
  await page.getByRole("alert").filter({ hasText: "个人设置" }).waitFor();
  assert.equal(await draft.inputValue(), prompt);
  assert.equal(await page.locator(".assistant-line.role-user").count(), 0);
  assert.equal(modelCalls, callsBeforeSend + 1);
  await btn("打开个人设置").click();
  await btn("笔记助手").click();
  await page.getByLabel("API Key").fill(expectedKey);
  await btn("保存模型设置").click();
  await btn("关闭个人设置").click();
  await btn("发送").click();
  await btn("应用修改").waitFor();
  assert.equal((await api(`vaults/${vault}/files`)).files.length, 0);
  await btn("收起笔记助手").click();
  await btn("展开笔记助手").click();
  await draft.fill("确认保存到周报");
  await btn("修改要求").click();
  await page.getByText("已放弃", { exact: true }).waitFor();
  await btn("应用修改").click();
  await page.getByText("已完成周报。", { exact: true }).waitFor();
  assert.equal((await api(`vaults/${vault}/files`)).files.length, 1);
  await draft.fill("留给下一次");
  await btn("历史对话").click();
  await btn("新对话").click();
  await btn("历史对话").click();
  await page.getByRole("button", { name: /帮我写一篇周报/ }).click();
  assert.equal(await draft.inputValue(), "留给下一次");
  await page.reload();
  await btn("展开笔记助手").click();
  await page.getByText("已完成周报。", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "留给下一次");
  await page.setViewportSize({ width: 390, height: 780 });
  await btn("收起笔记助手").click();
  await btn("展开笔记助手").click();
  assert(await draft.isVisible());
  const other = (await api("vaults", { name: "第二个库" })).id;
  await page.goto(`${origin}/?vault=${other}`);
  await btn("展开笔记助手").click();
  await btn("授权只读").waitFor();
  assert.equal(await draft.inputValue(), "");
  assert.equal(
    await page.getByText("已完成周报。", { exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "通过：Pi 流式工具测试、MCP 预览与写入、历史切换、刷新恢复和窄屏开关",
  );
} catch (e) {
  console.error((await page.locator("body").innerText()).slice(-1500), errors);
  throw e;
} finally {
  await browser.close();
}
