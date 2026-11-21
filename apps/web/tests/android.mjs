// Run against a disposable emulator with the debug APK installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { _android } from "playwright-core";
const pkg = "com.wenote.desktop",
  origin = process.env.WENOTE_TEST_ORIGIN;
const serial = process.env.ANDROID_SERIAL;
assert.match(
  serial || "",
  /^emulator-\d+$/,
  "Select the disposable test emulator with ANDROID_SERIAL",
);
const adb = (...args) =>
  execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    timeout: 30000,
  });
const devices = await _android.devices({
  omitDriverInstall: true,
  port: Number(process.env.ANDROID_ADB_SERVER_PORT || 5037),
});
const device = devices.find((d) => d.serial() === serial);
assert.ok(device);
const port = "tcp:" + new URL(origin).port;
async function launch() {
  adb("shell", "am", "start", "-W", "-n", pkg + "/.MainActivity");
  const socketName =
    "webview_devtools_remote_" + adb("shell", "pidof", pkg).trim();
  // A new WebView exposes its socket before Chromium creates the page target.
  const forward = adb("forward", "tcp:0", "localabstract:" + socketName).trim();
  try {
    for (let i = 0; i < 100; i++) {
      const targets = await fetch(`http://127.0.0.1:${forward}/json/list`, {
        signal: AbortSignal.timeout(1000),
      })
        .then((r) => r.json())
        .catch(() => []);
      if (
        targets.some(
          (t) => t.type === "page" && t.url.includes("tauri.localhost"),
        )
      )
        break;
      if (i === 99) throw Error("Android WebView page did not load");
      await delay(150);
    }
  } finally {
    adb("forward", "--remove", "tcp:" + forward);
  }
  const page = await (
    await device.webView({ socketName }, { timeout: 60000 })
  ).page();
  page.setDefaultTimeout(20000);
  return page;
}
let token = "";
async function api(path, method = "GET", body) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body && JSON.stringify(body),
  });
  assert.ok(r.ok, await r.clone().text());
  return r;
}
try {
  const email = randomUUID() + "@example.invalid",
    password = "phase-three-android";
  await api("/api/v1/auth/register", "POST", { email, password });
  token = (
    await (await api("/api/v1/auth/login", "POST", { email, password })).json()
  ).access_token;
  const vault = await (
    await api("/api/v1/vaults", "POST", { name: "Android 验收" })
  ).json();
  const base = `/api/v1/vaults/${vault.id}`;
  const note = await (
    await api(base + "/files", "POST", {
      path: "原稿.md",
      content: Buffer.from("第一版").toString("base64"),
    })
  ).json();
  adb("reverse", port, port);
  let page = await launch();
  console.log("Android login page loaded");
  const button = (name) => page.getByRole("button", { name, exact: true });
  await page.getByLabel("服务地址").fill(origin);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await button("登录").click();
  await button("立即同步").click();
  await page
    .locator("#status")
    .getByText(/上次同步/)
    .waitFor();
  await page.getByLabel("Android 后台同步").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#background").checked &&
      document.querySelector("#vault").disabled,
  );
  console.log("Initial sync and scheduling passed");
  adb("reverse", "--remove", port);
  adb("shell", "am", "force-stop", pkg);
  page = await launch();
  await button("打开本地编辑器").click();
  await page.getByLabel("本地笔记", { exact: true }).selectOption("原稿.md");
  await button("源码").click();
  await page.getByLabel("笔记源码").fill("手机离线编辑");
  await button("保存").click();
  await page.getByText("已保存到本地目录").waitFor();
  console.log("Offline restart and save passed");
  await button("系统分享").click();
  for (let i = 0; i < 20; i++) {
    if (
      /mCurrentFocus=Window\{[^\n]*ChooserActivity/.test(
        adb("shell", "dumpsys", "window"),
      )
    )
      break;
    if (i === 19) throw Error("System sharesheet did not open");
    await delay(150);
  }
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await button("返回同步").click();
  await api(base + "/files/" + note.file_id + "/content", "PUT", {
    base_version_id: note.version_id,
    content: Buffer.from("网页同时编辑").toString("base64"),
  });
  adb("reverse", port, port);
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  adb("shell", "cmd", "jobscheduler", "run", "-f", pkg, "103");
  // A conflict copy becomes an independent file on the next scan.
  for (let i = 0; i < 60; i++) {
    const content = adb(
      "shell",
      "run-as",
      pkg,
      "find",
      ".",
      "-name",
      "*conflict*",
    );
    if (content.includes("conflict")) break;
    if (i === 59)
      throw Error("Background sync did not preserve an offline conflict copy");
    await delay(500);
  }
  adb("shell", "am", "start", "-n", pkg + "/.MainActivity");
  await button("立即同步").click();
  let conflict;
  for (let i = 0; i < 40 && !conflict; i++) {
    const files = await (await api(base + "/files")).json();
    conflict = files.files.find((f) => f.path.includes("conflict"));
    if (!conflict) await delay(250);
  }
  assert.ok(conflict);
  assert.equal(
    await (await api(base + "/files/" + conflict.file_id + "/content")).text(),
    "手机离线编辑",
  );
  assert.equal(
    await (await api(base + "/files/" + note.file_id + "/content")).text(),
    "网页同时编辑",
  );
  await button("打开本地编辑器").click();
  await page.getByLabel("本地笔记", { exact: true }).selectOption("原稿.md");
  await button("源码").click();
  await page.getByLabel("笔记源码").evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array((4 << 20) + 7)], "手机附件.bin", {
        type: "application/octet-stream",
      }),
    );
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".cm-content")
        ?.textContent.includes("手机附件.bin"),
    null,
    { timeout: 90000 },
  );
  const assets = await (await api(base + "/assets")).json();
  assert.equal(
    assets.find((a) => a.name === "手机附件.bin")?.content_size,
    (4 << 20) + 7,
  );
  await button("保存").click();
  await page.getByText("已保存到本地目录").waitFor();
  await button("返回同步").click();
  await button("退出账户").click();
  await button("登录").waitFor();
  // WebView writes localStorage asynchronously. A completed native sync must
  // remain discoverable even if Android kills the process before that flush.
  await page.evaluate(() => localStorage.clear());
  adb("reverse", "--remove", port);
  adb("shell", "am", "force-stop", pkg);
  page = await launch();
  await button("打开本地编辑器").click();
  await page
    .getByLabel("本地笔记", { exact: true })
    .selectOption(conflict.path);
  await page.locator(".reading").getByText("手机离线编辑").waitFor();
  console.log(
    "Android emulator passed offline restart, system share, scheduled sync, conflict recovery and multipart attachment upload.",
  );
} finally {
  if (adb("reverse", "--list").includes(port + " "))
    adb("reverse", "--remove", port);
  await Promise.all(devices.map((d) => d.close()));
}
