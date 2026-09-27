#!/usr/bin/env node
/**
 * Size budget for the production build (gzip -9, like scripts/bundle-report.mjs).
 * A codec upgrade or a stray import that doubles the first paint should fail
 * CI, not be discovered by users. Budgets are generous ceilings, not targets:
 * raise one deliberately, in the same commit as the change that needs it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const KB = 1024;
/** Group -> max gzipped bytes for the sum of that group's chunks. */
const BUDGET = {
  'first-paint': 48 * KB, // index.html + css + main js (includes the inline bootstrap worker)
  worker: 80 * KB, // registry, pipeline, metadata layer, pako, own PNG/TIFF writers
  png: 160 * KB,
  mozjpeg: 260 * KB,
  jpeg: 8 * KB,
  webp: 320 * KB,
  tiff: 48 * KB, // utif + the tiff codec wrapper
  jxl: 1400 * KB,
  avif: 2300 * KB,
  meta: 8 * KB,
  other: 32 * KB,
};

/** Chunk name stem -> budget group, where Vite's chunk naming differs from the codec name. */
const ALIAS = { squoosh: 'png', shared: 'worker', utif: 'tiff' };

const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const firstPaint = new Set(['index.html']);
for (const m of html.matchAll(/(?:src|href)="\/airgap\/(assets\/[^"]+)"/g)) firstPaint.add(m[1]);

const groups = {};
const add = (g, file, gz) => ((groups[g] ||= { gz: 0, files: [] }).gz += gz, groups[g].files.push(file));
add('first-paint', 'index.html', gzipSync(html, { level: 9 }).length);
for (const f of readdirSync(join(dist, 'assets'))) {
  const p = join(dist, 'assets', f);
  const gz = gzipSync(readFileSync(p), { level: 9 }).length;
  if (firstPaint.has('assets/' + f)) add('first-paint', f, gz);
  else {
    const stem = (f.match(/^([a-z0-9]+)[-_.]/i)?.[1] ?? 'other').toLowerCase();
    const g = ALIAS[stem] ?? stem;
    add(g in BUDGET ? g : 'other', f, gz);
  }
}

let failed = false;
for (const [g, { gz, files }] of Object.entries(groups).sort((a, b) => b[1].gz - a[1].gz)) {
  const max = BUDGET[g] ?? BUDGET.other;
  const ok = gz <= max;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${(gz / KB).toFixed(1).padStart(8)} KB / ${(max / KB).toFixed(0).padStart(5)} KB  ${g}  (${files.length} file${files.length === 1 ? '' : 's'})`);
}
if (failed) {
  console.error('\ncheck-bundle-budget: FAILED. Raise the budget in scripts/check-bundle-budget.mjs only if the growth is intended.');
  process.exit(1);
}
console.log('\ncheck-bundle-budget: ok');
