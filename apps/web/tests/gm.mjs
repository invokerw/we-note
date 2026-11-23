import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
const root = resolve(import.meta.dirname, "../../.."),
  temp = await mkdtemp(join(tmpdir(), "wenote-gm-test-"));
const children = [],
  messages = [];
// This test mailbox accepts only local connections and keeps messages in memory.
const mailbox = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 localhost test mailbox\r\n");
  let pending = "",
    body = null;
  socket.on("data", (chunk) => {
    pending += chunk;
    for (let i; (i = pending.indexOf("\r\n")) !== -1;) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 2);
      if (body !== null) {
        if (line !== ".") {
          body.push(line);
          continue;
        }
        messages.push(body.join("\n"));
        body = null;
        socket.write("250 accepted\r\n");
        continue;
      }
      if (line === "DATA") {
        body = [];
        socket.write("354 send content\r\n");
      } else if (line === "QUIT") {
        socket.end("221 bye\r\n");
      } else {
        socket.write("250 localhost\r\n");
      }
    }
  });
});
async function listen(s) {
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  return s.address().port;
}
async function start(args = []) {
  const probe = createServer(),
    port = await listen(probe);
  await new Promise((r) => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    join(root, "dist/local/wenote-api"),
    [
      "-addr",
      `127.0.0.1:${port}`,
      "-web-dir",
      join(root, "apps/web/dist"),
      "-mail-url",
      origin,
      ...args,
    ],
    {
      cwd: temp,
      stdio: "ignore",
      env: { ...process.env, WENOTE_SETUP_TOKEN: "" },
    },
  );
  children.push(child);
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error("test server exited");
    if (
      await fetch(origin + "/healthz")
        .then((r) => r.ok)
        .catch(() => false)
    )
      return origin;
    await delay(50);
  }
  throw Error("test server did not start");
}
const button = (page, name) => page.getByRole("button", { name, exact: true });
function mailLink(kind, origin) {
  const match = messages
    .at(-1)
    ?.match(new RegExp(`https?://[^\\s]+/#${kind}=[0-9a-f]+`));
  assert.ok(match, `missing ${kind} email`);
  assert.equal(new URL(match[0]).origin, origin);
  return match[0];
}
async function api(origin, path, token, method = "GET", body) {
  const headers = { "Idempotency-Key": randomUUID() };
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined && !Buffer.isBuffer(body))
    headers["Content-Type"] = "application/json";
  const response = await fetch(origin + "/api/v1/" + path, {
    method,
    headers,
    body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  return response;
}
async function json(...args) {
  const response = await api(...args);
  assert.ok(response.ok, `API status ${response.status} for ${args[1]}`);
  return response.json();
}
let chrome;
try {
  const port = await listen(mailbox),
    origin = await start();
  chrome = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    channel: process.env.CHROME_PATH ? undefined : "chrome",
  });
  const gm = await chrome.newPage(),
    user = await chrome.newPage();
  for (const page of [gm, user]) page.setDefaultTimeout(7000);
  const owner = "admin@example.test",
    email = "member@example.test",
    first = randomUUID(),
    next = randomUUID(),
    last = randomUUID();
  await gm.goto(origin + "/gm");
  await gm
    .getByLabel("服务器初始化令牌")
    .fill((await readFile(join(temp, "data/setup.token"), "utf8")).trim());
  await gm.getByLabel("邮箱", { exact: true }).fill(owner);
  await gm.getByLabel("密码", { exact: true }).fill(randomUUID());
  await button(gm, "创建管理员并登录").click();
  await button(gm, "系统设置").click();
  await gm.getByLabel("主机", { exact: true }).fill("127.0.0.1");
  await gm.getByLabel("端口").fill(String(port));
  await gm.getByLabel("安全方式").selectOption("plain");
  await gm.getByLabel("发件人地址").fill(owner);
  await button(gm, "保存设置").click();
  await gm.getByText("系统设置已保存", { exact: true }).waitFor();
  gm.once("dialog", (d) => d.accept(owner));
  await button(gm, "发送测试邮件").click();
  await gm.getByText("测试邮件已发送", { exact: true }).waitFor();
  assert.equal(messages.length, 1);
  await button(gm, "邀请").click();
  gm.once("dialog", (d) => d.accept(email));
  await button(gm, "创建邀请").click();
  await gm.getByRole("cell", { name: email, exact: true }).waitFor();
  const invited = gm.getByRole("row").filter({ hasText: email });
  const original = mailLink("invite", origin);
  await invited.getByRole("button", { name: "重发", exact: true }).click();
  await gm.getByText("邮件投递状态 sent", { exact: true }).waitFor();
  const renewed = mailLink("invite", origin);
  assert.notEqual(renewed, original);
  const useInvite = (url) =>
    api(
      origin,
      "auth/invitations/" +
        new URL(url).hash.slice("#invite=".length) +
        "/register",
      "",
      "POST",
      { password: first },
    );
  assert.equal((await useInvite(original)).status, 404);
  const other = "withdrawn@example.test";
  gm.once("dialog", (d) => d.accept(other));
  await button(gm, "创建邀请").click();
  const withdrawn = gm.getByRole("row").filter({ hasText: other });
  await withdrawn.waitFor();
  const revoked = mailLink("invite", origin);
  await withdrawn.getByRole("button", { name: "撤销", exact: true }).click();
  await withdrawn.getByText("已撤销", { exact: true }).waitFor();
  assert.equal((await useInvite(revoked)).status, 404);
  await user.goto(renewed);
  await user.getByLabel("新密码").fill(first);
  await button(user, "接受邀请").click();
  await user.getByText(/请查收验证邮件/).waitFor();
  const login = (password, host = origin) =>
    api(host, "auth/login", "", "POST", { email, password });
  assert.equal((await login(first)).status, 403);
  await user.goto(mailLink("verify", origin));
  await button(user, "验证邮箱").click();
  await user.getByText(/邮箱已验证/).waitFor();
  const session = await (await login(first)).json();
  assert.ok(session.access_token);
  const member = session.access_token;
  assert.equal((await api(origin, "admin/overview", member)).status, 403);
  await user.evaluate(
    (s) => sessionStorage.setItem("wenote-session", s),
    member,
  );
  await user.goto(origin + "/gm");
  await user.getByText("此页面需要管理员权限").waitFor();
  await user.goto(origin + "/#change");
  await user.getByLabel("当前密码").fill(first);
  await user.getByLabel("新密码").fill(next);
  await button(user, "修改密码").click();
  await user.getByText(/密码已修改/).waitFor();
  assert.equal((await api(origin, "me", member)).status, 401);
  await button(gm, "刷新").click();
  await button(gm, "用户").click();
  const row = gm.getByRole("row").filter({ hasText: email });
  await row.getByRole("button", { name: "重置密码" }).click();
  await gm.getByText("邮件投递状态 sent", { exact: true }).waitFor();
  await user.goto(mailLink("reset", origin));
  await user.getByLabel("新密码").fill(last);
  await button(user, "重置密码").click();
  await user.getByText(/密码已重置/).waitFor();
  assert.equal((await login(next)).status, 401);
  const valid = (await (await login(last)).json()).access_token;
  assert.ok(valid);
  const vault = await json(origin, "vaults", valid, "POST", {
      name: "恢复验收",
    }),
    base = `vaults/${vault.id}`,
    content = "WeNote 备份恢复验收";
  const note = await json(origin, base + "/files", valid, "POST", {
    path: "test.md",
    content: Buffer.from(content).toString("base64"),
  });
  const bytes = Buffer.from("attachment verification");
  const asset = await json(origin, base + "/assets/uploads", valid, "POST", {
    name: "sample.txt",
    media_type: "text/plain",
    content_size: bytes.length,
    content_hash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  });
  assert.ok(
    (
      await api(
        origin,
        base + "/assets/" + asset.asset_id + "/complete",
        valid,
        "POST",
        bytes,
      )
    ).ok,
  );
  await button(gm, "附件与存储").click();
  await gm.getByRole("cell", { name: "sample.txt" }).waitFor();
  gm.once("dialog", (d) => d.accept());
  await button(gm, "移入回收站").click();
  await button(gm, "恢复附件").click();
  await button(gm, "移入回收站").waitFor();
  await button(gm, "操作记录").click();
  await gm.getByRole("cell", { name: "smtp_test", exact: true }).waitFor();
  await button(gm, "备份").click();
  await button(gm, "立即备份").click();
  await button(gm, "校验").click();
  await gm.getByText("备份校验通过").waitFor();
  await button(gm, "准备恢复").click();
  const status = gm.getByRole("status").filter({ hasText: "恢复目录：" });
  await status.waitFor();
  const staged = resolve(
    temp,
    (await status.textContent()).replace("恢复目录：", ""),
  );
  const recovered = await start([
    "-db",
    join(staged, "wenote.db"),
    "-blobs",
    join(staged, "storage"),
  ]);
  const restoredUser = (await (await login(last, recovered)).json())
    .access_token;
  assert.ok(restoredUser);
  const restoredNote = await api(
    recovered,
    base + "/files/" + note.file_id + "/content",
    restoredUser,
  );
  assert.equal(await restoredNote.text(), content);
  assert.deepEqual(
    await readFile(
      join(
        staged,
        "storage",
        "blobs",
        vault.id,
        asset.content_hash.slice(7, 9),
        asset.content_hash.slice(7),
      ),
    ),
    bytes,
  );
  await button(gm, "用户").click();
  await row.getByRole("button", { name: "撤销会话" }).click();
  await gm.getByText("会话已撤销", { exact: true }).waitFor();
  assert.equal((await api(origin, "me", valid)).status, 401);
  await row.getByRole("button", { name: "禁用", exact: true }).click();
  await row.getByRole("button", { name: "恢复", exact: true }).waitFor();
  assert.equal((await login(last)).status, 403);
  await row.getByRole("button", { name: "恢复", exact: true }).click();
  await row.getByRole("button", { name: "禁用", exact: true }).waitFor();
  assert.equal((await login(last)).status, 200);
  console.log(
    "GM browser acceptance passed: setup, SMTP, invitation, verification, permissions, passwords, user status, asset trash, audit and recovery of note and attachment.",
  );
} finally {
  await chrome?.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  }
  if (mailbox.listening) await new Promise((r) => mailbox.close(r));
  await rm(temp, { recursive: true, force: true });
}
