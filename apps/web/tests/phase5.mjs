import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { chromium } from "playwright-core";
const origin = process.env.WENOTE_TEST_ORIGIN;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  channel: process.env.CHROME_PATH ? undefined : "chrome",
});
try {
  async function api(token, path, method = "GET", body, want) {
    const res = await fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(
      want ? res.status === want : res.ok,
      `${path} ${res.status} ${await res.clone().text()}`,
    );
    return res;
  }
  async function account(name) {
    const credentials = {
      email: randomUUID() + "@example.invalid",
      password: "phase5-account",
    };
    await api("", "/api/v1/auth/register", "POST", credentials);
    const { access_token: token } = await (
      await api("", "/api/v1/auth/login", "POST", credentials)
    ).json();
    const { id: vault } = await (
      await api(token, "/api/v1/vaults", "POST", { name })
    ).json();
    const page = await browser.newPage();
    await page.goto(origin);
    await page.getByLabel("邮箱").fill(credentials.email);
    await page.getByLabel("密码", { exact: true }).fill(credentials.password);
    await button(page, "登录").click();
    return { page, token, vault, email: credentials.email };
  }
  const button = (p, name) => p.getByRole("button", { name, exact: true });
  const a = await account("发送库"),
    b = await account("接收库");
  const files = `/api/v1/vaults/${a.vault}/files`,
    dest = `/api/v1/vaults/${b.vault}/files`;
  const draft = await (await api(a.token, files, "POST", { path:"上传.md", content:"" })).json();
  async function upload(name) {
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOmSuJkAAAAASUVORK5CYII=", "base64");
    const p = `/api/v1/vaults/${a.vault}/assets`;
    const asset = await (
      await api(a.token, p + "/uploads", "POST", {
        file_id: draft.file_id, name,
        media_type: "image/png",
        content_size: data.length,
        content_hash:
          "sha256:" + createHash("sha256").update(data).digest("hex"),
      })
    ).json();
    assert.ok(
      (
        await fetch(origin + p + "/" + asset.asset_id + "/complete", {
          method: "POST",
          body: data,
          headers: { Authorization: "Bearer " + a.token },
        })
      ).ok,
    );
    return asset;
  }
  const asset = await upload("说明.png");

  const bytes = (s) => Buffer.from(s).toString("base64");
  const body = "初稿 " + asset.canonical_url;
  const file = await (
    await api(a.token, files, "POST", {
      path: "项目/记录.md",
      content: bytes(body),
    })
  ).json();
  await a.page.getByLabel("笔记库菜单").click();
  await button(a.page, "批量分享").click();
  await a.page.getByLabel("文件或目录，每行一个").fill("项目/");

  await a.page.getByLabel("分享密码（可选）").fill("phase5-link");
  await a.page.getByLabel("下载和导入次数上限（0 为不限）").fill("1");
  await a.page.getByLabel("允许导入笔记库").check();
  await button(a.page, "生成分享链接").click();
  const link = await a.page.getByLabel("复制分享地址").inputValue();
  await b.page.goto(link);
  await b.page.getByLabel("分享密码", {exact:true}).fill("phase5-link");
  await button(b.page, "打开分享").click();
  await b.page.getByText(body, { exact: true }).waitFor();
  assert.equal(new URL(b.page.url()).hash, "");
  await button(b.page, "保存到我的笔记").click();
  await b.page.getByLabel("目标目录").fill("链接");
  await button(b.page, "确认保存").click();
  await b.page.getByText("已保存到我的笔记").waitFor();
  await b.page.reload();
  await b.page.getByText("分享链接已失效").waitFor();
  const copyAssets = await (
    await api(b.token, `/api/v1/vaults/${b.vault}/assets`)
  ).json();
  assert.equal(copyAssets.length, 1);
  const p = a.page;
  await button(p,"打开个人设置").click();
  await p.getByText("账户活动",{exact:true}).click();
  await p.getByRole("heading",{name:"账户审计日志"}).waitFor();
  await button(p,"关闭个人设置").click();
  await p.getByLabel("笔记库菜单").click();
  await button(p, "加密笔记库").click();
  await button(p, "新建加密笔记库").click();
  const key = await p.getByLabel("恢复密钥", { exact: true }).inputValue();
  await p.getByLabel("我已保存恢复密钥").check();
  p.once("dialog", (d) => d.accept("私人日记.md"));
  await button(p, "新建加密笔记").click();
  await p.getByLabel("加密笔记正文").fill("只在本机解密的内容");
  // Reserve the first candidate for another owner before the browser saves it.
  let occupied;
  await p.route("**/api/v1/encrypted-vaults/*", async (route) => {
    occupied = route.request().url().split("/").at(-1);
    await api(b.token, "/api/v1/encrypted-vaults/" + occupied, "PUT", route.request().postDataJSON(), 200);
    await route.continue();
  }, { times: 1 });
  const saved = p.waitForRequest(
    (r) => occupied && r.method() === "PUT" && r.url().includes("/encrypted-vaults/") && !r.url().endsWith("/" + occupied),
  );
  await button(p, "加密并保存").click();
  await p.getByText("加密库已保存").waitFor();
  const req = await saved;
  const sealed = req.postData();
  for (const secret of [key, "私人日记", "只在本机解密"])
    assert.ok(!sealed.includes(secret));
  const cid = req.url().split("/").at(-1);
  assert.match(cid, /^[0-9abcdefghjkmnpqrstvwxyz]{8}$/u);
  await api(b.token, "/api/v1/encrypted-vaults/" + cid, "GET", undefined, 404);
  await button(p, "锁定笔记库").click();
  await p.getByLabel("选择加密库").selectOption(cid);
  await p
    .getByLabel("恢复密钥", { exact: true })
    .fill(Buffer.alloc(32, 7).toString("base64"));
  await button(p, "解锁笔记库").click();
  await p.getByText(/解锁失败/).waitFor();
  await p.getByLabel("恢复密钥", { exact: true }).fill(key);
  await button(p, "解锁笔记库").click();
  assert.equal(
    await p.getByLabel("加密笔记正文").inputValue(),
    "只在本机解密的内容",
  );
  console.log(
    "Phase 5 browser acceptance passed shared links, batch assets, audit and encrypted vaults.",
  );
} finally {
  await browser.close();
}
