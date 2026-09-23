/**
 * Metadata and ICC choices end to end, asserted on downloaded bytes parsed by
 * exifr (an independent EXIF reader) in Node.
 */
import { expect, test } from '@playwright/test';
import exifr from 'exifr';
import { convertAndDownload, decodePngNode, fixture, openApp, pickFixture, pngChunkTypes, selectTarget } from './helpers';

const parse = async (bytes: Buffer) =>
  ((await exifr.parse(bytes, { tiff: true, exif: true, gps: true, ifd0: true, translateKeys: true, translateValues: false, reviveValues: false, sanitize: false, mergeOutput: true } as never)) ?? {}) as Record<string, unknown>;

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('preserve all: every tag survives into the JPEG, Orientation stays 1', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'jpeg');
  await page.getByTestId('meta-preserve').check();
  await expect(page.locator('[data-loss="exif"]')).toHaveCount(0);
  const { bytes } = await convertAndDownload(page);
  const t = await parse(bytes);
  expect(t['Make']).toBe('Airgap Fixtures');
  expect(t['Model']).toBe('Synthetic Camera 1');
  expect(t['DateTimeOriginal']).toBe('2026:09:23 09:59:59');
  expect(t['GPSLatitudeRef']).toBe('N');
  expect(t['Orientation']).toBe(1);
  await expect(page.getByTestId('metadata-check')).toContainText('EXIF kept, GPS kept');
  await expect(page.getByTestId('metadata-check')).toHaveAttribute('data-ok', 'true');
});

test('strip GPS only: GPS tags gone, camera and timestamps intact, PNG eXIf chunk present', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'png');
  await page.getByTestId('meta-strip-gps').check();
  const loss = page.locator('[data-loss="gps"]');
  await expect(loss).toBeVisible();
  await expect(loss).toHaveAttribute('data-severity', 'metadata');
  const { bytes } = await convertAndDownload(page);
  expect(pngChunkTypes(bytes)).toContain('eXIf');
  const t = await parse(bytes);
  expect(t['Make']).toBe('Airgap Fixtures');
  expect(t['DateTimeOriginal']).toBe('2026:09:23 09:59:59');
  expect(Object.keys(t).filter((k) => k.startsWith('GPS'))).toEqual([]);
  await expect(page.getByTestId('metadata-check')).toContainText('EXIF kept, GPS removed');
});

test('strip all (default): nothing parseable remains', async ({ page }) => {
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'webp-lossless');
  await expect(page.getByTestId('meta-strip-all')).toBeChecked();
  const { bytes } = await convertAndDownload(page);
  expect(bytes.toString('ascii', 12, 16)).toBe('VP8L'); // simple container: no VP8X, no EXIF chunk
});

test('orientation: exif-orient6.jpg -> PNG preserve is upright and the carried tag says 1', async ({ page }) => {
  await pickFixture(page, 'exif-orient6.jpg');
  await expect(page.locator('[data-fact="orientation"]')).toContainText('6');
  await selectTarget(page, 'png');
  await page.getByTestId('meta-preserve').check();
  const loss = page.locator('[data-loss="orientation"]');
  await expect(loss).toBeVisible();
  await expect(loss).toContainText('rewritten to 1');
  const { bytes } = await convertAndDownload(page);
  const out = decodePngNode(bytes);
  expect([out.width, out.height]).toEqual([32, 48]);
  expect((await parse(bytes))['Orientation']).toBe(1);
  // top-left of the upright image is the fixture's bottom-left quadrant (blue)
  expect(out.data[0]!).toBeLessThan(80);
  expect(out.data[2]!).toBeGreaterThan(180);
});

test('ICC: matrix profile offers all three modes; convert changes values, preserve carries the profile', async ({ page }) => {
  await pickFixture(page, 'icc-p3.png');
  await expect(page.locator('[data-fact="icc-profile"]')).toContainText('Display P3');
  await selectTarget(page, 'png');
  const iccField = page.getByTestId('icc-field');
  await expect(iccField).toBeVisible();
  await expect(page.getByTestId('icc-convert')).toBeEnabled();

  await page.getByTestId('icc-preserve').check();
  await expect(page.getByTestId('loss-none')).toBeVisible();
  let r = await convertAndDownload(page);
  expect(pngChunkTypes(r.bytes)).toContain('iCCP');
  await expect(page.getByTestId('metadata-check')).toContainText('ICC kept');

  await page.getByTestId('icc-convert').check();
  const loss = page.locator('[data-loss="icc-convert"]');
  await expect(loss).toBeVisible();
  await expect(loss).toContainText('Appearance is preserved; values change');
  await expect(loss).toHaveAttribute('data-severity', 'pixels');
  r = await convertAndDownload(page);
  expect(pngChunkTypes(r.bytes)).not.toContain('iCCP');
  const out = decodePngNode(r.bytes);
  const src = decodePngNode(fixture('icc-p3.png'));
  let differs = false;
  for (let i = 0; i < src.data.length; i++) if (src.data[i] !== out.data[i]) differs = true;
  expect(differs).toBe(true);

  await page.getByTestId('icc-strip').check();
  await expect(page.locator('[data-loss="icc"]')).toContainText('Values preserved, appearance not');
});

test('ICC: LUT profile disables convert-to-sRGB with a stated reason', async ({ page }) => {
  await pickFixture(page, 'icc-lut.jpg');
  await expect(page.locator('[data-fact="icc-profile"]')).toContainText('LUT-based');
  await selectTarget(page, 'png');
  const convert = page.getByTestId('icc-convert');
  await expect(convert).toBeDisabled();
  await expect(page.getByTestId('icc-field')).toContainText('will not approximate');
  await expect(page.getByTestId('icc-preserve')).toBeEnabled();
});
