/**
 * Airgap's own libjxl 0.12 build (vendor/libjxl), run in Node. The app's JPEG XL decoder of
 * record, jxl-oxide, is the independent check here.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AirgapJxlModule } from '../../vendor/libjxl/airgap_jxl.js';
import { decodeJxl, encodeJxl, jpegToJxl, jxlToJpeg, libjxlVersion } from '../../src/codecs/wasm/libjxl';
import { probeImage } from '../../src/pixels';
import { fixture } from './helpers';

let m: AirgapJxlModule;
let oxide: typeof import('jxl-oxide-wasm');

beforeAll(async () => {
  const factory = (await import('../../vendor/libjxl/airgap_jxl.js')).default;
  m = await factory({ wasmBinary: readFileSync(new URL('../../vendor/libjxl/airgap_jxl.wasm', import.meta.url)) });
  oxide = await import('jxl-oxide-wasm');
  oxide.initSync({ module: readFileSync(new URL('../../node_modules/jxl-oxide-wasm/jxl_oxide_wasm_bg.wasm', import.meta.url)) });
});

/** jxl-oxide (independent) -> PNG -> pngjs, raw samples. */
async function viaOxide(jxl: Uint8Array): Promise<{ data: Uint8Array | Uint16Array; depth: number }> {
  const { PNG } = await import('pngjs');
  const img = new oxide.JxlImage();
  img.feedBytes(jxl);
  img.tryInit();
  const png = PNG.sync.read(Buffer.from(img.render().encodeToPng()), { skipRescale: true });
  img.free();
  if (png.depth === 16) {
    const d = Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const out = new Uint16Array(d.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = d.readUInt16LE(i * 2);
    return { data: out, depth: 16 };
  }
  return { data: new Uint8Array(png.data), depth: 8 };
}

describe('libjxl 0.12 (Airgap build)', () => {
  it('reports its version', () => {
    expect(libjxlVersion(m)).toBe('0.12.0');
  });
  for (const depth of [8, 16]) {
    it(`${depth}-bit RGBA lossless: own decoder AND jxl-oxide reproduce every sample, colour under alpha 0 included`, async () => {
      const px = probeImage(24, depth, true);
      const jxl = encodeJxl(m, px, true, { lossless: true });
      const own = decodeJxl(m, jxl);
      expect(own.pixels.bitDepth).toBe(depth);
      expect(own.storedBits).toBe(depth);
      expect(Array.from(own.pixels.data)).toEqual(Array.from(px.data));
      const ox = await viaOxide(jxl);
      expect(ox.depth).toBe(depth);
      expect(Array.from(ox.data)).toEqual(Array.from(px.data));
    });
  }
  it('lossy encoding changes pixels and is smaller', () => {
    const px = probeImage(64, 8, false);
    const lossless = encodeJxl(m, px, false, { lossless: true });
    const lossy = encodeJxl(m, px, false, { lossless: false, quality: 0.5 });
    expect(lossy.length).toBeLessThan(lossless.length);
    expect(Array.from(decodeJxl(m, lossy).pixels.data)).not.toEqual(Array.from(px.data));
  });
  it('EXIF and XMP go into boxes and an ICC profile into the codestream', () => {
    const px = probeImage(16, 8, false);
    const exif = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
    const xmp = new TextEncoder().encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
    const icc = fixture('display-p3.icc');
    const jxl = encodeJxl(m, px, false, { lossless: true, exif, xmp, icc });
    const s = Buffer.from(jxl).toString('latin1');
    expect(s).toContain('Exif');
    expect(s).toContain('xml ');
    const back = decodeJxl(m, jxl);
    expect(back.icc?.length).toBeGreaterThan(100);
  });
  it('JPEG recompression is reversible: the rebuilt JPEG is byte-identical, and smaller as JPEG XL', () => {
    for (const name of ['exif-gps.jpg', 'exif-orient6.jpg', 'location-everywhere.jpg']) {
      const jpeg = fixture(name);
      const jxl = jpegToJxl(m, jpeg);
      const back = jxlToJpeg(m, jxl)!;
      expect(Buffer.from(back).equals(Buffer.from(jpeg)), name).toBe(true);
    }
    expect(jxlToJpeg(m, encodeJxl(m, probeImage(8, 8, false), false, { lossless: true }))).toBeNull();
  });
});
