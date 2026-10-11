/**
 * Live quality preview: moving the slider on a lossy target runs the real
 * pipeline and reports size and measured pixel difference without producing a
 * result; the heat map can be opened from it; Convert still works afterwards.
 */
import { expect, test } from '@playwright/test';
import { convertAndDownload, openApp, pickFixture, selectTarget } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

/** Parses the size the UI prints ("763 B", "41.3 KB", "1.20 MB") back to bytes, with its rounding tolerance. */
function parseSize(text: string | null): { bytes: number; tolerance: number } {
  const m = /([\d.]+) (B|KB|MB)\b/.exec(text ?? '');
  if (!m) throw new Error(`no size in: ${text}`);
  const n = Number(m[1]);
  if (m[2] === 'B') return { bytes: n, tolerance: 0 };
  if (m[2] === 'KB') return { bytes: n * 1024, tolerance: 0.05 * 1024 + 1 };
  return { bytes: n * 1024 * 1024, tolerance: 0.005 * 1024 * 1024 + 1 };
}

test('moving the quality slider updates a measured size/difference line without pressing Convert', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jpeg');
  const summary = page.getByTestId('preview-summary');
  await expect(summary).toContainText(/^Quality 90: [\d.]+ (B|KB);/, { timeout: 30_000 });
  await expect(summary).toContainText(/pixels change, max per-channel difference \d+ at 8-bit/);
  await expect(page.getByTestId('preview-stat')).toHaveAttribute('data-fresh', 'true');
  const at90 = await summary.textContent();

  await page.getByTestId('quality').fill('20');
  await expect(summary).toContainText(/^Quality 20: /, { timeout: 30_000 });
  await expect(page.getByTestId('preview-stat')).toHaveAttribute('data-fresh', 'true');
  const at20 = await summary.textContent();
  expect(at20).not.toBe(at90);
  expect(parseSize(at20).bytes).toBeLessThan(parseSize(at90).bytes);
  await expect(page.getByTestId('verification')).toHaveCount(0); // a preview is not a result
});

test('the heat map opens from the preview and shows the changed pixels of the preview output', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'webp-lossy');
  await page.getByTestId('quality').fill('40');
  await expect(page.getByTestId('preview-summary')).toContainText(/^Quality 40: /, { timeout: 30_000 });
  const toggle = page.getByTestId('preview-compare-toggle');
  await expect(toggle).toHaveText(/^Show changed pixels \(\d/);
  await toggle.click();
  const compare = page.getByTestId('preview-compare');
  await expect(compare).toBeVisible();
  await expect(compare.getByTestId('diff-canvas')).toBeVisible();
  await expect(compare.getByTestId('compare-diff')).toHaveAttribute('aria-selected', 'true');
  // Re-rendering on a slider move must keep the view open, then refresh it for the new preview.
  await page.getByTestId('quality').fill('95');
  await expect(page.getByTestId('preview-summary')).toContainText(/^Quality 95: /, { timeout: 30_000 });
  await expect(compare).toBeVisible();
  await expect(toggle).toHaveText(/^Hide changed pixels/);
  await toggle.click();
  await expect(page.getByTestId('preview-compare')).toHaveCount(0);
});

test('the preview and the result agree: Convert produces the previewed size and difference', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jpeg');
  await page.getByTestId('quality').fill('55');
  const summary = page.getByTestId('preview-summary');
  await expect(summary).toContainText(/^Quality 55: /, { timeout: 30_000 });
  const text = (await summary.textContent())!;
  const differing = Number(/; ([\d,]+) of/.exec(text)![1]!.replace(/,/g, ''));
  const maxDiff = Number(/difference (\d+) at/.exec(text)![1]);
  const { bytes } = await convertAndDownload(page);
  const size = parseSize(text);
  expect(Math.abs(bytes.length - size.bytes)).toBeLessThanOrEqual(size.tolerance);
  await expect(page.getByTestId('verification')).toContainText(`${differing} of`);
  await expect(page.getByTestId('verification')).toContainText(`difference ${maxDiff} at`);
});

test('no preview for a lossless target, and the preview goes away when the target becomes lossless', async ({ page }) => {
  await pickFixture(page, 'rgb8.png');
  await selectTarget(page, 'jpeg');
  await expect(page.getByTestId('preview-summary')).toBeVisible({ timeout: 30_000 });
  await selectTarget(page, 'png');
  await expect(page.getByTestId('quality-field')).toBeHidden();
  await expect(page.getByTestId('preview-summary')).toHaveCount(0);
});

test('a large source previews on demand only', async ({ page }) => {
  // 2100 x 2100 = 4.4 MP, just above the auto limit; generated in the page, no fixture needed.
  const dt = await page.evaluateHandle(async () => {
    const size = 2100;
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#4080c0';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#f0e040';
    ctx.fillRect(100, 100, 900, 900);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'big.png', { type: 'image/png' }));
    return dt;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 60_000 });
  await selectTarget(page, 'jpeg');
  const run = page.getByTestId('preview-run');
  await expect(run).toBeVisible();
  await expect(page.getByTestId('preview-summary')).toHaveCount(0);
  await run.click();
  await expect(page.getByTestId('preview-summary')).toContainText(/^Quality 90: /, { timeout: 60_000 });
  // Moving the slider again does not auto-run: the button comes back and the old numbers are marked stale.
  await page.getByTestId('quality').fill('30');
  await expect(page.getByTestId('preview-run')).toHaveText('Preview at quality 30');
  await expect(page.getByTestId('preview-stat')).toHaveAttribute('data-fresh', 'false');
});
