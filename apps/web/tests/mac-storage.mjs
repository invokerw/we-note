// Drive the production bundle with deterministic native dialog and sync replies.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.route("https://storage.test/**", (route) =>
    route.fulfill({
      path: fileURLToPath(
        new URL(
          "../../client/dist/" +
            (new URL(route.request().url()).pathname.slice(1) || "index.html"),
          import.meta.url,
        ),
      ),
    }),
  );
  await page.addInitScript(() => {
    const books = {
      alice: [
        { id: "one", name: "工作" },
        { id: "two", name: "生活" },
      ],
      bob: [],
    };
    Object.defineProperty(navigator, "onLine", {get: () => !sessionStorage.getItem("offline")});
    window.log = [];
    let who;
    window.__TAURI__ = {
      core: {
        invoke: async (command, args = {}) => {
          window.log.push([command, args]);
          switch (command) {
            case "mac_storage_available":
              return true;
            case "login":
              who = args.email.split("@")[0];
              return {
                owner: who,
                token: "session",
                refresh: "renewal",
                expires: new Date(Date.now() + 3600000).toISOString(),
                vaults: books[who],
              };
            case "refresh":
              who = JSON.parse(
                localStorage.getItem("mac-active-account"),
              ).owner;
              return {
                access_token: "session",
                refresh_token: "next",
                expires_at: new Date(Date.now() + 3600000).toISOString(),
              };
            case "choose_storage":
              return "/Documents";
            case "account_location": {
              const key = `location:${args.owner}`;
              if (args.path && !args.separate)
                throw Error("所选文件夹已有文件");
              if (args.separate)
                localStorage.setItem(key, `${args.path}/${args.owner}`);
              if (!localStorage.getItem(key)) throw Error("请选择位置");
              return localStorage.getItem(key);
            }
            case "account_vaults":
              if (args.create) {
                const v = { id: "three", name: args.create };
                books[who].push(v);
                return v;
              }
              return { vaults: books[who] };
            case "sync":
              if (args.vault === "two" && !sessionStorage.getItem("failed")) {
                sessionStorage.setItem("failed", "yes");
                throw Error("网络中断");
              }
              return { device_id: "local" };
            case "notebook":
              return args.operation.operation === "me"
                ? { email: `${who}@test.com` }
                : {};
            default:
              return null;
          }
        },
      },
    };
  });
  await page.goto("https://storage.test");
  async function login(user) {
    await page.getByRole("heading", { name: "登录 WeNote" }).waitFor();
    await page.getByLabel("邮箱").fill(`${user}@test.com`);
    await page.getByLabel("密码").fill("testpassword");
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  async function choose() {
    await page.getByRole("heading", { name: "选择笔记库存储位置" }).waitFor();
    await page.getByRole("button", { name: "选择文件夹…" }).click();
    await page.getByText("在所选位置新建专用文件夹").click();
  }
  async function logout() {
    await page
      .getByRole("button", { name: "打开个人设置", exact: true })
      .click();
    await page.getByRole("button", { name: /退出(登录|账户|账号)/ }).click();
  }
  await login("alice");
  await choose();
  await page
    .locator("#status")
    .filter({ hasText: "生活：Error: 网络中断" })
    .waitFor();
  await page.getByText("重试未完成的笔记库").click();
  const select = page.getByLabel("切换笔记库");
  await select.selectOption("two");
  assert.deepEqual(
    await page.evaluate(() =>
      window.log
        .filter(([cmd]) => cmd === "sync")
        .map(([, args]) => args.vault),
    ),
    ["one", "two", "two"],
  );
  await page.evaluate(() => sessionStorage.setItem("offline", "1"));
  await page.reload();
  await select.waitFor();
  assert.equal(await select.inputValue(), "two");
  assert.equal(await page.evaluate(() => window.log.some(([cmd]) => cmd === "sync")), false);
  await page.evaluate(() => sessionStorage.removeItem("offline"));
  await logout();
  await login("alice");
  await select.waitFor();
  assert.equal(await select.inputValue(), "two");
  assert.equal(
    await page.evaluate(
      () => window.log.filter(([cmd]) => cmd === "choose_storage").length,
    ),
    0,
  );
  await logout();
  await login("bob");
  await choose();
  await page.getByRole("button", { name: "创建第一个笔记库" }).click();
  await select.waitFor();
  assert.deepEqual(await select.locator("option").allTextContents(), [
    "我的笔记",
  ]);
  console.log(
    "PASS macOS setup, retry, automatic editor, vault switching, restore, relogin and empty second account",
  );
} finally {
  await browser.close();
}
