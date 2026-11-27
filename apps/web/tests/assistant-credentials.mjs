import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
async function account() {
  const user = {
    email: randomUUID() + "@example.invalid",
    password: randomUUID(),
  };
  async function post(path, body, token) {
    const r = await fetch(`${origin}/api/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
    });
    assert(r.ok);
    return r.json();
  }
  await post("auth/register", user);
  const { access_token: token } = await post("auth/login", user);
  const { id } = await post("vaults", { name: "密钥试用" }, token);
  return { token, id };
}
const alice = await account(),
  bob = await account();
const profile = await mkdtemp(join(tmpdir(), "wenote-model-profile-"));
const endpoint = "https://model.example.invalid/v1";
const secret = randomUUID();
let context,
  page,
  modelCalls = 0;
const button = (name) => page.getByRole("button", { name, exact: true });
const remember = () => page.getByLabel("在本机记住密钥");
async function restart(user) {
  await context?.close();
  context = await chromium.launchPersistentContext(profile, {
    channel: process.env.CHROME_PATH ? undefined : "chrome",
    executablePath: process.env.CHROME_PATH,
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.addInitScript(
    (token) => sessionStorage.setItem("wenote-session", token),
    user.token,
  );
  await page.route(endpoint + "/chat/completions", async (route) => {
    assert.equal(route.request().headers().authorization, `Bearer ${secret}`);
    modelCalls++;
    const chunk = {
      id: "test",
      model: "test",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "凭据验证成功" },
          finish_reason: "stop",
        },
      ],
    };
    await route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
    });
  });
  await page.goto(`${origin}/?vault=${user.id}`);
  await button("展开笔记助手").waitFor();
}
async function settings() {
  await button("打开个人设置").click();
  await button("笔记助手").click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".assistant-config")?.disabled &&
      !!document.querySelector(".assistant-config"),
  );
}
async function save() {
  await button("保存模型设置").click();
  await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  await button("关闭个人设置").click();
}
try {
  await restart(alice);
  await settings();
  await page.getByLabel("服务地址", { exact: true }).fill(endpoint);
  await page.getByLabel("模型 ID").fill("test");
  await page.getByLabel("API Key").fill(secret);
  await remember().check();
  await save();
  const protectedLocally = await page.evaluate(async () => {
    const scoped = Object.keys(localStorage).find((k) =>
      k.startsWith("wenote-assistant-model:"),
    );
    const { savedKey } = JSON.parse(localStorage.getItem(scoped));
    const localKey = await new Promise((resolve, reject) => {
      const open = indexedDB.open("wenote-model-credentials");
      open.onsuccess = () => {
        const db = open.result;
        const get = db.transaction("keys").objectStore("keys").get("device");
        get.onsuccess = () => {
          db.close();
          resolve(get.result);
        };
        get.onerror = () => reject(get.error);
      };
      open.onerror = () => reject(open.error);
    });
    return !!savedKey?.data?.length && localKey?.extractable === false;
  });
  assert(protectedLocally);
  assert(
    !(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))
    ).includes(secret),
  );
  await restart(bob);
  await settings();
  assert.equal(await page.getByLabel("API Key").inputValue(), "");
  assert.equal(await remember().isChecked(), false);
  await restart(alice);
  await button("展开笔记助手").click();
  await button("授权只读").click();
  await page.getByLabel("助手消息").fill("验证本机密钥");
  await button("发送").click();
  await page.getByText("凭据验证成功", { exact: true }).waitFor();
  assert.equal(modelCalls, 1);
  await settings();
  assert(await remember().isChecked());
  assert.equal(await page.getByLabel("API Key").inputValue(), secret);
  await page.getByLabel("服务地址", { exact: true }).fill(endpoint + "/other");
  assert.equal(await page.getByLabel("API Key").inputValue(), "");
  await button("关闭个人设置").click();
  await settings();
  await remember().uncheck();
  await save();
  await restart(alice);
  await settings();
  assert.equal(await page.getByLabel("API Key").inputValue(), "");
  assert.equal(await remember().isChecked(), false);
  assert(
    !(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))
    ).includes(secret),
  );
  console.log("通过：重启后直接聊天、账号及端点隔离、取消本机记忆");
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
