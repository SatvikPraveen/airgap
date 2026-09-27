#!/usr/bin/env node
/**
 * Renders public/icon-192.png and public/icon-512.png (web app manifest icons)
 * deterministically with pngjs: the favicon's mark (a triangle over a base
 * line) on a rounded dark tile, with enough padding to be "maskable".
 * Re-run with `node scripts/make-icons.mjs`; the output is committed.
 */
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const out = new URL('../public/', import.meta.url).pathname;
const BG = [0x1f, 0x2a, 0x37];
const FG = [0x7d, 0xd3, 0xfc];

function render(size) {
  const png = new PNG({ width: size, height: size });
  const s = size / 32; // favicon coordinate space is 32x32
  const radius = 6 * s;
  const stroke = 2.5 * s;
  const ss = 3; // supersampling per axis
  // Triangle (8,22) (16,8) (24,22) and base line (6,26)-(26,26), both stroked.
  const segs = [
    [8, 22, 16, 8],
    [16, 8, 24, 22],
    [24, 22, 8, 22],
    [6, 26, 26, 26],
  ].map((v) => v.map((n) => n * s));
  const distToSeg = (px, py, [x1, y1, x2, y2]) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const insideTile = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tile = 0;
      let mark = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          if (insideTile(px, py)) tile++;
          if (segs.some((seg) => distToSeg(px, py, seg) <= stroke / 2)) mark++;
        }
      }
      const tileA = tile / (ss * ss);
      const markA = mark / (ss * ss);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.round(BG[c] * (1 - markA) + FG[c] * markA);
      png.data[i + 3] = Math.round(255 * tileA);
    }
  }
  return PNG.sync.write(png, { deflateLevel: 9 });
}

for (const size of [192, 512]) {
  writeFileSync(`${out}icon-${size}.png`, render(size));
  console.log(`wrote public/icon-${size}.png`);
}
