/**
 * Airgap's own PNG writer. Pure (pako for deflate). Its one job beyond
 * correctness is to pick the SMALLEST colour type that stores the pixels
 * exactly: greyscale, greyscale+alpha, palette (1/2/4/8-bit), RGB or RGBA,
 * at 8 or 16 bits. A generic RGBA encoder writes a 200-colour icon as four
 * bytes per pixel; this writer stores it as one index per pixel. The choice
 * is verified like everything else: the pipeline decodes the output again
 * and compares every sample.
 *
 * Filtering: adaptive per row (minimum sum of absolute differences, the
 * heuristic libpng recommends) for 8/16-bit truecolour and greyscale; filter
 * 0 for palette and sub-byte rows, as the PNG spec advises.
 */
import { deflate } from 'pako';
import { pngChunk } from '../metadata/containers';
import { concat } from '../metadata/tiff-ifd';
import { maxValue } from '../pixels';
import type { PixelData } from './types';

export type PngColorType = 0 | 2 | 3 | 4 | 6;

export interface PngLayout {
  colorType: PngColorType;
  /** Bits per sample (per index for palette images). */
  bitDepth: 1 | 2 | 4 | 8 | 16;
  /** Number of PLTE entries when colorType is 3. */
  paletteSize?: number;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MAX_PALETTE = 256;

export function layoutLabel(l: PngLayout): string {
  const base =
    l.colorType === 0 ? 'greyscale' : l.colorType === 4 ? 'greyscale + alpha' : l.colorType === 3 ? `palette (${l.paletteSize} colours)` : l.colorType === 2 ? 'RGB' : 'RGBA';
  return `${base}, ${l.bitDepth}-bit`;
}

interface Analysis extends PngLayout {
  palette?: Uint8Array; // RGBA entries, paletteSize * 4
  indexOf?: Map<number, number>;
}

/** One pass over the pixels: does it need alpha, is it grey, does it fit a palette. */
export function analyzePng(px: PixelData, hasAlpha: boolean): PngLayout {
  return analyze(px, hasAlpha);
}

function analyze(px: PixelData, hasAlpha: boolean): Analysis {
  const d = px.data;
  const max = maxValue(px.bitDepth);
  let needsAlpha = false;
  let grey = true;
  const colours = new Map<number, number>();
  let paletteOk = px.bitDepth === 8;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const a = hasAlpha ? d[i + 3]! : max;
    if (a !== max) needsAlpha = true;
    if (r !== g || g !== b) grey = false;
    if (paletteOk) {
      const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (!colours.has(key)) {
        if (colours.size === MAX_PALETTE) paletteOk = false;
        else colours.set(key, colours.size);
      }
    }
  }
  const depth = px.bitDepth === 16 ? 16 : 8;
  const bytesPerPixel = (grey ? 1 : 3) + (needsAlpha ? 1 : 0);
  // Palette wins when it is smaller than the direct representation (and is 8-bit only).
  if (paletteOk && colours.size > 0) {
    const n = colours.size;
    const indexBits: 1 | 2 | 4 | 8 = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
    if (indexBits < bytesPerPixel * 8) {
      // Opaque entries last so tRNS can be truncated (spec allows omitting trailing 255s).
      const entries = [...colours.keys()].sort((x, y) => (x & 255) - (y & 255));
      const palette = new Uint8Array(n * 4);
      const indexOf = new Map<number, number>();
      entries.forEach((key, idx) => {
        palette[idx * 4] = key >>> 24;
        palette[idx * 4 + 1] = (key >>> 16) & 255;
        palette[idx * 4 + 2] = (key >>> 8) & 255;
        palette[idx * 4 + 3] = key & 255;
        indexOf.set(key, idx);
      });
      return { colorType: 3, bitDepth: indexBits, paletteSize: n, palette, indexOf };
    }
  }
  const colorType: PngColorType = grey ? (needsAlpha ? 4 : 0) : needsAlpha ? 6 : 2;
  return { colorType, bitDepth: depth };
}

function channelsOf(colorType: PngColorType): number {
  return colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
}

