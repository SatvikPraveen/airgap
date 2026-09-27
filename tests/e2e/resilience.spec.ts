/**
 * Recovery paths: cancelling a running conversion, and refusing an image
 * that would exhaust memory, both without leaving the page stuck.
 */
import { expect, test } from '@playwright/test';
import { openApp, selectTarget } from './helpers';

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

/** Drops a large noisy PNG generated in the browser (no fixture on disk needed). */
async function dropLargePng(page: import('@playwright/test').Page, size: number): Promise<void> {
  const dt = await page.evaluateHandle(async (size) => {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    let s = 12345;
    for (let i = 0; i < img.data.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      img.data[i] = s >>> 24;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], `noise-${size}.png`, { type: 'image/png' }));
    return dt;
  }, size);
  const zone = page.getByTestId('dropzone');
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 60_000 });
}

test('cancel during a slow conversion restarts the worker, keeps the source, and the next conversion works', async ({ page }) => {
  await dropLargePng(page, 1400);
  await selectTarget(page, 'avif-lossless'); // aom lossless on 2 MP of noise takes seconds: long enough to cancel
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('status')).toHaveText('Converting and verifying…');
  await expect(page.getByTestId('cancel')).toBeVisible();
  await page.getByTestId('cancel').click();

  // No error, no result, source still there (reloaded by the fresh worker), controls live again.
  await expect(page.getByTestId('convert')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('error')).toBeHidden();
  await expect(page.getByTestId('verification')).toHaveCount(0);
  await expect(page.locator('[data-fact="file"]')).toContainText('noise-1400.png');
  await expect(page.getByTestId('cancel')).toBeHidden();

  // The new worker re-probes on demand and converts fine.
  await selectTarget(page, 'png');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('verification')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('verification')).toHaveAttribute('data-identical', 'true');
});

test('an image above the memory limit is refused from its header alone, with the dimensions in the message', async ({ page }) => {
  // PNG signature + IHDR claiming 20000 x 20000 RGBA + IEND; no pixel data needed.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20000, 0);
  ihdr.writeUInt32BE(20000, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]); // CRC unchecked by the header parser
  };
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  await page.getByTestId('file-input').setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByTestId('error')).toBeVisible();
  await expect(page.getByTestId('error')).toContainText('20000 × 20000 px');
  await expect(page.getByTestId('source-facts')).toHaveCount(0);
  await expect(page.getByTestId('convert')).toBeDisabled();
});

test('a large but allowed image shows a non-blocking warning and still converts', async ({ page }) => {
  // 5000 x 5000 = 25 MP, just over the soft limit. Solid colour so PNG encode stays quick.
  const dt = await page.evaluateHandle(async () => {
    const c = new OffscreenCanvas(5000, 5000);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#4488cc';
    ctx.fillRect(0, 0, 5000, 5000);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'big.png', { type: 'image/png' }));
    return dt;
  });
  await page.getByTestId('dropzone').dispatchEvent('drop', { dataTransfer: dt });
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('notice')).toContainText('Large image (25 MP)');
  await selectTarget(page, 'png');
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('verification')).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId('result-layout')).toContainText('palette (1 colours)');
});
