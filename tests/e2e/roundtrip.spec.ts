import { expect, test } from '@playwright/test';
import * as P from '../fixtures/pattern.mjs';
import { decode as decodeTiff } from 'tiff';
import {
  assertPixelIdentical,
  decodeApngNode,
  decodeAvifNode,
  jxlToJpegNode,
  decodeWebpAnimNode,
  decodeJxlNode,
  decodeQoiNode,
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
  await expect(page.getByTestId('result-format')).toContainText('airgap-png');
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

test('JPEG XL lossless: rgba-partial.png -> JXL is exact over the full RGBA tuple, re-decoded in Node outside the browser', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'jxl-lossless');
  await expect(page.getByTestId('target-note')).toContainText('opaque pixels confirmed by jxl-oxide');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.jxl');
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  await expect(page.getByTestId('verification')).toContainText('(jxl-oxide)');
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), await decodeJxlNode(bytes));
});

test('JPEG XL source: rgba-partial.jxl -> PNG reads exactly through jxl-oxide; no decoder-unverified loss', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.jxl');
  await expect(page.locator('[data-fact="decoder"]')).toContainText('jxl-oxide');
  await selectTarget(page, 'png');
  await expect(page.locator('[data-loss="decoder-unverified"]')).toHaveCount(0);
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), decodePngNode(bytes));
});

test('JPEG XL source with EXIF and XMP boxes: preserve carries both into PNG; strip-gps removes only GPS', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jxl');
  await expect(page.locator('[data-fact="exif"]')).toContainText('GPS');
  await expect(page.locator('[data-fact="xmp"]')).toHaveText('present');
  await selectTarget(page, 'png');
  await page.getByTestId('meta-preserve').check();
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const kept = await convertAndDownload(page);
  expect(pngChunkTypes(kept.bytes)).toEqual(expect.arrayContaining(['eXIf', 'iTXt']));
  await expect(page.getByTestId('metadata-check')).toContainText('EXIF kept, GPS kept, ICC not in source, XMP kept');
  await page.getByTestId('meta-strip-gps').check();
  await expect(page.locator('[data-loss="gps"]')).toBeVisible();
  await convertAndDownload(page);
  await expect(page.getByTestId('metadata-check')).toContainText('EXIF kept, GPS removed');
});

test('JPEG XL lossy still converts and is reported lossy', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jxl-lossy');
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

test('QOI: rgba-partial.png -> QOI is exact over the full RGBA tuple, re-decoded by the reference decoder in Node', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'qoi');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('rgba-partial.qoi');
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('qoif');
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), await decodeQoiNode(bytes));
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('QOI source (reference encoder) -> PNG is exact; EXIF from a JPEG into QOI is listed as removed', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.qoi');
  await expect(page.locator('[data-fact="format"]')).toHaveText('QOI');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), decodePngNode(bytes));
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'qoi');
  await page.getByTestId('meta-preserve').check();
  await expect(page.locator('[data-loss="exif"]')).toContainText('cannot embed');
});

test('PNG + oxipng: the optimised download decodes identically (pngjs) and the result reports what oxipng did', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'png');
  const plain = await convertAndDownload(page);
  await page.getByTestId('optimize-png').check();
  const packed = await convertAndDownload(page);
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), decodePngNode(packed.bytes));
  expect(packed.bytes.length).toBeLessThanOrEqual(plain.bytes.length);
  const line = page.getByTestId('result-optimization');
  await expect(line).toContainText('oxipng');
  if ((await line.getAttribute('data-used')) === 'true') await expect(line).toContainText('decoded again and identical');
  else await expect(line).toContainText('output not used');
  await selectTarget(page, 'webp-lossless');
  await expect(page.getByTestId('optimize-field')).toBeHidden();
});

test('APNG -> PNG keeps the animation: every frame, delay and the loop count, re-read in Node by UPNG.js', async ({ page }) => {
  await pickFixture(page, 'apng-ops.png');
  await expect(page.locator('[data-fact="frames"]')).toHaveText('4 frames · 0.42 s per loop · plays 3 times');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  await expect(page.getByTestId('verification')).toContainText('all 4 frames');
  await expect(page.getByTestId('verification')).toContainText('every frame delay kept, loop count kept');
  const got = await decodeApngNode(bytes);
  const want = P.apngOpsExpectedFrames();
  expect(got.frames).toHaveLength(4);
  got.frames.forEach((f, i) => expect(Array.from(f), `frame ${i}`).toEqual(Array.from(want[i]!)));
  expect(got.delaysMs).toEqual([100, 70, 250, 0]);
  expect(got.plays).toBe(3);
});

