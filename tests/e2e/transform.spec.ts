/**
 * Crop, rotate, mirror and resize: declared before conversion, verified after,
 * and the downloaded file checked against an independent reference transform
 * computed here in Node on the pngjs decode of the source.
 */
import { expect, test } from '@playwright/test';
import { convertAndDownload, decodePngNode, fixture, openApp, pickFixture, selectTarget, type Raster } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

/** Reference: crop, then rotate 90° clockwise, written independently of src/transform.ts. */
function cropRotateCw(src: Raster, x0: number, y0: number, w: number, h: number): Raster {
  const out = new Uint8Array(w * h * 4);
  // Rotated image is h wide and w tall; output (ox, oy) comes from crop (oy, h - 1 - ox).
  for (let oy = 0; oy < w; oy++) {
    for (let ox = 0; ox < h; ox++) {
      const sx = x0 + oy;
      const sy = y0 + (h - 1 - ox);
      for (let c = 0; c < 4; c++) out[(oy * h + ox) * 4 + c] = src.data[(sy * src.width + sx) * 4 + c]!;
    }
  }
  return { width: h, height: w, data: out };
}

async function setNumber(page: import('@playwright/test').Page, testid: string, value: number): Promise<void> {
  const input = page.getByTestId(testid);
  await input.fill(String(value));
  await input.press('Tab'); // commit on change
}

test('crop + rotate right -> PNG: geometry losses listed, lossless-only allows it, output equals an independent reference', async ({ page }) => {
  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'png');
  const src = decodePngNode(fixture('rgba-partial.png'));
  await expect(page.getByTestId('transform-size')).toContainText(`Output: ${src.width} × ${src.height} px`);
  await page.getByTestId('crop-on').check();
  await setNumber(page, 'crop-x', 3);
  await setNumber(page, 'crop-y', 2);
  await setNumber(page, 'crop-w', 20);
  await setNumber(page, 'crop-h', 30);
  await page.getByTestId('rotate-right').click();
  await expect(page.getByTestId('rotation')).toHaveText('90° clockwise');
  await expect(page.getByTestId('transform-size')).toContainText('Output: 30 × 20 px');
  await expect(page.locator('[data-loss="crop"]')).toHaveAttribute('data-severity', 'geometry');
  await expect(page.locator('[data-loss="crop"]')).toContainText('Cropped to 20 × 30 px starting at (3, 2)');
  await expect(page.locator('[data-loss="reorient"]')).toContainText('rotated 90° clockwise');
  await page.getByTestId('lossless-only').check();
  await expect(page.getByTestId('target')).toHaveValue('png');
  await expect(page.getByTestId('convert')).toBeEnabled();

  const { bytes } = await convertAndDownload(page);
  const out = decodePngNode(bytes);
  const ref = cropRotateCw(src, 3, 2, 20, 30);
  expect([out.width, out.height]).toEqual([30, 20]);
  expect(Array.from(out.data)).toEqual(Array.from(ref.data)); // full RGBA, alpha-0 colour included
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
  await expect(page.getByTestId('verification')).toContainText('the source after your crop, rotation or resize');
  await expect(page.getByTestId('result-size')).toHaveText('30 × 20 px');
  await expect(page.getByTestId('compare-source')).toBeDisabled();
  await expect(page.locator('button[data-testid="compare-wipe"]')).toBeDisabled();
  await expect(page.getByTestId('compare-geometry-note')).toBeVisible();
});

test('mirror left-right twice is the identity: nothing listed, output identical to the source', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'png');
  await page.getByTestId('flip-h').check();
  await expect(page.locator('[data-loss="reorient"]')).toContainText('mirrored left-right');
  await page.getByTestId('flip-h').uncheck();
  await expect(page.getByTestId('loss-none')).toBeVisible();
  const { bytes } = await convertAndDownload(page);
  expect(Array.from(decodePngNode(bytes).data)).toEqual(Array.from(decodePngNode(fixture('rgb8.png')).data));
});

test('resize is a pixel loss: lossless-only excludes every target; the output has the requested size', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'png');
  const src = decodePngNode(fixture('rgb8.png'));
  await page.getByTestId('resize-on').check();
  const half = Math.round(src.width / 2);
  await setNumber(page, 'resize-w', half);
  const expectH = Math.round((half * src.height) / src.width);
  await expect(page.getByTestId('resize-h')).toHaveValue(String(expectH)); // aspect locked
  const loss = page.locator('[data-loss="resample"]');
  await expect(loss).toHaveAttribute('data-severity', 'pixels');
  await expect(loss).toContainText(`to ${half} × ${expectH} px, downscaled`);
  await expect(loss).toContainText('Lanczos-3');
  await page.getByTestId('lossless-only').check();
  await expect(page.getByTestId('no-target')).toBeVisible();
  await expect(page.getByTestId('convert')).toBeDisabled();
  await page.getByTestId('lossless-only').uncheck();
  await selectTarget(page, 'png');
  const { bytes } = await convertAndDownload(page);
  const out = decodePngNode(bytes);
  expect([out.width, out.height]).toEqual([half, expectH]);
  // PNG is lossless: the verification compares with the resampled image and finds it exact.
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('rotating a quarter turn swaps a requested output size; an invalid crop disables Convert with a reason', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'png');
  await page.getByTestId('resize-on').check();
  await page.getByTestId('resize-lock').uncheck();
  await setNumber(page, 'resize-w', 40);
  await setNumber(page, 'resize-h', 10);
  await page.getByTestId('rotate-left').click();
  await expect(page.getByTestId('rotation')).toHaveText('270° clockwise');
  await expect(page.getByTestId('resize-w')).toHaveValue('10');
  await expect(page.getByTestId('resize-h')).toHaveValue('40');
  await page.getByTestId('transform-reset').click();
  await expect(page.getByTestId('rotation')).toHaveText('not rotated');
  await page.getByTestId('crop-on').check();
  await setNumber(page, 'crop-w', 100000);
  await expect(page.getByTestId('transform-error')).toContainText('inside');
  await expect(page.getByTestId('convert')).toBeDisabled();
  await page.getByTestId('transform-reset').click();
  await expect(page.getByTestId('transform-error')).toBeHidden();
  await expect(page.getByTestId('convert')).toBeEnabled();
});

test('the quality preview follows the edit: its size line describes the transformed output', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jpeg');
  await expect(page.getByTestId('preview-summary')).toContainText(/^Quality 90: /, { timeout: 30_000 });
  await page.getByTestId('crop-on').check();
  await setNumber(page, 'crop-w', 8);
  await setNumber(page, 'crop-h', 8);
  // 8 x 8 = 64 pixels: the preview's "of N pixels" must say so once it has re-run.
  await expect(page.getByTestId('preview-summary')).toContainText(/ of 64 pixels change|every pixel is identical/, { timeout: 30_000 });
});
