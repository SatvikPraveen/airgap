/**
 * Airgap's PNG writer against an independent reader (pngjs, in Node): every
 * colour type it can choose must decode back to the exact RGBA samples, and
 * the chosen layout must be the minimal one for the input.
 */
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { analyzePng, encodePng, layoutLabel } from '../../src/codecs/png-writer';
import { inspect } from '../../src/inspect';
import { extractMetadata, injectMetadata } from '../../src/metadata/containers';
import { allocate, probeImage } from '../../src/pixels';
import type { PixelData } from '../../src/codecs/types';

function decodeNode(bytes: Uint8Array): { width: number; height: number; depth: number; colorType: number; data: Uint8Array | Uint16Array } {
  const png = PNG.sync.read(Buffer.from(bytes), { skipRescale: true });
  if (png.depth === 16) {
    const d = Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const out = new Uint16Array(d.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = d.readUInt16LE(i * 2); // pngjs stores 16-bit samples native-endian
    return { width: png.width, height: png.height, depth: 16, colorType: png.colorType, data: out };
  }
  return { width: png.width, height: png.height, depth: png.depth, colorType: png.colorType, data: new Uint8Array(png.data) };
}

function expectExact(px: PixelData, hasAlpha: boolean, bytes: Uint8Array): void {
  const back = decodeNode(bytes);
  expect([back.width, back.height]).toEqual([px.width, px.height]);
  const max = px.bitDepth === 16 ? 65535 : 255;
  for (let i = 0; i < px.data.length; i += 4) {
    for (let c = 0; c < 3; c++) expect(back.data[i + c], `sample ${i + c}`).toBe(px.data[i + c]);
    expect(back.data[i + 3], `alpha ${i}`).toBe(hasAlpha ? px.data[i + 3] : max);
  }
}

function image(w: number, h: number, bitDepth: number, fill: (x: number, y: number) => [number, number, number, number]): PixelData {
  const px = allocate(w, h, bitDepth);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      px.data.set([r, g, b, a], (y * w + x) * 4);
    }
  return px;
}

