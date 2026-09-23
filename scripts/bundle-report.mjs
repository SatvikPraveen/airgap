#!/usr/bin/env node
/**
 * Reports gzipped sizes of dist/: what the browser downloads for first paint
 * versus what is loaded lazily per codec. Run after `npm run build`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const firstPaint = new Set(['index.html']);
for (const m of html.matchAll(/(?:src|href)="\/airgap\/(assets\/[^"]+)"/g)) firstPaint.add(m[1]);

const rows = [];
for (const f of readdirSync(join(dist, 'assets'))) {
  const p = join(dist, 'assets', f);
  const raw = statSync(p).size;
  const gz = gzipSync(readFileSync(p), { level: 9 }).length;
  rows.push({ file: 'assets/' + f, raw, gz, firstPaint: firstPaint.has('assets/' + f) });
}
rows.push({ file: 'index.html', raw: statSync(join(dist, 'index.html')).size, gz: gzipSync(html, { level: 9 }).length, firstPaint: true });

const kb = (n) => (n / 1024).toFixed(1).padStart(8) + ' KB';
let fp = 0, lazy = 0;
console.log('first-paint payload:');
for (const r of rows.filter((r) => r.firstPaint).sort((a, b) => b.gz - a.gz)) { fp += r.gz; console.log(`  ${kb(r.gz)} gz  ${kb(r.raw)} raw  ${r.file}`); }
console.log(`  = ${kb(fp)} gz total\n`);
console.log('lazily loaded (only when a format is used):');
const groups = {};
for (const r of rows.filter((r) => !r.firstPaint)) {
  const g = (r.file.match(/assets\/([a-z0-9]+)[-_.]/i)?.[1] ?? 'other').toLowerCase();
  (groups[g] ||= []).push(r);
}
for (const [g, rs] of Object.entries(groups).sort((a, b) => b[1].reduce((n, r) => n + r.gz, 0) - a[1].reduce((n, r) => n + r.gz, 0))) {
  const sum = rs.reduce((n, r) => n + r.gz, 0);
  lazy += sum;
  console.log(`  ${kb(sum)} gz  ${g}`);
  for (const r of rs.sort((a, b) => b.gz - a.gz)) console.log(`      ${kb(r.gz)} gz  ${kb(r.raw)} raw  ${r.file}`);
}
console.log(`  = ${kb(lazy)} gz total lazy\n`);
