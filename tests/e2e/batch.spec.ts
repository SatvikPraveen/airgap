/**
 * Batch conversion: several files, one set of settings, per-file verification,
 * and a ZIP archive written by Airgap itself and read back by an independent
 * library (fflate) and decoders (pngjs).
 */
import { unzipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { assertPixelIdentical, decodePngNode, fixture, openApp, pickFixtures, selectTarget } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

async function convertAllAndDownloadZip(page: Page, expectedCount: number): Promise<Record<string, Uint8Array>> {
  const btn = page.getByTestId('convert');
  await expect(btn).toHaveText(`Convert ${expectedCount} file${expectedCount === 1 ? '' : 's'}`);
  await expect(btn).toBeEnabled({ timeout: 60_000 });
  await btn.click();
  await expect(page.getByTestId('download-zip')).toBeVisible({ timeout: 120_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-zip').click()]);
  const path = await download.path();
  if (!path) throw new Error('download has no path');
  expect(download.suggestedFilename()).toMatch(/^airgap-[a-z]+-\d{4}-\d{2}-\d{2}\.zip$/);
  return unzipSync(new Uint8Array(readFileSync(path)));
}

test('three PNGs -> PNG: every output in the ZIP is pixel-identical to its source (pngjs), rows verified', async ({ page }) => {
  await pickFixtures(page, ['rgb8.png', 'rgba-partial.png', 'rgba16.png']);
  await expect(page.getByTestId('source-facts')).toHaveCount(0); // batch mode: queue, not the single-file panel
  await expect(page.getByTestId('batch-row')).toHaveCount(3);
  await expect(page.getByTestId('batch-summary')).toContainText('3 files · 3 readable');
  await selectTarget(page, 'png');
  await expect(page.getByTestId('loss-none')).toContainText('all 3 files');
  const files = await convertAllAndDownloadZip(page, 3);
  expect(Object.keys(files).sort()).toEqual(['rgb8-converted.png', 'rgba-partial-converted.png', 'rgba16-converted.png']);
  for (const name of ['rgb8', 'rgba-partial', 'rgba16']) {
    assertPixelIdentical(decodePngNode(fixture(`${name}.png`)), decodePngNode(Buffer.from(files[`${name}-converted.png`]!)));
  }
  const rows = page.getByTestId('batch-row');
  for (let i = 0; i < 3; i++) {
    await expect(rows.nth(i)).toHaveAttribute('data-status', 'done');
    await expect(rows.nth(i).locator('.verification-cell')).toHaveAttribute('data-identical', 'true');
    await expect(rows.nth(i).getByTestId('batch-download')).toBeVisible();
  }
  await expect(page.getByTestId('batch-verification')).toContainText('3 of 3 readable files converted: 3 verified pixel-identical, 0 with measured differences, metadata as planned in all.');
});

test('mixed batch: the loss panel counts files per loss, and the metadata controls appear when any file has EXIF', async ({ page, browserName }) => {
  await pickFixtures(page, ['exif-gps.jpg', 'rgb8.png', 'rgb16.png']);
  await expect(page.getByTestId('metadata-field')).toBeVisible();
  await selectTarget(page, 'webp-lossless');
  const exif = page.locator('[data-loss="exif"]');
  await expect(exif).toContainText('1 of 3 files:');
  await expect(exif).toContainText('GPS');
  await expect(page.locator('[data-loss="bit-depth"]')).toContainText('1 of 3 files:');
  // WebKit on macOS decodes JPEG with ImageIO, which rounds differently from mozjpeg, so the JPEG decoder cannot
  // be cross-checked there and the one JPEG in the batch is honestly flagged (tests/browser/engine-matrix).
  const imageIo = browserName === 'webkit' && process.platform === 'darwin'; // see tests/browser/helpers.ts IMAGEIO
  if (imageIo) await expect(page.locator('[data-loss="decoder-unverified"]')).toContainText('1 of 3 files:');
  else await expect(page.locator('[data-loss="decoder-unverified"]')).toHaveCount(0);
  // Lossless-only: one 16-bit file loses bits in WebP, so the target is excluded for the whole batch.
  await page.getByTestId('lossless-only').check();
  await expect(page.getByTestId('target').locator('option[value="webp-lossless"]')).toBeDisabled();
  if (imageIo) {
    // The unverified JPEG decoder is a pixel loss for every target: nothing is lossless for this batch.
    await expect(page.getByTestId('target').locator('option[value="png"]')).toBeDisabled();
    await expect(page.getByTestId('no-target')).toContainText('every file in this batch');
  } else await expect(page.getByTestId('target')).toHaveValue('png');
  await page.getByTestId('lossless-only').uncheck();
  await selectTarget(page, 'png');
  const files = await convertAllAndDownloadZip(page, 3);
  expect(Object.keys(files).sort()).toEqual(['exif-gps.png', 'rgb16-converted.png', 'rgb8-converted.png']);
  const rows = page.getByTestId('batch-row');
  // JPEG -> PNG: decoded once, written losslessly, so the row verifies identical and EXIF stripped as planned.
  await expect(rows.nth(0).locator('.verification-cell')).toHaveAttribute('data-identical', 'true');
  await expect(rows.nth(0).locator('.verification-cell')).toHaveAttribute('data-metadata-ok', 'true');
  expect(Buffer.from(files['exif-gps.png']!).toString('latin1')).not.toContain('eXIf');
});

test('name collisions inside the archive get -2, -3 suffixes', async ({ page }) => {
  await pickFixtures(page, ['rgb8.png', 'rgba-partial.png', 'rgb8.png'], ['same.png', 'same.png', 'other.png']);
  await selectTarget(page, 'png');
  const files = await convertAllAndDownloadZip(page, 3);
  expect(Object.keys(files).sort()).toEqual(['other-converted.png', 'same-converted-2.png', 'same-converted.png'].sort());
  // Both "same.png" entries are distinct images and both are intact.
  assertPixelIdentical(decodePngNode(fixture('rgb8.png')), decodePngNode(Buffer.from(files['same-converted.png']!)));
  assertPixelIdentical(decodePngNode(fixture('rgba-partial.png')), decodePngNode(Buffer.from(files['same-converted-2.png']!)));
});

test('an unreadable file in the batch is reported in its row and the others still convert', async ({ page }) => {
  await page.getByTestId('file-input').setInputFiles([
    { name: 'rgb8.png', mimeType: 'image/png', buffer: fixture('rgb8.png') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
  ]);
  await expect(page.getByTestId('batch-table')).toBeVisible({ timeout: 30_000 });
  const bad = page.locator('[data-testid="batch-row"][data-name="notes.txt"]');
  await expect(bad).toHaveAttribute('data-status', 'error', { timeout: 30_000 });
  await expect(bad).toContainText('Unrecognised file');
  await expect(page.getByTestId('batch-summary')).toContainText('2 files · 1 readable · 1 unreadable');
  await selectTarget(page, 'png');
  const files = await convertAllAndDownloadZip(page, 1);
  expect(Object.keys(files)).toEqual(['rgb8-converted.png']);
  await expect(page.getByTestId('batch-verification')).toContainText('1 could not be read');
});

test('removing a file from a batch of two returns to the single-file flow', async ({ page }) => {
  await pickFixtures(page, ['rgb8.png', 'rgba-partial.png']);
  await page.getByTestId('batch-remove').first().click();
  await expect(page.getByTestId('batch-table')).toHaveCount(0);
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-fact="file"]')).toContainText('rgba-partial.png');
  await expect(page.getByTestId('convert')).toHaveText('Convert');
});

test('cancel during a batch keeps the finished outputs, marks the current file cancelled, and the batch can run again', async ({ page }) => {
  // Two 1400 x 1400 noise PNGs: AVIF lossless on noise takes seconds per file, long enough to cancel the second.
  const dt = await page.evaluateHandle(async () => {
    const dt = new DataTransfer();
    for (const [i, size] of [[1, 64], [2, 1400]] as const) {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(size, size);
      let s = 12345 + i;
      for (let k = 0; k < img.data.length; k++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        img.data[k] = s >>> 24;
      }
      ctx.putImageData(img, 0, 0);
      const blob = await c.convertToBlob({ type: 'image/png' });
      dt.items.add(new File([blob], `noise-${i}.png`, { type: 'image/png' }));
    }
    return dt;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('batch-row')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('batch-row').nth(1)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await selectTarget(page, 'avif-lossless');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('batch-row').nth(0)).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await expect(page.getByTestId('batch-row').nth(1)).toHaveAttribute('data-status', 'converting');
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('convert')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('batch-row').nth(0)).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('batch-row').nth(1)).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('batch-verification')).toContainText('1 of 2 readable files converted');
  await expect(page.getByTestId('batch-verification')).toContainText('1 cancelled');
  await expect(page.getByTestId('download-zip')).toContainText('1 files');
  await expect(page.getByTestId('error')).toBeHidden();
  // Run again with a fast target: both convert.
  await selectTarget(page, 'png');
  const files = await convertAllAndDownloadZip(page, 2);
  expect(Object.keys(files).sort()).toEqual(['noise-1-converted.png', 'noise-2-converted.png']);
});
