import { expect, test } from '@playwright/test';
import { convertAndDownload, decodeInBrowser, decodePngNode, fixture, openApp, pickFixture, selectTarget } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('quality slider only appears for lossy targets', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  const q = page.getByTestId('quality-field');
  await selectTarget(page, 'png');
  await expect(q).toBeHidden();
  await selectTarget(page, 'webp-lossless');
  await expect(q).toBeHidden();
  await selectTarget(page, 'webp-lossy');
  await expect(q).toBeVisible();
  await selectTarget(page, 'jpeg');
  await expect(q).toBeVisible();
  await page.getByTestId('quality').fill('35');
  await expect(page.getByTestId('quality-value')).toHaveText('35');
});

test('unprobed targets are selectable and get verified on selection', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  const opt = page.getByTestId('target').locator('option[value="avif-lossless"]');
  await expect(opt).toHaveText(/select to verify/);
  await selectTarget(page, 'avif-lossless');
  await expect(opt).toHaveText('AVIF (lossless)');
  await expect(page.getByTestId('target-note')).toContainText('wasm-avif');
});

test('lossless-only disables lossy targets and moves the selection off them', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jxl-lossless'); // probes JXL: its lossless claim fails in Chromium
  await selectTarget(page, 'jpeg');
  await page.getByTestId('lossless-only').check();
  const target = page.getByTestId('target');
  await expect(target.locator('option[value="jpeg"]')).toBeDisabled();
  await expect(target.locator('option[value="webp-lossy"]')).toBeDisabled();
  await expect(target.locator('option[value="jxl-lossless"]')).toBeDisabled();
  await expect(target.locator('option[value="png"]')).toBeEnabled();
  await expect(target).toHaveValue('png');
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('lossless-only with a semi-transparent PNG: PNG and WebP lossless are ALLOWED (exact alpha verified)', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await expect(page.locator('[data-fact="alpha"]')).toContainText('semi-transparent');
  await expect(page.locator('[data-fact="decoder"]')).toContainText('exact alpha');
  await selectTarget(page, 'webp-lossless');
  await page.getByTestId('lossless-only').check();
  const target = page.getByTestId('target');
  await expect(target.locator('option[value="png"]')).toBeEnabled();
  await expect(target.locator('option[value="webp-lossless"]')).toBeEnabled();
  await expect(target.locator('option[value="jpeg"]')).toBeDisabled();
  await expect(page.locator('[data-loss="transparent-color"]')).toHaveCount(0);
  await expect(page.locator('[data-loss="premultiplied-alpha"]')).toHaveCount(0);
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('lossless-only with a 16-bit PNG allows PNG (16-bit encoder) and excludes WebP (8-bit)', async ({ page }) => {
  await pickFixture(page, 'rgb16.png');
  await selectTarget(page, 'webp-lossless');
  await page.getByTestId('lossless-only').check();
  const target = page.getByTestId('target');
  await expect(target.locator('option[value="webp-lossless"]')).toBeDisabled();
  await expect(target).toHaveValue('png');
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('RGBA -> JPEG requires a flatten colour (default white), says alpha is lost, and honours the chosen colour', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  const bgField = page.getByTestId('background-field');
  await expect(bgField).toBeHidden();
  await selectTarget(page, 'jpeg');
  await expect(bgField).toBeVisible();
  await expect(page.getByTestId('background')).toHaveValue('#ffffff');
  await expect(bgField).toContainText('alpha channel will be lost');
  await expect(page.locator('[data-loss="alpha"]')).toContainText('background colour');
  await page.getByTestId('background').fill('#ff0000');
  await page.getByTestId('quality').fill('100');
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.jpg');
  const out = await decodeInBrowser(page, bytes, 'image/jpeg');
  const src = decodePngNode(fixture('rgba-partial.png'));
  expect(out.width).toBe(src.width);
  for (let y = 24; y < 36; y += 4) {
    for (let x = 4; x < out.width; x += 12) {
      const i = (y * out.width + x) * 4;
      expect(out.data[i], `r at ${x},${y}`).toBeGreaterThan(200);
      expect(out.data[i + 1], `g at ${x},${y}`).toBeLessThan(60);
      expect(out.data[i + 2], `b at ${x},${y}`).toBeLessThan(60);
    }
  }
});

test('metadata field only shows for sources with EXIF/XMP; ICC field only with a profile', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await expect(page.getByTestId('metadata-field')).toBeHidden();
  await expect(page.getByTestId('icc-field')).toBeHidden();
  await pickFixture(page, 'exif-gps.jpg');
  await expect(page.getByTestId('metadata-field')).toBeVisible();
  await expect(page.getByTestId('icc-field')).toBeHidden();
});

test('an unsupported file shows an error and no source panel', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('definitely not an image') });
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('error')).toContainText('PNG, JPEG, WebP, AVIF, JPEG XL and TIFF');
  await expect(page.getByTestId('source-facts')).toHaveCount(0);
});
