import { expect, test } from '@playwright/test';
import {
  assertPixelIdentical,
  convertAndDownload,
  decodeInBrowser,
  decodePngNode,
  dropFixture,
  fixture,
  jpegHasExif,
  openApp,
  pickFixture,
  pngChunkTypes,
  webpChunkTypes,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('drop rgb8.png, convert to PNG, download: bytes decode pixel-identical (independent decoder)', async ({ page }) => {
  await dropFixture(page, 'rgb8.png');
  await page.getByTestId('target').selectOption('png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  await expect(page.getByTestId('quality-field')).toBeHidden();

  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgb8-converted.png');
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  assertPixelIdentical(decodePngNode(fixture('rgb8.png')), decodePngNode(bytes));
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('one-pixel.png via the file picker round-trips exactly', async ({ page }) => {
  await pickFixture(page, 'one-pixel.png');
  const { bytes } = await convertAndDownload(page);
  const out = decodePngNode(bytes);
  expect(out.width).toBe(1);
  expect(Array.from(out.data)).toEqual([201, 77, 19, 255]);
});

test('rgb8.png -> WebP (lossless): downloaded WebP is VP8L and decodes pixel-identical', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  const note = page.getByTestId('webp-note');
  await expect(note).toContainText('Verified');
  await page.getByTestId('target').selectOption('webp-lossless');
  await expect(page.getByTestId('loss-none')).toBeVisible();

  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgb8.webp');
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
  expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
  expect(webpChunkTypes(bytes), 'lossless bitstream').toContain('VP8L');
  expect(webpChunkTypes(bytes)).not.toContain('VP8 ');

  const original = decodePngNode(fixture('rgb8.png'));
  const decoded = await decodeInBrowser(page, bytes, 'image/webp');
  assertPixelIdentical(original, decoded);
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('rgb16.png -> PNG: bit-depth loss is listed, output is 8-bit', async ({ page }) => {
  await pickFixture(page, 'rgb16.png');
  await expect(page.locator('[data-fact="bit-depth"]')).toHaveText('16-bit per channel');
  const loss = page.locator('[data-loss="bit-depth"]');
  await expect(loss).toBeVisible();
  await expect(loss).toHaveAttribute('data-severity', 'pixels');
  await expect(loss).toContainText('16-bit');

  const { bytes } = await convertAndDownload(page);
  expect(bytes[24], 'IHDR bit depth byte').toBe(8);
  // The 8-bit output re-decodes identically to itself (verification ran in-app).
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('exif-gps.jpg -> PNG: EXIF + GPS loss is listed, output carries no EXIF', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await expect(page.locator('[data-fact="exif"]')).toContainText('GPS');
  const loss = page.locator('[data-loss="exif"]');
  await expect(loss).toBeVisible();
  await expect(loss).toContainText('GPS');
  await expect(loss).toHaveAttribute('data-severity', 'metadata');
  await expect(page.locator('[data-loss="pixels-lossy"]')).toHaveCount(0);

  const { bytes } = await convertAndDownload(page);
  expect(pngChunkTypes(bytes)).not.toContain('eXIf');
  expect(pngChunkTypes(bytes)).not.toContain('iCCP');
});

test('exif-gps.jpg -> JPEG: re-encoding is flagged lossy and output has no EXIF', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await page.getByTestId('target').selectOption('jpeg');
  await expect(page.locator('[data-loss="pixels-lossy"]')).toBeVisible();
  await expect(page.locator('[data-loss="exif"]')).toBeVisible();
  await expect(page.getByTestId('quality-field')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  expect(jpegHasExif(fixture('exif-gps.jpg'))).toBe(true);
  expect(jpegHasExif(bytes)).toBe(false);
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'false');
});
