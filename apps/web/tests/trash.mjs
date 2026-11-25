import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
if (!origin) throw Error("Set WENOTE_TEST_ORIGIN to a disposable server");
let token;
async function api(path, method = "GET", body) {
  const response = await fetch(origin + "/api/v1/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
      ...(token && { Authorization: "Bearer " + token }),
    },
    body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  if (response.status !== 204) return response.json();
}
const account = {
  email: randomUUID() + "@example.invalid",
  password: "trash-browser-test",
};
await api("auth/register", "POST", account);
token = (await api("auth/login", "POST", account)).access_token;
const base =
  "vaults/" + (await api("vaults", "POST", { name: "回收站验收" })).id;
const make = (path) =>
  api(base + "/files", "POST", {
    path,
    content: Buffer.from("# 删除前的内容\n\n- [ ] 待办").toString("base64"),
  });
const separate = await make("工作/单篇.md");
await api(`${base}/files/${separate.file_id}`, "DELETE", {
  base_version_id: separate.version_id,
});
async function deleteFolder() {
  const { files } = await api(base + "/files");
  const expected = Object.fromEntries(
    files
      .filter(
        (f) => f.path.startsWith("工作/") && f.file_id !== separate.file_id,
      )
      .map((f) => [f.path, f.current_version_id]),
  );
  await api(base + "/entry", "POST", {
    operation: "delete",
    source: "工作/",
    expected,
  });
}
await make("工作/资料/一.md");
await make("工作/二.md");
await deleteFolder();
const chrome = await chromium.launch({ channel: "chrome" });
try {
  const page = await chrome.newPage();
  page.setDefaultTimeout(6000);
  await page.addInitScript(
    (s) => sessionStorage.setItem("wenote-session", s),
    token,
  );
  await page.goto(origin);
  const button = (scope, name) =>
    scope.getByRole("button", { name, exact: true });
  const list = page.locator(".note-list-pane");
  const note = button(list, "单篇.md"),
    folder = button(list, "工作");
  const menu = (name) => page.getByRole("menuitem", { name, exact: true });
  await button(page, "回收站").click();
  await note.click();
  const preview = page.locator("main .trash-document");
  await preview.getByRole("heading", { name: "删除前的内容" }).waitFor();
  assert.equal(
    await preview.locator("[contenteditable=true],textarea").count(),
    0,
  );
  assert.ok(await preview.getByRole("checkbox").isDisabled());
  await button(preview, "恢复").waitFor();
  await button(preview, "永久删除").waitFor();
  await folder.click();
  assert.equal(await page.locator("main").innerText(), "");
  await folder.click({ button: "right" });
  await menu("永久删除").waitFor();
  await menu("恢复").click();
  await folder.waitFor({ state: "detached" });
  assert.deepEqual(
    (await api(base + "/files")).files.map((f) => f.path).sort(),
    ["工作/二.md", "工作/资料/一.md"],
  );
  await deleteFolder();
  await button(page, "回收站").click();
  await folder.click({ button: "right" });
  page.once("dialog", (d) => d.accept());
  await menu("永久删除").click();
  await folder.waitFor({ state: "detached" });
  await note.click({ button: "right" });
  await menu("恢复").waitFor();
  page.once("dialog", (d) => d.dismiss());
  await menu("永久删除").click();
  await note.click();
  page.once("dialog", (d) => d.accept());
  await button(preview, "永久删除").click();
  await list.getByText("回收站为空。").waitFor();
  assert.equal((await api(base + "/trash")).items.length, 0);
  // Both restore controls choose the destination at the time of the click.
  const dialogs = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  for (const [path, expected, fromMenu] of [
    ["资料/存在/笔记.md", "资料/存在/笔记.md", false],
    ["资料/旧/笔记.md", "笔记.md", true],
  ]) {
    const target = await make(path);
    await api(`${base}/files/${target.file_id}`, "DELETE", {
      base_version_id: target.version_id,
    });
    await make(fromMenu ? "资料/旧版/保留.md" : "资料/存在/保留.md");
    await button(page, "回收站").click();
    const row = button(list, "笔记.md");
    if (fromMenu) {
      await row.click({ button: "right" });
      await menu("恢复").click();
    } else {
      await row.click();
      await button(preview, "恢复").click();
    }
    await row.waitFor({ state: "detached" });
    const { files } = await api(base + "/files");
    assert.equal(files.find((f) => f.file_id === target.file_id)?.path, expected);
  }
  const conflict = await make("不存在/笔记.md");
  await api(`${base}/files/${conflict.file_id}`, "DELETE", {
    base_version_id: conflict.version_id,
  });
  await button(page, "回收站").click();
  await button(list, "笔记.md").click();
  const restore = page.waitForResponse((r) =>
    r.url().endsWith(`/files/${conflict.file_id}/restore`),
  );
  await button(preview, "恢复").click();
  assert.equal((await restore).status(), 409);
  assert.ok((await api(base + "/trash")).items.some((i) => i.id === conflict.file_id));
  assert.deepEqual(dialogs, []);
  console.log(
    "通过回收站笔记只读预览、目录留白、按批恢复与永久删除、单篇一键恢复、同名冲突验收。",
  );
} finally {
  await chrome.close();
}
