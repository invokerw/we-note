import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assistantUI } from "./assistant-ui.mjs";

const path = "发布清单.md";
const before = "发布验收安排在周三。";
const after = "发布验收安排在周五。";
const question = "把发布清单里的验收日期改到周五。";
const endpoint = "https://assistant-fixture.invalid/v1";

function streamItem(item, summary) {
  const events = [
    { type: "response.created", response: { id: "resp_fixture" } },
  ];
  if (summary)
    events.push({
      type: "response.reasoning_summary_text.delta",
      item_id: "reason",
      summary_index: 0,
      delta: summary,
    });
  events.push({
    type: "response.output_item.added",
    output_index: 0,
    item: {
      ...item,
      ...(item.type === "message" ? { content: [] } : { arguments: "" }),
    },
  });
  if (item.type === "message") {
    events.push(
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "" },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: item.content[0].text,
      },
    );
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_fixture", status: "completed", output: [item] },
    },
  );
  return events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}
const call = (name, args) => ({
  type: "function_call",
  name,
  call_id: `call_${name}`,
  id: `fc_${name}`,
  arguments: JSON.stringify(args),
});
const answer = (text) => ({
  type: "message",
  id: "msg",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});

export async function checkAssistantDesign(page, origin, api) {
  const vault = (await api("vaults", { name: "交互样稿验收" })).id;
  const file = await api(`vaults/${vault}/files`, {
    path,
    content: Buffer.from(
      `# 发布清单\n\n完成客户端与网关的联调验证。\n\n${before}`,
    ).toString("base64"),
  });
  const shots = process.env.WENOTE_ASSISTANT_DESIGN_DIR;
  const pane = page.locator("#note-assistant");
  const btn = (name) => page.getByRole("button", { name, exact: true });
  const draft = page.getByRole("textbox", { name: "助手消息" });
  const shot = async (name, locator = pane) => {
    if (shots)
      await locator.screenshot({
        path: join(shots, name + ".png"),
        animations: "disabled",
      });
  };
  let readonly = false;
  await page.setViewportSize({ width: 1280, height: 820 });
  if (shots) {
    await mkdir(shots, { recursive: true });
    await page.goto(`${origin}/static/assistant-design/`);
    await btn("应用修改").waitFor();
    await shot("reference-edit", page.locator("aside"));
  }
  await page.route(endpoint + "/**", async (route) => {
    const req = route.request();
    if (req.method() === "GET")
      return route.fulfill({
        json: req.url().includes("?")
          ? {
              models: [
                {
                  slug: "fixture",
                  supported_reasoning_levels: [
                    { effort: "low" },
                    { effort: "xhigh" },
                  ],
                  default_reasoning_level: "low",
                },
              ],
            }
          : { data: [{ id: "fixture", display_name: "6.2 Astra" }] },
      });
    const body = req.postDataJSON(),
      input = body.input || [];
    const tool = input
      .filter((item) => item.type === "function_call_output")
      .at(-1);
    let item, summary;
    if (!tool) {
      const instructions = input
        .filter((m) => m.role === "developer" || m.role === "system")
        .map((m) => m.content)
        .join("\n");
      const refs = String(body.instructions ?? instructions).match(
        /"file_id":"([^"]+)","path":"发布清单.md"/,
      );
      assert(refs, "请求应携带当前文件引用");
      item = call("read_note", { file_id: refs[1] });
      if (!readonly) summary = "只调整发布验收的日期，联调安排保持原文。";
    } else if (!readonly && tool.call_id.includes("read_note")) {
      const note = JSON.parse(
        typeof tool.output === "string" ? tool.output : tool.output[0].text,
      );
      item = call("edit_note", {
        file_id: note.file_id,
        base_version_id: note.version_id,
        base_path: note.path,
        operation_id: "op_fixture",
        edit: { mode: "replace_text", old_text: before, new_text: after },
      });
    } else
      item = answer(
        readonly
          ? "本周需要完成联调验证和发布验收。"
          : "已将发布验收日期改为周五。",
      );
    return route.fulfill({
      contentType: "text/event-stream",
      body: streamItem(item, summary),
    });
  });
  await page.goto(`${origin}/?vault=${vault}&note=${file.file_id}`);
  await page
    .locator(".document-head")
    .getByText(path, { exact: true })
    .waitFor();
  const ui = assistantUI(page);
  await ui.settings();
  await page.getByLabel("服务地址", { exact: true }).fill(endpoint);
  await ui.protocol("OpenAI Responses");
  await ui.save();
  await btn("授权编辑").click();
  await btn("选择聊天模型").filter({ hasText: "6.2 Astra · 默认" }).waitFor();
  await btn("管理引用").click();
  const search = page.getByRole("checkbox", { name: "搜索本库" });
  await search.check();
  await search.uncheck();
  await btn("管理引用").click();
  await shot("live-empty");
  await draft.fill(question);
  await btn("发送").click();
  await btn("应用修改").waitFor();
  await shot("live-edit");
  assert(
    (await pane.boundingBox()).width >= 400,
    "桌面聊天栏应接近样稿的 410px",
  );
  const preview = pane.locator('section[aria-label="修改预览"]');
  assert.deepEqual(await preview.locator("dt").allTextContents(), [
    "原文",
    "改为",
  ]);
  assert.deepEqual(await preview.locator("dd").allTextContents(), [
    before,
    after,
  ]);
  assert.equal(await preview.locator("strong").last().textContent(), "五");
  assert.equal(
    await pane.locator(".ant-thought-chain").count(),
    1,
    "同一组连续工具应共用一条步骤链",
  );
  assert.equal(await pane.locator(".ant-sender .ant-tag").count(), 0);
  assert.equal(await pane.locator(".assistant-compose .ant-tag").count(), 1);
  assert.equal(await pane.locator(".assistant-answer-actions").count(), 0);
  await page.setViewportSize({ width: 390, height: 780 });
  await shot("live-edit-mobile");
  assert(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth));
  await btn("应用修改").click();
  await pane.getByText("已将发布验收日期改为周五。", { exact: true }).waitFor();
  assert.equal(await preview.count(), 0);
  assert.equal(
    await pane.locator(".ant-bubble-footer .ant-actions-feedback").count(),
    1,
  );
  await page.setViewportSize({ width: 1280, height: 820 });
  readonly = true;
  await btn("新对话").click();
  await pane.getByText("想怎样处理这篇笔记？", { exact: true }).waitFor();
  await draft.fill("总结这篇笔记的待办。");
  await btn("发送").click();
  await pane
    .getByText("本周需要完成联调验证和发布验收。", { exact: true })
    .waitFor();
  assert.equal(await pane.locator(".ant-think").count(), 0);
  assert.equal(
    await pane.getByText("本轮读取 · 1 篇笔记", { exact: true }).count(),
    1,
  );
  await shot("live-read");
}
