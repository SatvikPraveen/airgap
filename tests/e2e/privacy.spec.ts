/**
 * The privacy test. After the app is ready AND the codecs a conversion needs
 * have been loaded, EVERY request of any kind fails the test, and every
 * Content-Security-Policy violation fails it too (a fetch() blocked by
 * connect-src 'none' never becomes a request, so the CSP layer must be
 * watched as well). Full conversions are exercised in between.
 *
 * Lazily loaded codec chunks are the one thing that legitimately loads after
 * first paint. A separate test pins them down: the only requests allowed while
 * a codec loads are GETs of files that exist, by exact name, in the production
 * build's assets directory.
 *
 * Verified to be able to fail (re-verified for Phase 3): a temporary
 * `fetch('https://example.invalid/leak-test')` in src/ui/app.ts turned the
 * conversion test red via the CSP-violation channel, and with connect-src
 * relaxed via the request channel. Both changes were reverted. The positive
 * controls below keep that check automated, including from inside a worker.
 */
import { expect, test } from '@playwright/test';
import { armCspRecorder, builtAssetNames, convertAndDownload, installNetworkTrap, openApp, pickFixture, selectTarget } from './helpers';

test('zero network requests and zero CSP violations during full conversions (codecs pre-loaded)', async ({ page }) => {
  await armCspRecorder(page);
  await openApp(page);
  // Warm the codecs this test will use, so that the trap below is absolute.
  await pickFixture(page, 'exif-gps.jpg');
  await selectTarget(page, 'webp-lossy');
  await selectTarget(page, 'jpeg');
  await selectTarget(page, 'png');
  await selectTarget(page, 'tiff');
  await page.waitForLoadState('networkidle');
  const trap = await installNetworkTrap(page);

  await selectTarget(page, 'webp-lossy');
  await page.getByTestId('quality').fill('70');
  await page.getByTestId('meta-strip-gps').check();
  await convertAndDownload(page);

  await pickFixture(page, 'rgba-partial.png');
  await selectTarget(page, 'jpeg');
  await convertAndDownload(page);

  await selectTarget(page, 'png');
  await convertAndDownload(page);

  await selectTarget(page, 'tiff');
  await convertAndDownload(page);

  expect(trap.requests, 'requests observed after load').toEqual([]);
  expect(trap.websockets, 'websockets opened after load').toEqual([]);
  expect(await trap.cspViolations(), 'CSP violations').toEqual([]);
});

test('lazy codec loading only ever requests the build\'s own asset files by exact name (GET, no query)', async ({ page }) => {
  await armCspRecorder(page);
  await openApp(page);
  const trap = await installNetworkTrapAllowingAssets(page);
  await pickFixture(page, 'rgba-partial.png');
  for (const key of ['png', 'webp-lossless', 'avif-lossless', 'jxl-lossy', 'tiff', 'jpeg']) await selectTarget(page, key);
  await selectTarget(page, 'avif-lossless');
  await convertAndDownload(page);
  const assets = builtAssetNames();
  expect(trap.seen.length).toBeGreaterThan(3); // codecs really did load lazily
  for (const line of trap.seen) {
    const m = /^GET http:\/\/localhost:4173\/airgap\/(assets\/[^?#]+)$/.exec(line);
    expect(m, `request must be a plain GET of a built asset: ${line}`).not.toBeNull();
    expect(assets.has(m![1]!), `must exist in dist/assets by exact name: ${line}`).toBe(true);
  }
  expect(await trap.cspViolations()).toEqual([]);
});

/** Like installNetworkTrap but lets same-origin built assets through (recorded), aborting everything else. */
async function installNetworkTrapAllowingAssets(page: import('@playwright/test').Page) {
  const seen: string[] = [];
  const assets = builtAssetNames();
  await page.route('**/*', (route) => {
    const line = `${route.request().method()} ${route.request().url()}`;
    seen.push(line);
    const m = /^GET http:\/\/localhost:4173\/airgap\/(assets\/[^?#]+)$/.exec(line);
    if (m && assets.has(m[1]!)) return route.continue();
    return route.abort('blockedbyclient');
  });
  return { seen, cspViolations: () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations) };
}

test('the conversion worker runs on a blob: URL, so it inherits the page CSP', async ({ page }) => {
  await openApp(page);
  const urls = page.workers().map((w) => w.url());
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) expect(u, 'worker URL').toMatch(/^blob:/);
});

test('positive control: a blob worker spawned by the page cannot fetch either', async ({ page }) => {
  await armCspRecorder(page);
  await openApp(page);
  const trap = await installNetworkTrap(page);
  const result = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const src = `fetch('https://example.invalid/from-worker').then(r => postMessage('resolved ' + r.status), e => postMessage('rejected ' + e.message));`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = (e) => resolve(String(e.data));
        w.onerror = (e) => resolve('worker error ' + e.message);
        setTimeout(() => resolve('timeout'), 3000);
      }),
  );
  expect(result).toMatch(/^rejected/);
  expect(trap.requests.filter((r) => r.includes('example.invalid'))).toEqual([]);
});

test('the CSP: connect-src none, worker-src blob only, wasm-unsafe-eval but never unsafe-eval, no external hosts', async ({ page }) => {
  await openApp(page);
  const csp = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'))!;
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain('worker-src blob:');
  expect(csp).not.toMatch(/worker-src[^;]*'self'/);
  expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
  expect(csp).not.toMatch(/'unsafe-eval'/);
  expect(csp).not.toMatch(/'unsafe-inline'/);
  expect(csp).not.toMatch(/https?:/);
  expect(csp).not.toContain('*');
});

test('positive control: the trap DOES catch a fetch, an image beacon and a websocket attempt', async ({ page }) => {
  await armCspRecorder(page);
  await openApp(page);
  const trap = await installNetworkTrap(page);
  await page.evaluate(async () => {
    await fetch('https://example.invalid/leak').catch(() => undefined);
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.onerror = () => resolve();
      img.onload = () => resolve();
      img.src = 'https://example.invalid/pixel.gif';
      setTimeout(resolve, 500);
    });
    try {
      new WebSocket('wss://example.invalid/ws');
    } catch {
      /* CSP throws synchronously */
    }
  });
  const violations = await trap.cspViolations();
  const seen = `violations: ${violations.join(' | ')} / requests: ${trap.requests.join(' | ')}`;
  expect(violations.filter((v) => v.startsWith('connect-src')).length, seen).toBeGreaterThanOrEqual(2);
  expect(violations.some((v) => v.startsWith('img-src')), seen).toBe(true);
  for (const r of trap.requests) expect(r, seen).toContain('example.invalid');
  expect(trap.websockets, seen).toEqual([]);
});