test('APNG -> a still-only target: the animation loss names the frame count, and a still image separate from the animation', async ({ page }) => {
  await pickFixture(page, 'apng-ops.png');
  await selectTarget(page, 'tiff');
  await expect(page.locator('[data-loss="animation"]')).toContainText('4 frames');
  await pickFixture(page, 'apng-hidden.png');
  await expect(page.locator('[data-fact="frames"]')).toContainText('still image separate from the animation');
  await expect(page.locator('[data-loss="animation"]')).toContainText('still image is not one of its frames');
});

test('animated WebP -> PNG becomes an APNG frame for frame (libwebp in Node gives the reference frames)', async ({ page }) => {
  await pickFixture(page, 'webp-ops.webp');
  await expect(page.locator('[data-fact="frames"]')).toHaveText('4 frames · 0.42 s per loop · plays 3 times');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  await expect(page.getByTestId('verification')).toContainText('all 4 frames');
  const want = await decodeWebpAnimNode(fixture('webp-ops.webp'));
  const got = await decodeApngNode(bytes);
  got.frames.forEach((f, i) => expect(Array.from(f), `frame ${i}`).toEqual(Array.from(want.frames[i]!)));
  expect(got.delaysMs).toEqual(want.durations);
  expect(got.plays).toBe(3);
});

test('APNG -> animated WebP (lossless) keeps every frame and duration, read back by libwebp in Node', async ({ page }) => {
  await pickFixture(page, 'apng-ops.png');
  await selectTarget(page, 'webp-lossless');
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  await expect(page.getByTestId('verification')).toContainText('all 4 frames');
  const got = await decodeWebpAnimNode(bytes);
  const want = P.apngOpsExpectedFrames();
  got.frames.forEach((f, i) => expect(Array.from(f), `frame ${i}`).toEqual(Array.from(want[i]!)));
  expect(got.durations).toEqual([100, 70, 250, 0]);
});

test('JPEG -> JPEG XL by reversible recompression: the JPEG rebuilt in Node is the original file, byte for byte', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'jxl-jpeg');
  await page.getByTestId('meta-preserve').check();
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes, download } = await convertAndDownload(page);
  expect(download.suggestedFilename()).toBe('exif-gps.jxl');
  await expect(page.getByTestId('verification')).toContainText('byte-identical to the JPEG Airgap prepared');
  expect(bytes.length).toBeLessThan(fixture('exif-gps.jpg').length);
  const rebuilt = await jxlToJpegNode(bytes);
  expect(rebuilt?.equals(fixture('exif-gps.jpg'))).toBe(true);
});

test('JPEG recompression is offered for JPEG sources only, and refuses transforms with a reason', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await expect(page.getByTestId('target').locator('option[value="jxl-jpeg"]')).toHaveText(/JPEG sources only/);
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'jxl-jpeg');
  await page.getByTestId('rotate-right').click();
  await expect(page.getByTestId('transform-error')).toContainText('JPEG recompression keeps the JPEG exactly');
  await expect(page.getByTestId('convert')).toBeDisabled();
});

test('APNG -> animated AVIF (lossless): zero delay declared as 1 ms; frames re-read in Node by libavif match the spec model', async ({ page }) => {
  await pickFixture(page, 'apng-ops.png');
  await selectTarget(page, 'avif-lossless');
  await expect(page.locator('[data-loss="animation-timing"]')).toContainText('zero');
  const { bytes } = await convertAndDownload(page);
  await expect(page.getByTestId('verification')).toContainText('all 4 frames');
  const got = await decodeAvifNode(bytes);
  const want = P.apngOpsExpectedFrames();
  got.frames.forEach((f, i) => expect(Array.from(f), `frame ${i}`).toEqual(Array.from(want[i]!)));
  expect(got.durationsMs).toEqual([100, 70, 250, 1]);
  expect(got.loops).toBe(3);
});
