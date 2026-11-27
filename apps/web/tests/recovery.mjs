import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
let token;
async function post(path, body) {
  const response = await fetch(origin + "/api/v1/" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  assert(response.ok, await response.clone().text());
  return response.json();
}
const credentials = {
  email: `${randomUUID()}@test.invalid`,
  password: randomUUID(),
};
await post("auth/register", credentials);
token = (await post("auth/login", credentials)).access_token;
const vault = await post("vaults", { name: "Recovery" });
const note = await post(`vaults/${vault.id}/files`, {
  path: "recovery.txt",
  content: btoa("original"),
});
const browser = await chromium.launch({
  channel: process.env.CHROME_PATH ? undefined : "chrome",
  executablePath: process.env.CHROME_PATH,
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await page.goto(`${origin}/?vault=${vault.id}&note=${note.file_id}`);
  const editor = page.getByLabel("纯文本正文");
  await editor.fill("unsaved edits");
  const guarded = () =>
    page.evaluate(
      () =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
    );
  assert(await guarded());
  const button = (name) => page.getByRole("button", { name, exact: true });
  await button("更多操作").click();
  page.on("dialog", (d) => (d.type() === "prompt" ? d.dismiss() : d.accept()));
  await button("重命名").click();
  await page.getByRole("dialog", {name:"重命名"}).getByRole("button", {name:"取消"}).click();
  assert(await guarded(), "cancelled rename must keep unsaved protection");
  assert.equal(await editor.textContent(), "unsaved edits");
  const second = await page.context().newPage();
  await second.addInitScript(
    (t) => sessionStorage.setItem("wenote-session", t),
    token,
  );
  await second.goto(page.url());
  await second.getByLabel("纯文本正文").waitFor();
  assert.equal(
    await second.getByRole("dialog", { name: "恢复本地草稿" }).count(),
    0,
  );
  await second.close();
  const update = await fetch(
    `${origin}/api/v1/vaults/${vault.id}/files/${note.file_id}/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_version_id: note.version_id,
        content: btoa("new remote version"),
      }),
    },
  );
  assert(update.ok, await update.text());
  // A rejected save must leave both the input and its persisted draft usable.
  await button("保存").click();
  await page
    .getByRole("status")
    .filter({ hasText: "文件已有新版本" })
    .waitFor();
  assert.equal(await editor.textContent(), "unsaved edits");
  await page.reload();
  const recovery = page.getByRole("dialog", { name: "恢复本地草稿" });
  await recovery.getByText("new remote version", { exact: true }).waitFor();
  await recovery.getByText("unsaved edits", { exact: true }).waitFor();
  await recovery.getByRole("button", { name: "恢复到编辑器" }).click();
  await recovery.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.querySelector(".cm-content")?.textContent === "unsaved edits",
  );
  await button("保存").click();
  await button("已保存").waitFor();
  await page.reload();
  await editor.waitFor();
  assert.equal(await recovery.count(), 0);
} finally {
  await browser.close();
}
