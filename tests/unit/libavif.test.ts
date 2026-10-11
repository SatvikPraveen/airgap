/**
 * Airgap's own libavif 1.4.2 + libaom 3.15.2 build (vendor/libavif), in Node. Stills are also
 * read back by @jsquash/avif's decoder (a different libavif build) as an independent check.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AirgapAvifModule } from '../../vendor/libavif/airgap_avif.js';
import { animationTiming, decodeAvif, encodeAvif, libavifVersion } from '../../src/codecs/wasm/libavif';
import type { PixelData } from '../../src/codecs/types';
import { probeImage } from '../../src/pixels';

let m: AirgapAvifModule;
let jsq: { decode(d: Uint8Array, bitDepth: number): { data: Uint8ClampedArray | Uint16Array } | null };

beforeAll(async () => {
  const factory = (await import('../../vendor/libavif/airgap_avif.js')).default;
  m = await factory({ wasmBinary: readFileSync(new URL('../../vendor/libavif/airgap_avif.wasm', import.meta.url)) });
  const require = createRequire(import.meta.url);
  const f = (await import('@jsquash/avif/codec/dec/avif_dec.js')).default as unknown as (o: object) => Promise<typeof jsq>;
  const wasm = readFileSync(require.resolve('@jsquash/avif/codec/dec/avif_dec.wasm'));
  jsq = await f({
    noInitialRun: true,
    instantiateWasm(imports: WebAssembly.Imports, cb: (i: WebAssembly.Instance) => void) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
      cb(inst);
      return inst.exports;
    },
  });
});

describe('libavif 1.4.2 (Airgap build)', () => {
  it('reports its version', () => {
    expect(libavifVersion(m)).toMatch(/^1\.4\.2/);
  });
  for (const depth of [8, 10, 12]) {
    it(`${depth}-bit RGBA still, lossless: own decoder and @jsquash/avif both reproduce every sample (alpha-0 colour included)`, () => {
      const px = probeImage(24, depth, true);
      const avif = encodeAvif(m, [px], true, { lossless: true });
      const back = decodeAvif(m, avif);
      expect(back.frames).toHaveLength(1);
      expect(back.depth).toBe(depth);
      expect(Array.from(back.frames[0]!.data)).toEqual(Array.from(px.data));
      const other = jsq.decode(avif, depth)!;
      expect(Array.from(other.data)).toEqual(Array.from(px.data));
    });
  }
  it('a lossless 4-frame sequence: every frame exact, durations exact as fractions, loop count kept', () => {
    const frames: PixelData[] = [0, 1, 2, 3].map((i) => probeImage(20, 8, true, 100 + i));
    const anim = { frames: frames.map((pixels, i) => ({ pixels, delayNum: [1, 7, 1, 1][i]!, delayDen: [10, 100, 30, 1][i]! })), loops: 3, hiddenDefault: false };
    const t = animationTiming(anim);
    expect(t.exact).toBe(true);
    expect(t.timescale).toBe(300); // lcm(10, 100, 30, 1)
    const avif = encodeAvif(m, frames, true, { lossless: true }, { ...t, loops: anim.loops });
    const back = decodeAvif(m, avif);
    expect(back.frames).toHaveLength(4);
    back.frames.forEach((f, i) => expect(Array.from(f.data), `frame ${i}`).toEqual(Array.from(frames[i]!.data)));
    expect(back.timescale).toBe(300);
    expect(back.durations).toEqual([30, 21, 10, 300]);
    expect(back.loops).toBe(3);
    expect(Buffer.from(avif).toString('latin1')).toContain('avis');
  });
  it('plays map to libavif repeats both ways (1, 2, 5 plays; 0 = forever)', () => {
    const frames = [probeImage(16, 8, false, 1), probeImage(16, 8, false, 2)];
    for (const loops of [1, 2, 5, 0]) expect(decodeAvif(m, encodeAvif(m, frames, false, { lossless: true }, { timescale: 300, durations: [30, 21], loops })).loops, `${loops}`).toBe(loops);
  });
  it('a sequence that loops forever reads back as infinite; a lossy sequence changes pixels', () => {
    const frames = [probeImage(16, 8, false, 1), probeImage(16, 8, false, 2)];
    const t = { timescale: 1000, durations: [100, 100], loops: 0 };
    expect(decodeAvif(m, encodeAvif(m, frames, false, { lossless: true }, t)).loops).toBe(0);
    const lossy = decodeAvif(m, encodeAvif(m, frames, false, { lossless: false, quality: 0.4 }, t));
    expect(Array.from(lossy.frames[1]!.data)).not.toEqual(Array.from(frames[1]!.data));
  });
});
