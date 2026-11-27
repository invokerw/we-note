export function assistantUI(page) {
  const button = (name) => page.getByRole("button", { name, exact: true });
  return {
    async settings() {
      if (await button("展开笔记助手").isVisible())
        await button("展开笔记助手").click();
      await button("模型设置").click();
      await page.locator("#assistant-url:enabled").waitFor();
    },
    async save() {
      await button("保存模型设置").click();
      await page
        .getByRole("dialog", { name: "模型设置" })
        .waitFor({ state: "hidden" });
    },
    async manual(id) {
      await button("选择聊天模型").click();
      await page.getByLabel("模型 ID", { exact: true }).fill(id);
      await button("选用").click();
    },
    async test() {
      await button("选择聊天模型").click();
      await button("测试连接").click();
    },
    async protocol(name) {
      await page.getByText("高级设置", { exact: true }).click();
      await page.getByLabel("接口协议").click();
      await page.getByText(name, { exact: true }).last().click();
    },
  };
}
