import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Download, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, '..', 'fixtures');
export const DIST = join(here, '..', '..', 'dist');
export const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', jxl: 'image/jxl', tif: 'image/tiff', tiff: 'image/tiff' };
export const mimeOf = (name: string): string => MIME[name.split('.').pop()!] ?? 'application/octet-stream';

/** Page loaded, worker booted and answered, network quiet. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForSelector('html[data-ready]', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

/** Loads a fixture through the hidden <input type=file>. */
export async function pickFixture(page: Page, name: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles({ name, mimeType: mimeOf(name), buffer: fixture(name) });
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 30_000 });
}

/** Loads a fixture by dispatching a real `drop` event carrying a File. */
export async function dropFixture(page: Page, name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ({ bytes, name, type }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      return dt;
    },
    { bytes: Array.from(fixture(name)), name, type: mimeOf(name) },
  );
  const zone = page.getByTestId('dropzone');
  await zone.dispatchEvent('dragenter', { dataTransfer: dt });
  await zone.dispatchEvent('dragover', { dataTransfer: dt });
  await expect(zone).toHaveClass(/is-over/);
  await zone.dispatchEvent('drop', { dataTransfer: dt });
  await expect(zone).not.toHaveClass(/is-over/);
  await expect(page.getByTestId('source-facts')).toBeVisible({ timeout: 30_000 });
}

/** Selects a target and waits until its encoder has been loaded and probed. */
export async function selectTarget(page: Page, key: string): Promise<void> {
  await page.getByTestId('target').selectOption(key);
  await expect(page.getByTestId('target-note')).toContainText(/^Encoder /, { timeout: 60_000 });
}

export async function convertAndDownload(page: Page): Promise<{ bytes: Buffer; download: Download }> {
  await expect(page.getByTestId('convert')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('convert').click();
  await expect(page.getByTestId('verification')).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download').click()]);
  const path = await download.path();
  if (!path) throw new Error('download has no path');
  return { bytes: readFileSync(path), download };
}

export interface Raster {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array;
}

/** Independent PNG decode in Node (pngjs), no browser involved. 16-bit stays 16-bit. */
export function decodePngNode(bytes: Buffer): Raster {
  const png = PNG.sync.read(bytes, { skipRescale: true });
  if (png.depth === 16) {
    const d = Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const out = new Uint16Array(d.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = d.readUInt16BE(i * 2);
    return { width: png.width, height: png.height, data: out };
  }
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

/** Decode arbitrary image bytes with the browser's own decoder (WebP/AVIF/JPEG output). */
export async function decodeInBrowser(page: Page, bytes: Buffer, mime: string): Promise<Raster> {
  const r = await page.evaluate(
    async ({ bytes, mime }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: mime });
      const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { width: bmp.width, height: bmp.height, data: Array.from(d.data) };
    },
    { bytes: Array.from(bytes), mime },
  );
  return { width: r.width, height: r.height, data: new Uint8Array(r.data) };
}

export function assertPixelIdentical(a: Raster, b: Raster): void {
  expect(b.width).toBe(a.width);
  expect(b.height).toBe(a.height);
  expect(b.data.length).toBe(a.data.length);
  let maxDiff = 0;
  let firstBad = -1;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    if (d > maxDiff) {
      maxDiff = d;
      if (firstBad < 0) firstBad = i;
    }
  }
  expect(maxDiff, `first differing sample at index ${firstBad}`).toBe(0);
}

export function pngChunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    types.push(bytes.toString('ascii', off + 4, off + 8));
    off += 12 + len;
  }
  return types;
}

export function webpChunkTypes(bytes: Buffer): string[] {
  const types: string[] = [];
  let off = 12;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32LE(off + 4);
    types.push(bytes.toString('ascii', off, off + 4));
    off += 8 + len + (len & 1);
  }
  return types;
}

export function jpegHasExif(bytes: Buffer): boolean {
  let off = 2;
  while (off + 4 <= bytes.length && bytes[off] === 0xff) {
    const marker = bytes[off + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const len = bytes.readUInt16BE(off + 2);
    if (marker === 0xe1 && bytes.toString('ascii', off + 4, off + 10) === 'Exif\0\0') return true;
    off += 2 + len;
  }
  return false;
}

/** The exact set of files the production build ships. Lazy chunk requests must be one of these. */
export function builtAssetNames(): Set<string> {
  return new Set(readdirSync(join(DIST, 'assets')).map((f) => `assets/${f}`));
}

// ---------------------------------------------------------------- network trap

export interface NetworkTrap {
  /** Every request Playwright saw after the trap was armed, as `METHOD url`. */
  requests: string[];
  websockets: string[];
  /** CSP violations recorded in the page since navigation. */
  cspViolations(): Promise<string[]>;
}

/**
 * Must run BEFORE page.goto: records every CSP violation the document raises.
 * A fetch() blocked by connect-src 'none' never becomes a network request, so
 * without this recorder a leaky build could pass the request-count check.
 */
export async function armCspRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
    });
  });
}

/**
 * Arm AFTER the app is ready. From this point every request of any kind on
 * the page is recorded (the caller asserts on `requests`) and aborted so
 * nothing can leave even if the assertion were forgotten.
 */
export async function installNetworkTrap(page: Page): Promise<NetworkTrap> {
  const requests: string[] = [];
  const websockets: string[] = [];
  await page.route('**/*', (route) => {
    requests.push(`${route.request().method()} ${route.request().url()}`);
    void route.abort('blockedbyclient');
  });
  page.on('request', (r) => {
    const line = `${r.method()} ${r.url()}`;
    if (!requests.includes(line)) requests.push(line);
  });
  page.on('websocket', (ws) => websockets.push(ws.url()));
  return {
    requests,
    websockets,
    cspViolations: () => page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations),
  };
}
