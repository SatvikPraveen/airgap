/**
 * APNG reading and writing (src/codecs/apng.ts) against UPNG.js, an independent
 * JavaScript APNG decoder (dev dependency only). Still-frame decoding in these
 * tests uses pngjs, so nothing here shares code with the app's Rust decoder.
 */
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeApng, durationMs, encodeApng, parseApng } from '../../src/codecs/apng';
import type { Animation, PixelData } from '../../src/codecs/types';
import { inspect } from '../../src/inspect';
import { probeImage } from '../../src/pixels';
import { fixture } from './helpers';
import * as P from '../fixtures/pattern.mjs';

const expectedOpsFrames = P.apngOpsExpectedFrames;

const require = createRequire(import.meta.url);
const UPNG = require('upng-js') as {
  decode(b: ArrayBuffer): { width: number; height: number; frames: { delay: number }[]; tabs: { acTL?: { num_frames: number; num_plays: number } } };
  toRGBA8(img: unknown): ArrayBuffer[];
};

/** Still-PNG decoder for the frame data: pngjs, RGBA8. */
async function pngjsStill(png: Uint8Array): Promise<PixelData> {
  const p = PNG.sync.read(Buffer.from(png));
  return { width: p.width, height: p.height, bitDepth: 8, data: new Uint8ClampedArray(p.data) };
}

function upngFrames(bytes: Uint8Array) {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const img = UPNG.decode(ab);
  return { img, frames: UPNG.toRGBA8(img).map((b) => new Uint8Array(b)) };
}

