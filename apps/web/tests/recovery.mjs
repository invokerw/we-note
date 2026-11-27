import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";

const origin = process.env.WENOTE_TEST_ORIGIN;
let token;
async function post(path, body) {
  const response = await fetch(origin + "/api/v1/" + path, { method: "POST",
    headers: {"Content-Type": "application/json", ...(token && {Authorization: `Bearer ${token}`})}, body: JSON.stringify(body) });
  assert(response.ok, await response.clone().text());
  return response.json();
}
const credentials = {email: `${randomUUID()}@test.invalid`, password: randomUUID()};
await post("auth/register", credentials);
token = (await post("auth/login", credentials)).access_token;
const vault = await post("vaults", {name: "Recovery"});
const note = await post(`vaults/${vault.id}/files`, {path:"recovery.txt", content:btoa("original")});
const browser = await chromium.launch({channel: process.env.CHROME_PATH ? undefined : "chrome", executablePath: process.env.CHROME_PATH});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(t => sessionStorage.setItem("wenote-session", t), token);
  await page.goto(`${origin}/?vault=${vault.id}&note=${note.file_id}`);
  const editor = page.getByLabel("纯文本正文");
  await editor.fill("unsaved edits");
  const guarded = () => page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", {cancelable:true})));
  assert(await guarded());
  const button = name => page.getByRole("button", {name, exact:true});
  await button("更多操作").click();
  page.on("dialog", d => d.type() === "confirm" ? d.accept() : d.dismiss());
  await button("移动或重命名").click();
  assert(await guarded(), "cancelled rename must keep unsaved protection");
  assert.equal(await editor.textContent(), "unsaved edits");
} finally { await browser.close(); }
