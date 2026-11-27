// Exercise the bundled native UI. The two-device Rust test covers the real IPC operations' backend.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  executablePath: process.env.CHROME_PATH,
});
try {
  for (const phone of [false, true]) {
    const page = await browser.newPage({
      viewport: { width: phone ? 390 : 1280, height: 800 },
    });
    page.setDefaultTimeout(6000);
    await page.route("http://native.test/**", (route) => {
      const path =
        new URL(route.request().url()).pathname.slice(1) || "index.html";
      return route.fulfill({
        path: fileURLToPath(
          new URL("../../client/dist/" + path, import.meta.url),
        ),
      });
    });
    await page.addInitScript((phone) => {
      let pending = true;
      window.__TAURI__ = {
        app: { onBackButtonPress: async () => ({ unregister() {} }) },
        core: {
          invoke: async (command, args) => {
            if (command === "is_android") return phone;
            if (command === "recent_notebook")
              return { vault: "vault", origin: "http://native.test" };
            // A restored native session can outlive the WebView account cache.
            if (phone && command === "mobile_control" && args.action === "restore")
              return { vault: "vault", name: "离线库", origin: "http://native.test", token: "test", generation: "previous-binding" };
            if (command !== "notebook") return null;
            switch (args.operation.action) {
              case "library":
                return {};
              case "conflicts":
                return pending ? { "copy.md": "note.md" } : {};
              case "conflict_preview":
                return {
                  target: "note.md",
                  local: "local copy",
                  remote: "remote copy",
                  remote_hash: "r",
                  local_hash: "l",
                };
              case "resolve_conflict":
                window.submitted = args.operation;
                pending = false;
                return null;
              default:
                return {};
            }
          },
        },
      };
    }, phone);
    await page.goto("http://native.test");
    await page.locator("#open-editor").click();
    if (phone) {
      await page.getByRole("button", {name:"打开个人设置", exact:true}).click();
      await page.getByRole("button", {name:"MCP 连接", exact:true}).click();
      await page.getByLabel("允许新建、修改和移入回收站").waitFor();
      await page.getByRole("button", {name:"关闭个人设置", exact:true}).click();
    }
    if (phone)
      await page
        .getByRole("button", { name: "打开笔记库目录", exact: true })
        .click();
    await page.getByRole("button", { name: "同步冲突", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "同步冲突" });
    await dialog.getByRole("button", { name: "note.md · copy.md" }).click();
    if (phone) {
      await dialog.getByRole("button", { name: "原笔记", exact: true }).click();
      assert(!(await dialog.locator("section[data-side=local]").isVisible()));
    }
    await dialog.getByLabel("合并正文").fill("combined");
    await dialog.getByRole("button", { name: "保存合并结果" }).click();
    await dialog.getByText("没有待处理冲突。").waitFor();
    assert.deepEqual(await page.evaluate(() => window.submitted), {
      action: "resolve_conflict",
      copy: "copy.md",
      choice: "merged",
      remote_hash: "r",
      local_hash: "l",
      text: "combined",
    });
    await page.close();
  }
} finally {
  await browser.close();
}