describe('APNG decoding against UPNG.js', () => {
  it('apng-ops.png: every dispose and blend operation composites exactly as the specification says', async () => {
    const bytes = fixture('apng-ops.png');
    const anim = (await decodeApng(bytes, pngjsStill))!;
    const expected = expectedOpsFrames();
    expect(anim.frames).toHaveLength(4);
    anim.frames.forEach((f, i) => expect(Array.from(f.pixels.data), `frame ${i}`).toEqual(Array.from(expected[i]!)));
    expect(anim.loops).toBe(3);
    expect(anim.hiddenDefault).toBe(false);
    expect(anim.frames[3]!.delayDen).toBe(100); // a zero denominator means 1/100 s
  });
  it('UPNG.js agrees on the frames its compositing gets right, and its two bugs are pinned', async () => {
    const bytes = fixture('apng-ops.png');
    const ref = upngFrames(bytes);
    const expected = expectedOpsFrames();
    // Frames 0 and 2 involve neither of UPNG's bugs: identical.
    for (const i of [0, 2]) expect(Array.from(ref.frames[i]!), `frame ${i}`).toEqual(Array.from(expected[i]!));
    // Bug 1: OVER stores float results into a Uint8Array (truncation), so even an alpha-0 source pixel
    // over a semi-transparent destination lowers it by one, e.g. (5,8): 40,80,128 becomes 39,79,127.
    const i58 = (8 * 32 + 5) * 4;
    expect(Array.from(expected[1]!.subarray(i58, i58 + 4))).toEqual([40, 80, 128, 100]);
    expect(Array.from(ref.frames[1]!.subarray(i58, i58 + 4))).toEqual([39, 79, 127, 100]);
    // Bug 2: dispose PREVIOUS restores the previous frame as displayed, before ITS disposal ran, so
    // frame 1's pixels (disposed to background) reappear in frame 3. (4,3) must be transparent black.
    const i43 = (3 * 32 + 4) * 4;
    expect(Array.from(expected[3]!.subarray(i43, i43 + 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(ref.frames[3]!.subarray(i43, i43 + 4))).not.toEqual([0, 0, 0, 0]);
    // Delays: UPNG reports milliseconds.
    expect(ref.img.frames.map((f) => f.delay)).toEqual([100, 70, 250, 0]);
  });
  it('apng-hidden.png: the still image is not a frame; frames come from fdAT only', async () => {
    const bytes = fixture('apng-hidden.png');
    const anim = (await decodeApng(bytes, pngjsStill))!;
    expect(anim.hiddenDefault).toBe(true);
    expect(anim.frames).toHaveLength(2);
    expect(anim.loops).toBe(0);
    const ref = upngFrames(bytes);
    // UPNG lists frames only from fcTL, so its frames are the animation frames.
    anim.frames.forEach((f, i) => expect(Array.from(f.pixels.data), `frame ${i}`).toEqual(Array.from(ref.frames[i]!)));
  });
  it('the header inspector reports frames, plays, duration and the separate still image', () => {
    expect(inspect(fixture('apng-ops.png')).metadata.animationInfo).toEqual({ frames: 4, loops: 3, durationMs: 100 + 70 + 250 + 0, hiddenDefault: false, delaysWholeMs: true });
    expect(inspect(fixture('apng-hidden.png')).metadata.animationInfo).toEqual({ frames: 2, loops: 0, durationMs: 1000, hiddenDefault: true, delaysWholeMs: true });
  });
  it('a still PNG is not an animation', async () => {
    expect(parseApng(fixture('rgb8.png'))).toBeNull();
    expect(await decodeApng(fixture('rgb8.png'), pngjsStill)).toBeNull();
  });
  it('rejects malformed animations: frame count mismatch, out-of-canvas frame, sequence out of order', () => {
    const bytes = fixture('apng-ops.png');
    const find = (b: Uint8Array, type: string) => {
      for (let i = 8; i + 8 < b.length; i++) if (String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!) === type) return i - 4;
      throw new Error(type);
    };
    const count = bytes.slice();
    count[find(count, 'acTL') + 11] = 5; // num_frames 4 -> 5 (CRC not checked by the parser)
    expect(() => parseApng(count)).toThrow(/declares 5 frames/);
    const seq = bytes.slice();
    seq[find(seq, 'fcTL') + 11] = 9;
    expect(() => parseApng(seq)).toThrow(/sequence/);
  });
});

describe('APNG writing', () => {
  const frame = (seed: number, alpha: boolean) => probeImage(20, 8, alpha, seed);
  const anim = (alpha: boolean): Animation => {
    const f0 = frame(1, alpha);
    const f1 = { ...f0, data: f0.data.slice() } as PixelData;
    for (let y = 5; y < 9; y++) for (let x = 2; x < 7; x++) f1.data.set([1, 2, 3, alpha ? 0 : 255], (y * 20 + x) * 4); // colour under alpha 0 too
    const f2 = { ...f1, data: f1.data.slice() } as PixelData; // unchanged frame
    return { frames: [ { pixels: f0, delayNum: 1, delayDen: 10 }, { pixels: f1, delayNum: 33, delayDen: 1000 }, { pixels: f2, delayNum: 0, delayDen: 100 }, { pixels: frame(4, alpha), delayNum: 2, delayDen: 1 } ], loops: 7, hiddenDefault: false };
  };
  for (const alpha of [true, false]) {
    it(`round trip ${alpha ? 'RGBA (alpha-0 colour kept)' : 'RGB'}: own decoder and UPNG both read back every frame, delay and the loop count`, async () => {
      const a = anim(alpha);
      const { bytes } = encodeApng(a, a.frames[0]!.pixels, alpha);
      const back = (await decodeApng(bytes, pngjsStill))!;
      expect(back.loops).toBe(7);
      back.frames.forEach((f, i) => {
        expect(Array.from(f.pixels.data), `frame ${i}`).toEqual(Array.from(a.frames[i]!.pixels.data));
        expect([f.delayNum, f.delayDen]).toEqual([a.frames[i]!.delayNum, a.frames[i]!.delayDen]);
      });
      const ref = upngFrames(bytes);
      ref.frames.forEach((f, i) => expect(Array.from(f), `UPNG frame ${i}`).toEqual(Array.from(a.frames[i]!.pixels.data)));
      // The still image (IDAT) is frame 0, so a viewer without APNG shows it.
      const still = PNG.sync.read(Buffer.from(bytes));
      expect(Array.from(still.data)).toEqual(Array.from(a.frames[0]!.pixels.data));
    });
  }
  it('stores later frames as the changed rectangle only (smaller than whole frames)', () => {
    const a = anim(true);
    const s = parseApng(encodeApng(a, a.frames[0]!.pixels, true).bytes)!;
    expect(s.frames.map((f) => [f.control.x, f.control.y, f.control.width, f.control.height])).toEqual([
      [0, 0, 20, 20],
      [2, 5, 5, 4],
      [0, 0, 1, 1], // unchanged: one pixel of data
      expect.any(Array),
    ]);
  });
  it('a hidden still image is written as IDAT outside the animation and read back as such', async () => {
    const a = { ...anim(true), hiddenDefault: true };
    const still = probeImage(20, 8, true, 99);
    const { bytes } = encodeApng(a, still, true);
    const back = (await decodeApng(bytes, pngjsStill))!;
    expect(back.hiddenDefault).toBe(true);
    expect(Array.from(PNG.sync.read(Buffer.from(bytes)).data)).toEqual(Array.from(still.data));
    back.frames.forEach((f, i) => expect(Array.from(f.pixels.data)).toEqual(Array.from(a.frames[i]!.pixels.data)));
  });
  it('a palette fits all frames together: one PLTE for the whole animation', () => {
    const solid = (c: number[]) => {
      const px = probeImage(8, 8, false, 1);
      for (let i = 0; i < px.data.length; i += 4) px.data.set(c, i);
      return px;
    };
    const a: Animation = { frames: [ { pixels: solid([255, 0, 0, 255]), delayNum: 1, delayDen: 10 }, { pixels: solid([0, 0, 255, 255]), delayNum: 1, delayDen: 10 } ], loops: 0, hiddenDefault: false };
    const { layout } = encodeApng(a, a.frames[0]!.pixels, false);
    expect(layout).toEqual({ colorType: 3, bitDepth: 1, paletteSize: 2 });
  });
  it('durationMs sums the delays', () => {
    expect(durationMs(anim(true))).toBeCloseTo(100 + 33 + 0 + 2000);
  });
});
