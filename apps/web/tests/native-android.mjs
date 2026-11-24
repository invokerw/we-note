import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { _android } from "playwright-core";

// The caller owns the disposable emulator and the temporary API instance.
export async function verifyAndroid(origin, email, password) {
  const serial = process.env.ANDROID_SERIAL;
  assert.match(serial, /^emulator-\d+$/);
  const adb = (...args) =>
    execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8" }).trim();
  const port = "tcp:" + new URL(origin).port,
    pkg = "com.wenote.desktop";
  adb("reverse", port, port);
  let connected = true;
  const devices = await _android.devices({
    omitDriverInstall: true,
    port: Number(process.env.ANDROID_ADB_SERVER_PORT || 5037),
  });
  const device = devices.find((d) => d.serial() === serial);
  await Promise.all(devices.filter((d) => d !== device).map((d) => d.close()));
  assert.ok(device);
  let forward;
  async function launch() {
    adb("shell", "am", "start", "-W", "-n", pkg + "/.MainActivity");
    const socketName = "webview_devtools_remote_" + adb("shell", "pidof", pkg);
    forward = adb("forward", "tcp:0", "localabstract:" + socketName);
    const endpoint = "http://127.0.0.1:" + forward;
    for (let i = 0; i < 100; i++) {
      if (
        await fetch(endpoint + "/json/list")
          .then((r) => r.json())
          .then((xs) => xs.some((x) => x.type === "page"))
          .catch(() => false)
      )
        break;
      await delay(100);
    }
    const page = await (await device.webView({ socketName }, {timeout:20000})).page();
    page.setDefaultTimeout(15000);
    return page;
  }
  try {
    let page = await launch();
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
    await button("打开笔记").click();
    await button("路线.mind.json").click();
    await page.locator(".me-tpc").filter({ hasText: "调研" }).click();
    await button("备注").click();
    await page.getByLabel("备注", { exact: true }).fill("手机草稿");
    await button("确定").click();
    await button("保存").click();
    await page.getByText("已保存到本地目录").waitFor();
    await button("返回笔记列表").click();
    await button("笔记.md").click();
    await button("更多操作").click();
    await button("编辑模式").click();
    assert.deepEqual(await page.locator(".phone-choices button").allTextContents(), ["分屏编辑", "可视化编辑", "预览"]);
    await button("可视化编辑").click();
    await page.locator(".mode-crepe .milkdown").waitFor();
    assert.equal(await button("插入附件").count(), 0);
    await page
      .locator(".milkdown .ProseMirror p")
      .filter({ hasText: "编辑段落" })
      .click();
    await page.keyboard.insertText("手机");
    await button("完成").click();
    await page.locator(".reading").getByText(/手机/).waitFor();
    adb("reverse", "--remove", port);
    connected = false;
    adb("forward", "--remove", "tcp:" + forward);
    adb("shell", "am", "force-stop", pkg);
    page = await launch();
    await button("打开笔记").click();
    await button("路线.mind.json").click();
    await page.locator(".me-tpc").filter({ hasText: "调研" }).click();
    await button("备注").click();
    assert.equal(
      await page.getByLabel("备注", { exact: true }).inputValue(),
      "手机草稿",
    );
    adb('reverse',port,port);
    connected=true;
    adb('forward','--remove','tcp:'+forward);
    adb('shell','am','force-stop',pkg);
    page=await launch();
    if (await button('登录').isVisible()) {
      await page.getByLabel('服务地址').fill(origin);await page.getByLabel('邮箱').fill(email);await page.getByLabel('密码').fill(password);await button('登录').click();
    }
    await button('立即同步').click();await page.locator('#status').getByText(/上次同步/).waitFor();
    console.log(
      "Android WebView local Markdown and map editing, offline restart passed",
    );
  } finally {
    await device.close();
    if (forward) adb("forward", "--remove", "tcp:" + forward);
    if (connected) adb("reverse", "--remove", port);
  }
}
