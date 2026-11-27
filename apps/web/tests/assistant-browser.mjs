import {assistantUI} from "./assistant-ui.mjs";
import { checkResponsesTurn } from "./assistant-responses.mjs";
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
const ui = assistantUI(page);
const btn = (name) => page.getByRole("button", { name, exact: true });
async function checkSidebarLayout(paneSelector, adjacentButton) {
  const toggle = btn("展开笔记助手");
  const pane = page.locator(paneSelector);
  const layout = await page.locator(".layout").boundingBox();
  const closedPane = await pane.boundingBox();
  assert.equal(closedPane.y, layout.y, "关闭助手时当前栏应从工作区顶边开始");
  const closedToggle = await toggle.boundingBox();
  if (adjacentButton) {
    const adjacent = await adjacentButton.boundingBox();
    assert(adjacent.x + adjacent.width <= closedToggle.x, "开关应给已有操作留出空间");
    assert(Math.abs(adjacent.y + adjacent.height / 2 - closedToggle.y - closedToggle.height / 2) < 2,
      "开关应与现有标题操作垂直居中");
  }
  await toggle.click();
  const opened = await page.locator(".assistant-panel").boundingBox();
  assert.equal(opened.y, layout.y, "助手栏应从工作区顶边开始");
  assert.equal(opened.y + opened.height, layout.y + layout.height);
  const close = btn("收起笔记助手");
  assert.deepEqual(await close.boundingBox(), closedToggle, "开合应在原位置使用同一按钮");
  const fresh = await btn("新对话").boundingBox();
  assert(fresh.x + fresh.width <= closedToggle.x);
  assert(Math.abs(fresh.y + fresh.height / 2 - closedToggle.y - closedToggle.height / 2) < 2);
  if (opened.width < layout.width) {
    const narrowed = await pane.boundingBox();
    assert.equal(narrowed.y, closedPane.y);
    assert.equal(narrowed.height, closedPane.height);
    assert.equal(narrowed.x + narrowed.width, opened.x);
    if (adjacentButton) {
      const heading = page.locator(".document-head h1");
      assert(await heading.evaluate(el => el.scrollWidth <= el.clientWidth), "四栏并排时应完整显示短文件名");
      await btn("编辑模式").click();
      await btn("预览").waitFor();
      await page.keyboard.press("Escape");
    }
  } else {
    assert(closedToggle.width >= 44 && closedToggle.height >= 44);
    assert.equal(await pane.isVisible(), false);
  }
  await close.click();
  assert.deepEqual(await pane.boundingBox(), closedPane);
}
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
    await page.getByLabel("API Key").fill("test-only");
    await ui.save(); await ui.manual("test"); await ui.test();
    const status = page.locator(".assistant-error");
    await status.filter({ hasText: "桌面客户端" }).waitFor();
    const diagnostic = await status.innerText();
    assert(diagnostic.includes(origin) && diagnostic.includes(service));
    assert(diagnostic.includes("跨域"));
    assert(!diagnostic.includes("test-only"));
    assert(received.includes("OPTIONS /denied/v1/chat/completions"), JSON.stringify(received));
    await ui.settings();
    await address.fill(`${service}/allowed/v1`);
    await page.getByLabel("API Key").fill("test-only");
    await ui.save(); await ui.manual("test"); await ui.test();
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
  await checkSidebarLayout(".workspace");
  await ui.settings();
  await checkBrowserTransport();
  await page.waitForFunction(()=>localStorage.getItem("wenote-codex-catalog-version"));
  await page.route("https://registry.npmjs.org/**", r => r.fulfill({json:{version:"1.2.99"}}));
  await page.evaluate(()=>localStorage.removeItem("wenote-codex-catalog-version"));
  await page.reload();
  let requested = 0;
  let modelCalls = 0;
  let summarize = false;
  const expectedKey = "test-chat-key";
  const model = "http://127.0.0.1:19456/v1";
  await page.route(model + "/**", async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      if (req.url().includes('?')) {
        assert.equal(new URL(req.url()).searchParams.get('client_version'), '1.2.99');
        await route.fulfill({json:{models:[{slug:'test',default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'},{effort:'ultra'}]}]}});
      } else await route.fulfill({json:{data:[{id:'anonymous'},{id:'test'}]}});
      return;
    }
    const body = req.postDataJSON();
    modelCalls++;
    const anonymous = body.model === "anonymous";
    if (!req.headers().authorization && !anonymous) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "API_KEY_REQUIRED", message: "API key is required" } }) });
      return;
    }
    assert.equal(req.headers().authorization, anonymous ? undefined : `Bearer ${expectedKey}`);
    if (req.url().endsWith("/responses")) {
      assert.equal(body.reasoning.effort, 'ultra');
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
    if(check) assert.equal(body.reasoning_effort, anonymous ? undefined : 'ultra');
    const tool = check
      ? "check_connection"
      : body.messages.at(-1)?.role === "tool"
        ? ""
        : summarize ? "read_note" : "create_note";
    const ref = summarize && String(body.messages[0].content).match(/"file_id":"([^"]+)","path":"周报.md"/);
    if (summarize) assert(ref, '模型应收到所引用笔记的工具 ID');
    const args = summarize && !check ? {file_id:ref[1]} : check
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
      : { role: "assistant", content: summarize ? "联调在周五。" : "已完成周报。" };
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
  await ui.settings();
  await page.getByLabel('服务地址',{exact:true}).fill(model);
  await ui.save(); await ui.manual('anonymous'); await ui.test();
  await page.getByText('可用于写笔记',{exact:true}).waitFor();
  await ui.settings(); await page.getByLabel('API Key').fill(expectedKey); await ui.protocol('OpenAI Responses'); await ui.save();
  async function testEffort(){
    await btn('选择聊天模型').click(); await btn('test').click();
    const slider=page.getByRole('slider',{name:'推理等级'});
    await slider.press('End');
    await btn('恢复默认推理等级').click();
    assert.match(await btn('选择聊天模型').innerText(),/test · 默认/);
    await btn('重新选择模型').click();
    await btn('anonymous').click();
    assert.equal(await page.getByRole('dialog',{name:'选择推理等级'}).count(),0);
    await btn('选择聊天模型').click(); await btn('test').click();
    await slider.press('End'); await slider.press('Escape');
    assert.match(await btn('选择聊天模型').innerText(),/test · 超高/);
    await ui.test();
    await page.getByText('可用于写笔记',{exact:true}).waitFor();
  }
  await testEffort(); await ui.settings(); await ui.protocol('OpenAI Chat Completions'); await ui.save(); await testEffort();
  await btn("授权编辑").click();
  const draft = page.getByRole("textbox", {name:"助手消息"});
  await page.getByText('起草一篇笔记', {exact:true}).click();
  assert.equal(await draft.inputValue(), '起草一篇笔记');
  assert.equal(await draft.evaluate(el=>el===document.activeElement), true);
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
    const scoped = Object.keys(localStorage).find(k => k.startsWith(storageKey + ":"));
    const { api, baseUrl, model } = JSON.parse(localStorage.getItem(scoped)).model;
    localStorage.removeItem(scoped);
    localStorage.setItem(storageKey, JSON.stringify({ api, baseUrl, model }));
  });
  await page.reload();
  await btn("展开笔记助手").click();
  await btn("发送").click();
  await page.getByRole("alert").filter({ hasText: "模型设置" }).waitFor();
  assert.equal(await draft.inputValue(), prompt);
  assert.equal(await page.locator(".assistant-line.role-user").count(), 0);
  assert.equal(modelCalls, callsBeforeSend + 1);
  await ui.settings();
  await page.getByLabel("API Key").fill(expectedKey);
  await ui.save();
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
  const vote = page.locator('.ant-actions-feedback-item-like');
  await vote.click();
  await page.locator('.ant-actions-feedback-item-like-active').waitFor();
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
  await page.locator('.ant-actions-feedback-item-like-active').click();
  assert.equal(await page.locator('.ant-actions-feedback-item-like-active').count(),0);
  await btn("收起笔记助手").click();
  await page.locator(".entry").filter({ hasText: "周报.md" }).click();
  await checkSidebarLayout(".workspace", btn("更多操作"));
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator(".phone-document-head").waitFor();
  await checkSidebarLayout(".workspace", btn("更多操作"));
  await btn("返回笔记列表").click();
  await checkSidebarLayout(".note-list-pane", btn("打开笔记库目录"));
  await btn("展开笔记助手").click();
  assert(await draft.isVisible());
  await ui.settings(); await page.getByLabel('API Key').fill(expectedKey); await ui.save();
  await draft.fill('手机草稿');
  await btn('选择聊天模型').click(); await btn('test').click();
  const slider = page.getByRole('slider', {name:'推理等级'});
  const rail = await slider.boundingBox();
  assert(rail.width > 120 && rail.x >= 0 && rail.x + rail.width <= 390);
  for (const scheme of ['dark', 'light']) {
    await page.evaluate(value=>document.documentElement.dataset.colorScheme=value,scheme);
    assert.equal(await slider.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)', '滑杆输入层应露出下方的等级轨道');
  }
  await slider.press('End');
  if (process.env.WENOTE_ASSISTANT_PREVIEW) await page.screenshot({path:process.env.WENOTE_ASSISTANT_PREVIEW,animations:'disabled'});
  await slider.press('Escape');
  assert.equal(await draft.inputValue(),'手机草稿');
  await btn('新对话').click();
  if (await page.getByTitle('移除引用 周报.md').count()) await page.getByTitle('移除引用 周报.md').click();
  await draft.press('@');
  await page.getByRole('menuitemcheckbox',{name:'周报.md'}).waitFor();
  await draft.press('Enter');
  await page.getByTitle('移除引用 周报.md').waitFor();
  summarize=true;
  await draft.fill('总结引用的笔记'); await btn('发送').click();
  await page.getByText('联调在周五。',{exact:true}).waitFor();
  await page.getByText('本轮读取 · 1 篇笔记',{exact:true}).click();
  await page.locator('.ant-sources-list-item').getByText('周报.md').click();
  if(await btn('收起笔记助手').isVisible()) await btn('收起笔记助手').click();
  await page.locator('.phone-document-head').getByText('周报.md',{exact:true}).waitFor();
  const other = (await api("vaults", { name: "第二个库" })).id;
  await page.goto(`${origin}/?vault=${other}`);
  await btn("展开笔记助手").click();
  await btn("授权只读").waitFor();
  assert.equal(await draft.inputValue(), "");
  assert.equal(
    await page.getByText("已完成周报。", { exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 1280, height: 800 });
  await checkResponsesTurn(page, origin, async () => (await api(`vaults/${other}/files`)).files);
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