/** Packs the pixels into PNG scanlines (no filter bytes) for the chosen layout. */
function scanlines(px: PixelData, a: Analysis): { rows: Uint8Array; rowBytes: number } {
  const { width, height } = px;
  const d = px.data;
  if (a.colorType === 3) {
    const bits = a.bitDepth;
    const rowBytes = Math.ceil((width * bits) / 8);
    const rows = new Uint8Array(rowBytes * height);
    const index = a.indexOf!;
    for (let y = 0; y < height; y++) {
      const ro = y * rowBytes;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const key = ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
        const idx = index.get(key)!;
        if (bits === 8) rows[ro + x] = idx;
        else {
          const perByte = 8 / bits;
          const byte = ro + Math.floor(x / perByte);
          const shift = 8 - bits * ((x % perByte) + 1);
          rows[byte] = rows[byte]! | (idx << shift);
        }
      }
    }
    return { rows, rowBytes };
  }
  const ch = channelsOf(a.colorType);
  const bps = a.bitDepth === 16 ? 2 : 1;
  const rowBytes = width * ch * bps;
  const rows = new Uint8Array(rowBytes * height);
  const grey = a.colorType === 0 || a.colorType === 4;
  const alpha = a.colorType === 4 || a.colorType === 6;
  let o = 0;
  for (let i = 0; i < d.length; i += 4) {
    const samples = grey ? (alpha ? [d[i]!, d[i + 3]!] : [d[i]!]) : alpha ? [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!] : [d[i]!, d[i + 1]!, d[i + 2]!];
    for (const s of samples) {
      if (bps === 2) {
        rows[o++] = s >> 8;
        rows[o++] = s & 255;
      } else rows[o++] = s;
    }
  }
  return { rows, rowBytes };
}

/** Adaptive filtering: per row, the filter whose output has the smallest sum of absolute values. */
function filterRows(rows: Uint8Array, rowBytes: number, height: number, bpp: number, adaptive: boolean): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * height);
  const candidates = adaptive ? [new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes), new Uint8Array(rowBytes)] : [];
  let prev: Uint8Array = new Uint8Array(rowBytes); // row above (zeros for the first row)
  for (let y = 0; y < height; y++) {
    const cur = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    const oo = y * (rowBytes + 1);
    if (!adaptive) {
      out[oo] = 0;
      out.set(cur, oo + 1);
      prev = cur;
      continue;
    }
    let bestType = 0;
    let bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      const f = candidates[t]!;
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = cur[i]!;
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        let v: number;
        switch (t) {
          case 0:
            v = x;
            break;
          case 1:
            v = x - a;
            break;
          case 2:
            v = x - b;
            break;
          case 3:
            v = x - ((a + b) >> 1);
            break;
          default: {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            v = x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          }
        }
        v &= 255;
        f[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = t;
      }
    }
    out[oo] = bestType;
    out.set(candidates[bestType]!, oo + 1);
    prev = cur;
  }
  return out;
}

export interface PngEncodeResult {
  bytes: Uint8Array;
  layout: PngLayout;
}

/**
 * Encodes to PNG with the minimal exact colour type. `hasAlpha` says whether
 * the alpha samples are meaningful (false: treated as opaque). Ancillary
 * metadata chunks are the caller's business (metadata/containers.ts).
 */
export function encodePng(px: PixelData, hasAlpha: boolean): PngEncodeResult {
  if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`PNG writer takes 8 or 16-bit input, got ${px.bitDepth}`);
  const a = analyze(px, hasAlpha);
  const { rows, rowBytes } = scanlines(px, a);
  const ch = channelsOf(a.colorType);
  const bpp = a.colorType === 3 ? 1 : Math.max(1, (ch * a.bitDepth) / 8);
  const filtered = filterRows(rows, rowBytes, px.height, bpp, a.colorType !== 3 && a.bitDepth >= 8);
  const level = filtered.length > 24 * 1024 * 1024 ? 6 : 9;
  const idat = deflate(filtered, { level });

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px.width);
  dv.setUint32(4, px.height);
  ihdr[8] = a.bitDepth;
  ihdr[9] = a.colorType;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const chunks: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (a.colorType === 3) {
    const n = a.paletteSize!;
    const plte = new Uint8Array(n * 3);
    let lastNonOpaque = -1;
    for (let i = 0; i < n; i++) {
      plte[i * 3] = a.palette![i * 4]!;
      plte[i * 3 + 1] = a.palette![i * 4 + 1]!;
      plte[i * 3 + 2] = a.palette![i * 4 + 2]!;
      if (a.palette![i * 4 + 3] !== 255) lastNonOpaque = i;
    }
    chunks.push(pngChunk('PLTE', plte));
    if (lastNonOpaque >= 0) {
      const trns = new Uint8Array(lastNonOpaque + 1);
      for (let i = 0; i <= lastNonOpaque; i++) trns[i] = a.palette![i * 4 + 3]!;
      chunks.push(pngChunk('tRNS', trns));
    }
  }
  chunks.push(pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)));
  const { palette, indexOf, ...layout } = a;
  void palette;
  void indexOf;
  return { bytes: concat(chunks), layout };
}
