import { expect, test } from '@playwright/test';
import { decode as decodeTiff } from 'tiff';
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
  selectTarget,
  webpChunkTypes,
} from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('drop rgb8.png, convert to PNG, download: bytes decode pixel-identical (independent decoder)', async ({ page }) => {
  await dropFixture(page, 'rgb8.png');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  await expect(page.getByTestId('quality-field')).toBeHidden();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgb8-converted.png');
  assertPixelIdentical(decodePngNode(fixture('rgb8.png')), decodePngNode(bytes));
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  await expect(page.getByTestId('result-format')).toContainText('wasm-png');
});

test('ALPHA: rgba-partial.png -> PNG is exact over the full RGBA tuple, transparent pixels included', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  const src = decodePngNode(fixture('rgba-partial.png'));
  const out = decodePngNode(bytes);
  assertPixelIdentical(src, out); // every sample: R, G, B and A, including RGB under alpha 0
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('ALPHA: rgba-partial.png -> WebP lossless is exact including RGB under alpha 0', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'webp-lossless');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  expect(webpChunkTypes(bytes)).toContain('VP8L');
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  // The browser's own WebP decoder is premultiplied, so only opaque pixels can be cross-checked here;
  // the full-tuple check ran inside the app (verification) and in tests/browser with the wasm decoder.
  const src = decodePngNode(fixture('rgba-partial.png'));
  const out = await decodeInBrowser(page, bytes, 'image/webp');
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] !== 255) continue;
    for (let c = 0; c < 4; c++) expect(out.data[i + c], `opaque sample ${i + c}`).toBe(src.data[i + c]);
  }
});

test('16-bit: rgba16.png -> PNG stays 16-bit and is sample-identical (pngjs)', async ({ page }) => {
  await pickFixture(page, 'rgba16.png');
  await expect(page.locator('[data-fact="bit-depth"]')).toHaveText('16-bit per channel');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  expect(bytes[24], 'IHDR bit depth').toBe(16);
  assertPixelIdentical(decodePngNode(fixture('rgba16.png')), decodePngNode(bytes));
  await expect(page.getByTestId('result-format')).toContainText('16-bit');
});

test('rgb16.png -> WebP lossless: bit-depth loss listed, output 8-bit, high bytes exact', async ({ page }) => {
  await pickFixture(page, 'rgb16.png');
  await selectTarget(page, 'webp-lossless');
  const loss = page.locator('[data-loss="bit-depth"]');
  await expect(loss).toBeVisible();
  await expect(loss).toContainText('the encoder');
  const { bytes } = await convertAndDownload(page);
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  const out = await decodeInBrowser(page, bytes, 'image/webp');
  const src = decodePngNode(fixture('rgb16.png'));
  for (let i = 0; i < src.data.length; i++) expect(out.data[i]).toBe(Math.round((src.data[i]! * 255) / 65535));
});

test('AVIF lossless: rgba-partial.png -> AVIF verified identical in-app and decodes in the browser', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'avif-lossless');
  await expect(page.getByTestId('loss-none')).toBeVisible({ timeout: 60_000 });
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.avif');
  expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  const out = await decodeInBrowser(page, bytes, 'image/avif');
  const src = decodePngNode(fixture('rgba-partial.png'));
  expect(out.width).toBe(src.width);
  for (let i = 0; i < src.data.length; i += 4) {
    if (src.data[i + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) expect(out.data[i + c], `opaque sample ${i + c}`).toBe(src.data[i + c]);
  }
});

test('TIFF: rgba-partial.png -> TIFF is read back exactly by an independent reader with straight alpha', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'tiff');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.tif');
  const ifd = decodeTiff(bytes)[0]!;
  expect(ifd.associatedAlpha).toBe(false);
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), { width: ifd.width, height: ifd.height, data: ifd.data as Uint8Array });
});

test('TIFF source: rgb16.tif -> PNG 16-bit exact', async ({ page }) => {
  await pickFixture(page, 'rgb16.tif');
  await expect(page.locator('[data-fact="decoder"]')).toContainText('utif-tiff');
  await selectTarget(page, 'png');
  // The fixture carries a Software tag, which counts as EXIF: a metadata loss under strip-all, never a pixel loss.
  await expect(page.locator('[data-loss="exif"]')).toBeVisible();
  await expect(page.locator('[data-severity="pixels"]')).toHaveCount(0);
  const { bytes } = await convertAndDownload(page);
  assertPixelIdentical(decodePngNode(fixture('rgb16.png')), decodePngNode(bytes));
});

test('JPEG XL: the lossless option is disabled (probe not exact); lossy JXL still converts', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jxl-lossy');
  const losslessOpt = page.getByTestId('target').locator('option[value="jxl-lossless"]');
  await expect(losslessOpt).toBeDisabled();
  await expect(losslessOpt).toHaveText(/lossless not verified/);
  await expect(page.locator('[data-loss="pixels-lossy"]')).toBeVisible();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgb8.jxl');
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0x0a);
});

test('exif-gps.jpg -> PNG default (strip all): EXIF + GPS loss listed, output carries no EXIF', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await expect(page.locator('[data-fact="exif"]')).toContainText('GPS');
  await selectTarget(page, 'png');
  const loss = page.locator('[data-loss="exif"]');
  await expect(loss).toBeVisible();
  await expect(loss).toContainText('GPS');
  await expect(loss).toHaveAttribute('data-severity', 'metadata');
  const { bytes } = await convertAndDownload(page);
  expect(pngChunkTypes(bytes)).not.toContain('eXIf');
  await expect(page.getByTestId('metadata-check')).toContainText('EXIF removed, GPS removed');
});

test('exif-gps.jpg -> JPEG: re-encoding flagged lossy, mozjpeg output has no EXIF by default', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'jpeg');
  await expect(page.locator('[data-loss="pixels-lossy"]')).toBeVisible();
  await expect(page.getByTestId('quality-field')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  expect(jpegHasExif(bytes)).toBe(false);
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'false');
  await expect(page.getByTestId('result-format')).toContainText('wasm-jpeg');
});
