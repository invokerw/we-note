import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
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
  await api(a.token, files, "POST", {
      path: "项目/记录.md",
      content: bytes(body),
  });
  const secret = randomBytes(32).toString("base64url");
  const {id} = await (await api(a.token, "/api/v1/share-links", "POST", {
    vault_id: a.vault, paths: ["项目/记录.md"], token_hash: createHash("sha256").update(secret).digest("hex"),
    password: "phase5-link", max_downloads: 1, expires: Math.floor(Date.now()/1000) + 3600,
    allow_import: true, allow_download: true,
  })).json();
  const link = `${origin}/#share=${id}.${secret}`;
  await b.page.goto(link);
  await b.page.getByLabel("分享密码", {exact:true}).fill("phase5-link");
  await button(b.page, "打开分享").click();
  await b.page.getByText(body, { exact: true }).waitFor();
  assert.equal(new URL(b.page.url()).hash, "");
  const otherVault = await (await api(b.token, "/api/v1/vaults", "POST", {name:"备用库"})).json();
  await api(b.token, `/api/v1/vaults/${otherVault.id}/files`, "POST", {
    path:"收集/.wenote-folder.json", content: bytes('{"wenote":"folder","version":1}'),
  });
  await button(b.page, "保存到我的笔记").click();
  const destination = b.page.getByRole("dialog", {name:"保存到我的笔记"});
  await button(destination, "备用库").click();
  await button(destination, "收集").click();
  await destination.getByText("备用库 / 收集", {exact:true}).waitFor();
  await button(destination, "接收库").click();
  await destination.getByText("接收库", {exact:true}).and(destination.locator("strong")).waitFor();
  await button(b.page, "确认保存").click();
  await b.page.getByText("已保存到我的笔记").waitFor();
  await b.page.reload();
  await b.page.getByText("分享链接已失效").waitFor();
  const copyAssets = await (
    await api(b.token, `/api/v1/vaults/${b.vault}/assets`)
  ).json();
  assert.equal(copyAssets.length, 1);
  // The same document name in two notebooks must remain distinguishable.
  for (const [vault, days] of [[b.vault, 0], [otherVault.id, 1]]) {
    await api(b.token, `/api/v1/vaults/${vault}/files`, "POST", {path: "共享.md", content: bytes("正文")});
    await api(b.token, "/api/v1/share-links", "POST", {
      vault_id: vault, paths: ["共享.md"], duration_days: days,
      token_hash: createHash("sha256").update(randomBytes(32)).digest("hex"),
    });
  }
  await b.page.clock.install();
  await b.page.goto(origin);
  await button(b.page, "打开个人设置").click();
  await button(b.page, "我的分享").click();
  const groups = b.page.locator(".share-list section");
  const permanent = groups.filter({has: b.page.getByRole("heading", {name: "接收库", exact: true})});
  const temporary = groups.filter({has: b.page.getByRole("heading", {name: "备用库", exact: true})});
  await permanent.getByText("共享.md", {exact: true}).waitFor();
  await temporary.getByText("共享.md", {exact: true}).waitFor();
  await b.page.clock.fastForward(86_401_000);
  await temporary.waitFor({state: "detached"});
  await permanent.getByText("永久有效", {exact: true}).waitFor();
  const p = a.page;
  await button(p,"打开个人设置").click();
  await p.getByText("账户活动",{exact:true}).click();
  await p.getByRole("heading",{name:"账户审计日志"}).waitFor();
  await button(p,"关闭个人设置").click();
  for (const name of ["笔记库菜单", "加密笔记库", "批量分享"]) assert.equal(await p.getByLabel(name).count(), 0);
  console.log("通过单篇分享、密码、附件复制、次数限制及账户活动验收。");
} finally {
  await browser.close();
}
