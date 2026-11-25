import assert from "node:assert/strict";

export async function verifyAppearance(page) {
  const viewport = page.viewportSize();
  const document = page.locator(".mode-crepe");
  const editor = document.locator(".milkdown .ProseMirror");
  const paragraph = editor.locator(":scope > p").first();
  await paragraph.waitFor();
  const fontSize = (element) =>
    element.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const size = await fontSize(paragraph);
  const title = await fontSize(editor.locator("h1"));
  const subtitle = await fontSize(editor.locator("h2").first());
  assert.ok(
    title > subtitle && subtitle > size && title <= size * 2,
    `heading sizes: ${title}, ${subtitle}, body ${size}`,
  );
  await document.evaluate((el) => (el.dataset.markdownFontSize = "large"));
  assert.ok(
    (await fontSize(paragraph)) > size,
    "Crepe must respect the large text preference",
  );
  await document.evaluate((el) => (el.dataset.markdownFontSize = "medium"));
  async function checkTextInset() {
    const bounds = await document.boundingBox();
    const actual = (await paragraph.boundingBox()).x - bounds.x;
    const expected = Math.min(96, Math.max(40, bounds.width * 0.07));
    assert.ok(Math.abs(actual - expected) < 1, `editor width ${bounds.width}px: expected inset ${expected}px, got ${actual}px`);
  }
  async function checkBlockControls() {
    await paragraph.hover();
    const controls = document.locator('.milkdown-block-handle[data-show="true"] .operation-item');
    await controls.first().click({ trial: true });
    assert.equal(await controls.count(), 2);
    const left = (await document.boundingBox()).x;
    const textLeft = (await paragraph.boundingBox()).x;
    for (const item of await controls.all()) {
      const box = await item.boundingBox();
      assert.ok(box && box.x >= left && box.x + box.width <= textLeft, `block control ${box?.x} + ${box?.width} must fit between ${left} and ${textLeft}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  await checkTextInset();
  await checkBlockControls();
  await page.setViewportSize({ width: 1920, height: 940 });
  await checkTextInset();
  assert.equal((await editor.locator("h1").boundingBox()).x, (await paragraph.boundingBox()).x);
  await checkBlockControls();
  const desktopWidth = (await paragraph.boundingBox()).width;
  assert.ok(desktopWidth <= 800, `desktop text column width: ${desktopWidth}`);
  await page.evaluate(
    () => (window.document.documentElement.dataset.colorScheme = "dark"),
  );
  const surface = (el) => getComputedStyle(el).backgroundColor;
  assert.equal(
    await document.locator(".milkdown").evaluate(surface),
    await document.evaluate(surface),
    "dark canvas must match the document",
  );
  await page.evaluate(
    () => (window.document.documentElement.dataset.colorScheme = "light"),
  );
  if (process.env.WENOTE_CREPE_PREVIEW) {
    await page.mouse.move(0, 0);
    await document.screenshot({ path: process.env.WENOTE_CREPE_PREVIEW });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await checkTextInset();
  await checkBlockControls();
  const narrowWidth = (await document.boundingBox()).width;
  assert.ok(
    (await paragraph.boundingBox()).width >= narrowWidth - 82,
    "narrow screen writing area",
  );
  assert.ok(
    await document.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "horizontal overflow",
  );
  await page.setViewportSize(viewport);
}
