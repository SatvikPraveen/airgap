/**
 * The privacy test. After the app is ready, EVERY request of any kind fails
 * the test, and every Content-Security-Policy violation fails it too (a
 * fetch() blocked by connect-src 'none' never becomes a request, so the CSP
 * layer must be watched as well). A full conversion is exercised in between.
 *
 * Verified to be able to fail: a temporary `fetch('https://example.com')`
 * added to src/ui/app.ts turned this red via the CSP-violation channel, and
 * with connect-src removed from index.html it turned red via the request
 * channel. Both changes were reverted. The `positive control` test below keeps
 * that check automated.
 */
import { expect, test } from '@playwright/test';
import { armCspRecorder, convertAndDownload, installNetworkTrap, openApp, pickFixture } from './helpers';

test('zero network requests and zero CSP violations during a full conversion', async ({ page }) => {
  await armCspRecorder(page);
  await openApp(page);
  const trap = await installNetworkTrap(page);

  await pickFixture(page, 'exif-gps.jpg');
  await page.getByTestId('target').selectOption('webp-lossy');
  await page.getByTestId('quality').fill('70');
  await convertAndDownload(page);

  await pickFixture(page, 'rgba-partial.png');
  await page.getByTestId('target').selectOption('jpeg');
  await convertAndDownload(page);

  await page.getByTestId('target').selectOption('png');
  await convertAndDownload(page);

  expect(trap.requests, 'requests observed after load').toEqual([]);
  expect(trap.websockets, 'websockets opened after load').toEqual([]);
  expect(await trap.cspViolations(), 'CSP violations').toEqual([]);
});

test('the CSP forbids connections: connect-src is none, and no external hosts anywhere', async ({ page }) => {
  await openApp(page);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("default-src 'none'");
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
  // fetch() and WebSocket are stopped by connect-src before any request exists:
  // only the violation channel can see them.
  expect(violations.filter((v) => v.startsWith('connect-src')).length, seen).toBeGreaterThanOrEqual(2);
  // The <img> is stopped by img-src. Chromium additionally surfaces the blocked
  // request to the automation layer, so both channels may see it.
  expect(violations.some((v) => v.startsWith('img-src')), seen).toBe(true);
  // Nothing other than our deliberate leak attempts was observed.
  for (const r of trap.requests) expect(r, seen).toContain('example.invalid');
  expect(trap.websockets, seen).toEqual([]);
});