describe('PNG writer picks the minimal exact layout', () => {
  it('opaque RGB with more than 256 colours -> RGB 8-bit (colour type 2)', () => {
    const px = image(40, 20, 8, (x, y) => [x * 6, y * 12, (x * y) & 255, 255]);
    const { bytes, layout } = encodePng(px, false);
    expect(layout).toEqual({ colorType: 2, bitDepth: 8 });
    expect(decodeNode(bytes).colorType).toBe(2);
    expectExact(px, false, bytes);
  });

  it('the probe image (opaque noise + every kind of alpha) is exact whatever layout is chosen', () => {
    const px = probeImage(40, 8, true);
    const { bytes } = encodePng(px, true);
    expectExact(px, true, bytes);
  });

  it('RGBA with more than 256 colours and real transparency -> RGBA 8-bit (colour type 6), RGB under alpha 0 kept', () => {
    const px = image(40, 20, 8, (x, y) => [x * 6, y * 12, (x * y) & 255, y < 5 ? 0 : y < 10 ? 128 : 255]);
    const { bytes, layout } = encodePng(px, true);
    expect(layout).toEqual({ colorType: 6, bitDepth: 8 });
    expectExact(px, true, bytes);
  });

  it('a fully opaque alpha channel is dropped: RGB, and the decoded alpha is 255 everywhere', () => {
    const px = image(40, 20, 8, (x, y) => [x * 6, y * 12, (x * y) & 255, 255]);
    const { bytes, layout } = encodePng(px, true);
    expect(layout.colorType).toBe(2);
    expectExact(px, true, bytes);
  });

  it('greyscale -> colour type 0; greyscale with alpha -> colour type 4', () => {
    // 256 distinct greys: an 8-bit palette index would not be smaller than an 8-bit grey sample.
    const g = image(64, 4, 8, (x, y) => [(x * 4 + y) & 255, (x * 4 + y) & 255, (x * 4 + y) & 255, 255]);
    const r1 = encodePng(g, false);
    expect(r1.layout).toEqual({ colorType: 0, bitDepth: 8 });
    expectExact(g, false, r1.bytes);
    // 64 greys x 8 alphas = 512 pairs: too many for a palette.
    const ga = image(64, 8, 8, (x, y) => [(x * 4) & 255, (x * 4) & 255, (x * 4) & 255, (y * 32) & 255]);
    const r2 = encodePng(ga, true);
    expect(r2.layout).toEqual({ colorType: 4, bitDepth: 8 });
    expectExact(ga, true, r2.bytes);
  });

  it('few colours -> palette at 1, 2, 4 or 8 bits, with tRNS only when needed', () => {
    const cases: [number, 1 | 2 | 4 | 8][] = [
      [2, 1],
      [4, 2],
      [16, 4],
      [200, 8],
    ];
    for (const [n, bits] of cases) {
      const px = image(37, 11, 8, (x, y) => {
        const k = (x + y * 37) % n;
        return [(k * 37) & 255, (k * 91) & 255, (k * 13) & 255, 255];
      });
      const { bytes, layout } = encodePng(px, false);
      expect(layout, `${n} colours`).toEqual({ colorType: 3, bitDepth: bits, paletteSize: n });
      expect(inspect(bytes).metadata.colorLayout).toBe(layoutLabel(layout));
      expectExact(px, false, bytes);
      const types = chunkTypes(bytes);
      expect(types).toContain('PLTE');
      expect(types).not.toContain('tRNS');
    }
    // Translucent entries force a tRNS chunk; RGB under alpha 0 stays distinct palette entries.
    const px = image(16, 4, 8, (x) => [x * 16, 0, 255 - x * 16, x < 4 ? 0 : x < 8 ? 128 : 255]);
    const { bytes, layout } = encodePng(px, true);
    expect(layout.colorType).toBe(3);
    expect(chunkTypes(bytes)).toContain('tRNS');
    expectExact(px, true, bytes);
  });

  it('257 colours no longer fit a palette -> RGB', () => {
    const px = image(257, 1, 8, (x) => [x & 255, x >> 8, 0, 255]);
    expect(analyzePng(px, false).colorType).toBe(2);
  });

  it('palette is skipped when it would not be smaller (RGB with 200 colours at 8-bit index is; grey with 3 shades is not)', () => {
    const grey3 = image(30, 3, 8, (_x, y) => [y * 100, y * 100, y * 100, 255]);
    // 3 shades: 2-bit index (2 bits/px) beats 1-byte grey (8 bits/px) -> palette.
    expect(analyzePng(grey3, false).colorType).toBe(3);
    const grey300 = image(300, 1, 8, (x) => [x & 255, x & 255, x & 255, 255]);
    expect(analyzePng(grey300, false).colorType).toBe(0);
  });

  it('16-bit: RGB, RGBA, grey and grey+alpha all round-trip sample-exact through pngjs', () => {
    const rgb = probeImage(24, 16, false, 0x999);
    const rgba = probeImage(24, 16, true, 0x777);
    const grey = image(19, 5, 16, (x, y) => [x * 3000 + y, x * 3000 + y, x * 3000 + y, 65535]);
    const greyA = image(19, 5, 16, (x, y) => [x * 3000, x * 3000, x * 3000, y * 16000]);
    for (const [px, alpha, ct] of [
      [rgb, false, 2],
      [rgba, true, 6],
      [grey, false, 0],
      [greyA, true, 4],
    ] as const) {
      const { bytes, layout } = encodePng(px, alpha);
      expect(layout).toEqual({ colorType: ct, bitDepth: 16 });
      expect(decodeNode(bytes).depth).toBe(16);
      expectExact(px, alpha, bytes);
    }
  });

  it('metadata chunks injected after the fact survive next to PLTE (ancillary before PLTE per spec)', () => {
    const px = image(8, 8, 8, (x) => [x * 30, 0, 0, 255]);
    const { bytes } = encodePng(px, false);
    const exif = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
    const out = injectMetadata(bytes, 'png', { exif });
    const types = chunkTypes(out);
    expect(types.indexOf('eXIf')).toBeLessThan(types.indexOf('PLTE'));
    expect(extractMetadata(out, 'png').exif).toEqual(exif);
    expectExact(px, false, out);
  });

  it('1x1 and 1-pixel-wide images encode (edge rows for the filter heuristic)', () => {
    const one = image(1, 1, 8, () => [201, 77, 19, 255]);
    expectExact(one, false, encodePng(one, false).bytes);
    const tall = image(1, 9, 8, (_x, y) => [y * 20, 255 - y * 20, y * 7, y % 2 ? 0 : 200]);
    expectExact(tall, true, encodePng(tall, true).bytes);
  });
});

function chunkTypes(b: Uint8Array): string[] {
  const out: string[] = [];
  let off = 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (off + 8 <= b.length) {
    const len = dv.getUint32(off);
    out.push(String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!));
    off += 12 + len;
  }
  return out;
}
