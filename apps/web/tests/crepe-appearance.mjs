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
  await page.setViewportSize({ width: 1680, height: 940 });
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
    await editor.screenshot({ path: process.env.WENOTE_CREPE_PREVIEW });
  }
  await page.setViewportSize({ width: 390, height: 844 });
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
