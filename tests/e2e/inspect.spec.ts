/**
 * The metadata inspector (every EXIF tag and what the selected mode does to
 * it) and the compare view (source / output / changed-pixel heat map / wipe).
 */
import { expect, test } from '@playwright/test';
import { openApp, pickFixture, selectTarget } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test('metadata inspector lists every tag and marks what each mode removes', async ({ page }) => {
  await pickFixture(page, 'location-everywhere.jpg');
  await selectTarget(page, 'jpeg');
  const inspector = page.getByTestId('metadata-inspector');
  await expect(inspector).toBeVisible();
  await inspector.locator('summary').click();
  const rows = inspector.locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  const gpsRows = inspector.locator('tr[data-ifd="GPS"]');
  expect(await gpsRows.count()).toBeGreaterThan(0);
  const maker = inspector.locator('tr[data-tag="MakerNote"]');
  const make = inspector.locator('tr[data-tag="Make"]');

  // Default: strip all -> everything removed, XMP removed.
  await expect(make).toHaveAttribute('data-fate', 'removed');
  await expect(gpsRows.first()).toHaveAttribute('data-fate', 'removed');
  await expect(page.getByTestId('xmp-block')).toHaveAttribute('data-fate', 'removed');
  await expect(page.getByTestId('xmp-block').locator('pre')).toContainText('x:xmpmeta');

  // Strip GPS only: GPS + MakerNote removed, Make kept, thumbnail rewritten.
  await page.getByTestId('meta-strip-gps').check();
  await expect(inspector).toHaveAttribute('open', '');
  await expect(make).toHaveAttribute('data-fate', 'kept');
  await expect(gpsRows.first()).toHaveAttribute('data-fate', 'removed');
  await expect(maker).toHaveAttribute('data-fate', 'removed');
  await expect(inspector.locator('tr[data-ifd="IFD0"][data-tag="GPSInfo"]')).toHaveAttribute('data-fate', 'removed');
  await expect(inspector.locator('tr[data-ifd="IFD1"][data-tag="JPEGInterchangeFormat"]')).toHaveAttribute('data-fate', 'rewritten');
  await expect(page.getByTestId('xmp-block')).toHaveAttribute('data-fate', 'removed');

  // Preserve: everything kept, XMP kept.
  await page.getByTestId('meta-preserve').check();
  await expect(gpsRows.first()).toHaveAttribute('data-fate', 'kept');
  await expect(maker).toHaveAttribute('data-fate', 'kept');
  await expect(page.getByTestId('xmp-block')).toHaveAttribute('data-fate', 'kept');

  // A target that cannot carry EXIF removes everything whatever the mode.
  await selectTarget(page, 'avif-lossless');
  await expect(make).toHaveAttribute('data-fate', 'removed');
  await expect(inspector).toContainText('cannot embed EXIF');
});

test('no inspector for a source without metadata', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await expect(page.getByTestId('metadata-inspector')).toHaveCount(0);
});

test('compare view: lossy JPEG shows a heat map of changed pixels; a lossless PNG has none', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jpeg');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('verification')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'false');
  const view = page.getByTestId('compare-view');
  await expect(view).toBeVisible();
  await expect(page.getByTestId('compare-diff')).toBeEnabled();
  await expect(page.getByTestId('compare-diff')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('diff-canvas')).toBeVisible();
  // The heat map has painted pixels: read one row of the canvas and expect non-transparent samples.
  const painted = await page.getByTestId('diff-canvas').evaluate((c) => {
    const ctx = (c as HTMLCanvasElement).getContext('2d')!;
    const d = ctx.getImageData(0, 0, (c as HTMLCanvasElement).width, (c as HTMLCanvasElement).height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]! > 0) n++;
    return n;
  });
  expect(painted).toBeGreaterThan(0);
  await page.getByTestId('compare-source').click();
  await expect(page.getByTestId('compare-img-source')).toBeVisible();
  await page.getByTestId('compare-zoom').click();
  await expect(page.getByTestId('compare-stage')).toHaveClass(/actual/);

  await selectTarget(page, 'png');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true', { timeout: 60_000 });
  await expect(page.getByTestId('compare-diff')).toBeDisabled();
  await expect(page.getByTestId('compare-output')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('diff-canvas')).toHaveCount(0);
});
