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
  async function upload(name) {
    const data = Buffer.from(name);
    const p = `/api/v1/vaults/${a.vault}/assets`;
    const asset = await (
      await api(a.token, p + "/uploads", "POST", {
        name,
        media_type: "application/octet-stream",
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
  const asset = await upload("说明.bin");
  await upload("独立.bin");
  const bytes = (s) => Buffer.from(s).toString("base64");
  const body = "初稿 " + asset.canonical_url;
  const file = await (
    await api(a.token, files, "POST", {
      path: "项目/记录.md",
      content: bytes(body),
    })
  ).json();
  await button(a.page, "分享管理").click();
  await a.page.getByLabel("文件或目录，每行一个").fill("项目/");
  await a.page.getByLabel("独立.bin").check();
  await a.page.getByLabel("分享密码（可选）").fill("phase5-link");
  await a.page.getByLabel("下载和导入次数上限（0 为不限）").fill("1");
  await a.page.getByLabel("允许导入笔记库").check();
  await button(a.page, "生成分享链接").click();
  const link = await a.page.getByLabel("复制分享地址").inputValue();
  await b.page.goto(link);
  await b.page.getByLabel("分享密码（如有）").fill("phase5-link");
  await button(b.page, "打开分享").click();
  await button(b.page, "预览文本").click();
  await b.page.getByText(body, { exact: true }).waitFor();
  assert.equal(new URL(b.page.url()).hash, "");
  await b.page.getByLabel("目标目录").fill("链接");
  await button(b.page, "导入到我的笔记库").click();
  await b.page.getByText("快照已导入").waitFor();
  await b.page.reload();
  await b.page.getByText("请使用发送者提供的完整链接打开分享。").waitFor();
  const copyAssets = await (
    await api(b.token, `/api/v1/vaults/${b.vault}/assets`)
  ).json();
  assert.equal(copyAssets.length, 2);
  await a.page.getByLabel("分享方式").selectOption("account");
  await a.page.getByLabel("接收者邮箱").fill(b.email);
  await button(a.page, "发送到收件箱").click();
  await a.page.getByText("快照已发送").waitFor();
  await b.page.goto(origin);
  await button(b.page, "收件箱").click();
  b.page.once("dialog", (d) => d.accept("账户"));
  await button(b.page, "导入快照").click();
  await button(b.page, "查看来源与更新").click();
  await b.page.getByText("已是发布版本").waitFor();
  const imported = (await (await api(b.token, dest)).json()).files.find(
    (v) => v.path === "账户/项目/记录.md",
  );
  const update = (token, path, base, text) =>
    api(token, path + "/content", "PUT", {
      base_version_id: base,
      content: bytes(text),
    });
  await update(
    b.token,
    dest + "/" + imported.file_id,
    imported.current_version_id,
    "接收者草稿",
  );
  await update(
    a.token,
    files + "/" + file.file_id,
    file.version_id,
    "来源第二版 " + asset.canonical_url,
  );
  await button(a.page, "已发送").click();
  await button(a.page, "发布来源更新").click();
  await a.page.getByText("已发布当前文件版本").waitFor();
  await button(b.page, "查看来源与更新").click();
  await button(b.page, "对比版本").click();
  await b.page.getByText("接收者草稿", { exact: true }).waitFor();
  await b.page
    .getByText("来源第二版 " + asset.canonical_url, { exact: true })
    .waitFor();
  const newLocal = await (
    await api(b.token, dest + "/" + imported.file_id)
  ).json();
  await update(
    b.token,
    dest + "/" + imported.file_id,
    newLocal.current_version_id,
    "期间保存",
  );
  await button(b.page, "采用来源版本").click();
  await b.page.getByText(/版本已变化/).waitFor();
  await button(b.page, "查看来源与更新").click();
  await button(b.page, "对比版本").click();
  await b.page.getByText("期间保存", { exact: true }).waitFor();
  await button(b.page, "采用来源版本").click();
  await b.page.getByText("副本已更新").waitFor();
  const result = await (
    await api(b.token, dest + "/" + imported.file_id + "/content")
  ).text();
  assert.ok(result.startsWith("来源第二版 "));
  assert.ok(!result.includes(asset.asset_id));
  assert.equal(
    (await (await api(b.token, `/api/v1/vaults/${b.vault}/assets`)).json())
      .length,
    4,
  );
  await button(a.page, "审计日志").click();
  await a.page
    .getByRole("cell", { name: "share.publish", exact: true })
    .waitFor();
  const p = a.page;
  await button(p, "加密笔记库").click();
  await button(p, "新建加密笔记库").click();
  const key = await p.getByLabel("恢复密钥", { exact: true }).inputValue();
  await p.getByLabel("我已保存恢复密钥").check();
  p.once("dialog", (d) => d.accept("私人日记.md"));
  await button(p, "新建加密笔记").click();
  await p.getByLabel("加密笔记正文").fill("只在本机解密的内容");
  const saved = p.waitForRequest(
    (r) => r.method() === "PUT" && r.url().includes("/encrypted-vaults/"),
  );
  await button(p, "加密并保存").click();
  await p.getByText("加密库已保存").waitFor();
  const req = await saved;
  const sealed = req.postData();
  for (const secret of [key, "私人日记", "只在本机解密"])
    assert.ok(!sealed.includes(secret));
  const cid = req.url().split("/").at(-1);
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
    "Phase 5 browser acceptance passed shared links, batch assets, copy conflicts, audit and encrypted vaults.",
  );
} finally {
  await browser.close();
}
