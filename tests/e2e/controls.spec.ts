import { expect, test } from '@playwright/test';
import { convertAndDownload, decodeInBrowser, decodePngNode, fixture, openApp, pickFixture } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('quality slider only appears for lossy targets', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  const target = page.getByTestId('target');
  const q = page.getByTestId('quality-field');
  await target.selectOption('png');
  await expect(q).toBeHidden();
  await target.selectOption('webp-lossless');
  await expect(q).toBeHidden();
  await target.selectOption('webp-lossy');
  await expect(q).toBeVisible();
  await target.selectOption('jpeg');
  await expect(q).toBeVisible();
  await page.getByTestId('quality').fill('35');
  await expect(page.getByTestId('quality-value')).toHaveText('35');
});

test('lossless-only disables lossy targets and moves the selection off them', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  const target = page.getByTestId('target');
  await target.selectOption('jpeg');
  await page.getByTestId('lossless-only').check();
  await expect(target.locator('option[value="jpeg"]')).toBeDisabled();
  await expect(target.locator('option[value="webp-lossy"]')).toBeDisabled();
  await expect(target.locator('option[value="png"]')).toBeEnabled();
  await expect(target.locator('option[value="webp-lossless"]')).toBeEnabled();
  await expect(target).toHaveValue('png');
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('lossless-only with a semi-transparent PNG: no target survives, convert is blocked, reason shown', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await expect(page.locator('[data-fact="alpha"]')).toContainText('semi-transparent');
  await expect(page.locator('[data-loss="premultiplied-alpha"]')).toBeVisible();
  await expect(page.locator('[data-loss="transparent-color"]')).toHaveAttribute('data-severity', 'hidden');
  await page.getByTestId('lossless-only').check();
  const target = page.getByTestId('target');
  for (const v of ['png', 'webp-lossless', 'webp-lossy', 'jpeg']) {
    await expect(target.locator(`option[value="${v}"]`)).toBeDisabled();
  }
  await expect(page.getByTestId('no-target')).toBeVisible();
  await expect(page.getByTestId('convert')).toBeDisabled();
  await page.getByTestId('lossless-only').uncheck();
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('lossless-only with a 16-bit PNG blocks every target (canvas truncates to 8-bit)', async ({ page }) => {
  await pickFixture(page, 'rgb16.png');
  await page.getByTestId('lossless-only').check();
  await expect(page.getByTestId('target').locator('option[value="png"]')).toBeDisabled();
  await expect(page.getByTestId('convert')).toBeDisabled();
});

test('RGBA -> JPEG requires a flatten colour (default white), says alpha is lost, and honours the chosen colour', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  const bgField = page.getByTestId('background-field');
  await expect(bgField).toBeHidden();
  await page.getByTestId('target').selectOption('jpeg');
  await expect(bgField).toBeVisible();
  await expect(page.getByTestId('background')).toHaveValue('#ffffff');
  await expect(bgField).toContainText('alpha channel will be lost');
  const alphaLoss = page.locator('[data-loss="alpha"]');
  await expect(alphaLoss).toBeVisible();
  await expect(alphaLoss).toContainText('background colour');

  await page.getByTestId('background').fill('#ff0000');
  await expect(page.getByTestId('background-hex')).toHaveText('#ff0000');
  await page.getByTestId('quality').fill('100');

  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.jpg');
  const out = await decodeInBrowser(page, bytes, 'image/jpeg');
  const src = decodePngNode(fixture('rgba-partial.png'));
  expect(out.width).toBe(src.width);
  // Rows 24..35 of the fixture are fully transparent: they must be red, not black.
  for (let y = 24; y < 36; y += 4) {
    for (let x = 4; x < out.width; x += 12) {
      const i = (y * out.width + x) * 4;
      expect(out.data[i], `r at ${x},${y}`).toBeGreaterThan(200);
      expect(out.data[i + 1], `g at ${x},${y}`).toBeLessThan(60);
      expect(out.data[i + 2], `b at ${x},${y}`).toBeLessThan(60);
    }
  }
  // Opaque rows keep their original colours within JPEG-at-100 tolerance.
  for (let y = 0; y < 12; y += 4) {
    for (let x = 4; x < out.width; x += 12) {
      const i = (y * out.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        expect(Math.abs(out.data[i + c]! - src.data[i + c]!), `ch${c} at ${x},${y}`).toBeLessThan(24);
      }
    }
  }
});

test('RGBA -> WebP lossless keeps alpha; only hidden + premultiplied losses listed', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await page.getByTestId('target').selectOption('webp-lossless');
  await expect(page.getByTestId('background-field')).toBeHidden();
  await expect(page.locator('[data-loss="alpha"]')).toHaveCount(0);
  await expect(page.locator('[data-loss="pixels-lossy"]')).toHaveCount(0);
  const { bytes } = await convertAndDownload(page);
  const out = await decodeInBrowser(page, bytes, 'image/webp');
  const src = decodePngNode(fixture('rgba-partial.png'));
  for (let i = 3; i < src.data.length; i += 4) {
    if (out.data[i] !== src.data[i]) throw new Error(`alpha differs at byte ${i}`);
  }
});

test('an unsupported file shows an error and no source panel', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('definitely not an image'),
  });
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('error')).toContainText('PNG, JPEG and WebP');
  await expect(page.getByTestId('source-facts')).toHaveCount(0);
});
