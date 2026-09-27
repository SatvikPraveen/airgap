#!/usr/bin/env node
/**
 * Screenshots of the built app for design review and the README.
 * Usage: node scripts/screenshots.mjs <outDir> [baseUrl] [deviceScaleFactor]   (defaults: http://localhost:4173/airgap/, 2)
 * Requires `npm run preview` (or any server for dist/) to be running.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const out = process.argv[2] ?? 'screenshots';
const base = process.argv[3] ?? 'http://localhost:4173/airgap/';
const dpr = Number(process.argv[4] ?? 2);
mkdirSync(out, { recursive: true });
const fixtures = new URL('../tests/fixtures/', import.meta.url).pathname;

const browser = await chromium.launch();
async function shoot(name, { width, height, dark, flow }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? 'dark' : 'light', deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForSelector('html[data-ready]', { timeout: 30_000 });
  if (flow) await flow(page);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  await ctx.close();
  console.log('wrote', join(out, `${name}.png`));
}

const loadAndConvert = (fixture, target) => async (page) => {
  await page.getByTestId('file-input').setInputFiles({ name: fixture, mimeType: 'image/jpeg', buffer: readFileSync(join(fixtures, fixture)) });
  await page.getByTestId('source-facts').waitFor();
  if (target) {
    await page.getByTestId('target').selectOption(target);
    await page.getByTestId('target-note').filter({ hasText: /^Encoder / }).waitFor({ timeout: 60_000 });
    await page.getByTestId('meta-strip-gps').check().catch(() => {});
    await page.getByTestId('convert').click();
    await page.getByTestId('verification').waitFor({ timeout: 60_000 });
  }
};

await shoot('empty-light', { width: 1280, height: 900, dark: false });
await shoot('empty-dark', { width: 1280, height: 900, dark: true });
await shoot('converted-light', { width: 1280, height: 900, dark: false, flow: loadAndConvert('location-everywhere.jpg', 'jpeg') });
await shoot('converted-dark', { width: 1280, height: 900, dark: true, flow: loadAndConvert('location-everywhere.jpg', 'webp-lossy') });
await shoot('mobile-light', { width: 390, height: 844, dark: false, flow: loadAndConvert('exif-gps.jpg', 'png') });
await browser.close();
