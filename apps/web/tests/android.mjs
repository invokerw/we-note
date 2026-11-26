// Run against a disposable emulator with the debug APK installed.
import { fileURLToPath } from "node:url";
import { pack } from "../plugin-sdk/pack.mjs";
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
  const logName = `mobile-${randomUUID().slice(0, 8)}.log`;
  await api(base + "/files", "POST", {
    path: logName,
    content: Buffer.from("离线日志").toString("base64"),
  });
  await api(base + "/files", "POST", {
    path: "插件.txt",
    content: Buffer.from("WN1\n离线插件").toString("base64"),
  });
  for (let i = 1; i <= 6; i++) {
    await api(base + "/files", "POST", {
      path: `资料/会议记录-${i}.md`,
      content: Buffer.from("讨论记录").toString("base64"),
    });
  }
  // CI emulators expose a hardware keyboard. Exercise the phone IME as well.
  adb("shell", "settings", "put", "secure", "show_ime_with_hard_keyboard", "1");
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
  await button("打开笔记").click();
  const cdp = await page.context().newCDPSession(page);
  async function tap(locator) {
    await locator.click({ trial: true });
    const rect = await locator.boundingBox();
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  const systemBack = () => adb("shell", "input", "keyevent", "KEYCODE_BACK");
  const dialog = page.getByRole("dialog");
  const item = (name) => page.getByRole("menuitem", { name, exact: true });
  await button("打开笔记库目录").waitFor();
  const target = await button("原稿.md 的操作").boundingBox();
  assert(target.width >= 48 && target.height >= 48);
  const scroll = page.locator(".list-scroll");
  const list = await scroll.boundingBox();
  const start = { x: list.x + 40, y: list.y + list.height - 24 };
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [start],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: start.x, y: start.y - 100 }],
  });
  await delay(600);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  assert(
    await scroll.evaluate((el) => el.scrollTop > 0),
    "Dragging scrolls the list",
  );
  assert.equal(await dialog.isVisible(), false);
  await button("文件夹").click();
  await page
    .getByRole("heading", { name: "我的文件夹", exact: true })
    .waitFor();
  await tap(button("新建"));
  await button("Markdown").waitFor();
  await button("思维导图").waitFor();
  await button("上传文件").waitFor();
  await button("上传文件夹").waitFor();
  systemBack();
  await tap(button("资料 6 篇笔记"));
  await tap(button("上一级目录"));
  await tap(button("笔记"));
  await tap(button("原稿.md 的操作"));
  await tap(item("新建"));
  await item("Markdown").waitFor();
  systemBack();
  await item("复制").waitFor();
  systemBack();
  await dialog.waitFor({ state: "hidden" });
  const row = button("原稿.md");
  await row.waitFor();
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 20, y: box.y + 12 }],
  });

  await item("复制").waitFor();
  const bounds = await dialog.boundingBox();
  assert(
    Math.abs(
      bounds.y + bounds.height - (await page.evaluate(() => innerHeight)),
    ) < 2,
    "Actions sit at the bottom edge",
  );
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await item("复制").click();

  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await button("原稿 副本.md").waitFor();
  await button("原稿 副本.md 的操作").click();
  await item("重命名").click();
  await dialog.getByLabel("名称").fill("临时.md");
  await dialog.getByRole("button", { name: "确定", exact: true }).click();
  await button("临时.md 的操作").click();
  await item("导出为PDF").click();
  await dialog.getByText("第一版", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "打印 / 保存为 PDF" }).click();
  let printing = false;
  for (let i = 0; i < 30; i++) {
    if (
      /mCurrentFocus=Window\{[^\n]*printspooler/i.test(
        adb("shell", "dumpsys", "window"),
      )
    ) {
      printing = true;
      break;
    }
    await delay(150);
  }
  assert(printing, "Android system print dialog");
  adb("shell", "input", "keyevent", "4");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await button("临时.md 的操作").click();
  await item("删除").click();
  await dialog.getByRole("button", { name: "确认删除" }).click();
  await button("临时.md").waitFor({ state: "detached" });

  console.log(
    "Android long press, offline copy/rename/delete and native print passed",
  );
  await button("原稿.md").click();
  await tap(button("更多操作"));
  await tap(button("编辑模式"));
  await button("可视化编辑").waitFor();
  await button("分屏编辑").waitFor();
  systemBack();
  await dialog.getByRole("button", { name: "编辑模式" }).waitFor();
  systemBack();
  await dialog.waitFor({ state: "hidden" });
  async function editMarkdownSource() {
    await tap(button("更多操作"));
    await tap(button("编辑模式"));
    await tap(button("分屏编辑"));
    await tap(page.getByLabel("笔记源码").locator(".cm-line").first());
  }
  const readingHeight = await page.evaluate(() => visualViewport.height);
  await editMarkdownSource();
  try {
    await page.waitForFunction((h) => visualViewport.height < h - 80, readingHeight);
  } catch (error) {
    console.error("Keyboard viewport", readingHeight, await page.evaluate(() => ({
      visible: visualViewport.height, layout: innerHeight, focus: document.activeElement?.getAttribute("aria-label"),
    })), adb("shell", "dumpsys", "input_method").match(/mInputShown=\w+/)?.[0]);
    throw error;
  }
  await page.getByLabel("笔记源码").fill("手机离线编辑");
  systemBack();
  await page.waitForFunction((h) => visualViewport.height >= h - 4, readingHeight);
  await button("完成").waitFor();
  await tap(button("返回笔记列表"));
  await tap(button("原稿.md"));
  assert.match(await page.getByLabel("笔记源码").innerText(), /手机离线编辑/);
  await tap(button("完成"));
  await page.getByText("已保存到本地目录").waitFor();
  console.log("Offline restart and save passed");
  const pickLocal = async (p) => {
    if (await button("返回笔记列表").isVisible())
      await tap(button("返回笔记列表"));
    await button(p).click();
  };
  async function openSettings(section) {
    if (await button("关闭个人设置").isVisible()) await button("关闭个人设置").click();
    if (await button("返回笔记列表").isVisible()) await tap(button("返回笔记列表"));
    await button("打开个人设置").click();
    await button(section).click();
  }
  await pickLocal(logName);
  await tap(button("编辑"));
  const plain = page.getByRole("textbox", { name: "纯文本正文" });
  await plain.fill("周五验收");
  await tap(button("完成"));
  await pickLocal("原稿.md");
  await pickLocal(logName);
  await page.locator(".document-mode > pre").filter({ hasText: "周五验收" }).waitFor();
  await tap(button("更多操作"));
  await button("下载原文件").click();
  let picker = false;
  for (let i = 0; i < 30; i++) {
    picker = /mCurrentFocus=Window\{[^\n]*documentsui/i.test(
      adb("shell", "dumpsys", "window"),
    );
    if (picker) break;
    await delay(200);
  }
  assert.ok(picker, "Android document export picker opened");
  const hierarchy = "/data/local/tmp/wenote-export-picker.xml";
  adb("shell", "uiautomator", "dump", hierarchy);
  const layout = adb("shell", "cat", hierarchy);
  const save = layout.match(
    /<node\b[^>]*resource-id="[^"]*:(?:id\/button_save|id\/button1)"[^>]*>/,
  )?.[0];
  assert.ok(save, "Document picker has a Save button");
  const [, left, top, right, bottom] = save
    .match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    .map(Number);
  adb(
    "shell",
    "input",
    "tap",
    String(Math.floor((left + right) / 2)),
    String(Math.floor((top + bottom) / 2)),
  );
  let exported = "";
  for (let i = 0; i < 25; i++) {
    const file = adb(
      "shell",
      "find",
      "/storage/emulated/0/Download",
      "-name",
      logName,
    ).trim();
    if (file) {
      exported = adb("shell", "cat", file);
      if (exported.includes("周五验收")) break;
    }
    await delay(200);
  }
  if (!exported) console.error("Files in emulator Downloads", adb("shell", "ls", "-1", "/storage/emulated/0/Download"));
  assert.equal(exported, "周五验收", `Expected original file ${logName} in Downloads`);
  await openSettings("编辑与插件");
  const sample = await pack(
    fileURLToPath(new URL("../plugin-sdk/example", import.meta.url)),
  );
  await page.getByLabel("安装本地插件包").evaluate((input, b64) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File(
        [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))],
        "example.zip",
        { type: "application/zip" },
      ),
    );
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, Buffer.from(sample).toString("base64"));
  await button("授权并安装").click();
  await button("关闭个人设置").click();
  await pickLocal("插件.txt");
  assert.equal(await page.getByLabel("插件文档").inputValue(), "离线插件");
  await page.getByLabel("插件文档").fill("离线保存成功");
  await button("保存").click();
  await pickLocal("原稿.md");
  console.log(
    "Android offline text, document picker and installed WASM codec passed",
  );
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
  await openSettings("设备与同步");
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
  await button("打开笔记").click();
  await button("原稿.md").click();
  await editMarkdownSource();
  const image = await page.getByLabel("笔记源码").evaluate(async (el) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < pixels.data.length; i += 65536)
      crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
    ctx.putImageData(pixels, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([png], "手机图片.png", { type: "image/png" });
    const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const data = new DataTransfer();
    data.items.add(file);
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: data, bubbles: true, cancelable: true,
    }));
    return { name: file.name, size: file.size,
      hash: "sha256:" + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") };
  });
  assert.ok(image.size > (4 << 20), "PNG exercises multipart upload");
  await page.waitForFunction(
    name => document.querySelector(".cm-content")?.textContent.includes(`![${name}](`),
    image.name, { timeout: 90000 },
  );
  const assets = await (await api(base + "/assets")).json();
  const uploaded = assets.find(a => a.name === image.name);
  assert.equal(uploaded?.content_size, image.size);
  assert.equal(uploaded.content_hash, image.hash);
  await tap(button("完成"));
  await page.getByText("已保存到本地目录").waitFor();
  await openSettings("导出/导入");
  await page.getByLabel("图片链接").selectOption("portable");
  await button("创建导出").click();
  const portableRow = page.locator(".row").filter({ hasText: "离线便携" });
  await portableRow.getByRole("button", { name: "下载 ZIP" }).click();
  await page.getByText(/已保存到 .*\.zip/).waitFor();
  await openSettings("设备与同步");
  await button("返回同步").click();
  await button("退出账户").click();
  await button("登录").waitFor();
  // WebView writes localStorage asynchronously. A completed native sync must
  // remain discoverable even if Android kills the process before that flush.
  await page.evaluate(() => localStorage.clear());
  adb("reverse", "--remove", port);
  adb("shell", "am", "force-stop", pkg);
  page = await launch();
  await button("打开笔记").click();
  await button(conflict.path).click();
  await page.locator(".reading").getByText("手机离线编辑").waitFor();
  console.log(
    "Android emulator passed offline restart, system share, scheduled sync, conflict recovery, multipart image upload and portable ZIP download.",
  );
} finally {
  if (adb("reverse", "--list").includes(port + " "))
    adb("reverse", "--remove", port);
  await Promise.all(devices.map((d) => d.close()));
}
