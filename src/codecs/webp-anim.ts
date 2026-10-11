/**
 * Animated WebP, read and written by Airgap from the container specification
 * (https://developers.google.com/speed/webp/docs/riff_container). The frames'
 * bitstreams (VP8 with optional ALPH, or VP8L) are decoded and encoded by the
 * libwebp still codec; the container, the canvas and the compositing are here.
 *
 * Compositing follows libwebp's own WebPAnimDecoder (src/demux/anim_decode.c),
 * the reference: the canvas starts transparent black (the ANIM background colour
 * is a hint that libwebp ignores, as do browsers), "dispose to background"
 * clears the frame rectangle to transparent black, and alpha blending uses
 * libwebp's exact integer formula (BlendPixelNonPremult), so a decoded frame
 * matches libwebp sample for sample.
 *
 * Writing: frame 0 whole, each later frame as the changed bounding box rounded
 * out to even offsets (the format stores X/2 and Y/2), "do not blend" and "do
 * not dispose", so every frame is reproduced with no blending arithmetic.
 * Durations are whole milliseconds; a delay that is not a whole number of
 * milliseconds is rounded and the loss list says so.
 */
import { concat } from '../metadata/tiff-ifd';
import { allocate } from '../pixels';
import type { Animation, AnimationFrame, PixelData } from './types';

interface Chunk {
  type: string;
  data: Uint8Array;
}

const ascii = (b: Uint8Array, o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
const u24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

function riffChunks(b: Uint8Array, start: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  let off = start;
  while (off + 8 <= end) {
    const type = ascii(b, off);
    const len = (b[off + 4]! | (b[off + 5]! << 8) | (b[off + 6]! << 16) | (b[off + 7]! << 24)) >>> 0;
    if (off + 8 + len > end) throw new Error(`WebP: chunk ${type} is truncated.`);
    out.push({ type, data: b.subarray(off + 8, off + 8 + len) });
    off += 8 + len + (len & 1);
  }
  return out;
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(new TextEncoder().encode(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function riff(chunks: Uint8Array[]): Uint8Array {
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(new TextEncoder().encode('WEBP'), 8);
  return concat([head, body]);
}

export interface WebpFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  durationMs: number;
  /** blending method bit clear: alpha-blend onto the canvas. */
  blend: boolean;
  /** disposal bit set: clear the rectangle to transparent black after display. */
  disposeToBackground: boolean;
  /** ALPH (optional) + VP8, or VP8L, as raw chunks. */
  bitstream: Chunk[];
}

export interface WebpAnimation {
  width: number;
  height: number;
  loops: number;
  frames: WebpFrame[];
}

export function isAnimatedWebp(b: Uint8Array): boolean {
  if (b.length < 30 || ascii(b, 0) !== 'RIFF' || ascii(b, 8) !== 'WEBP' || ascii(b, 12) !== 'VP8X') return false;
  return (b[20]! & 0x02) !== 0;
}

/** Null for a still WebP. Throws on a malformed animation. */
export function parseAnimatedWebp(b: Uint8Array): WebpAnimation | null {
  if (!isAnimatedWebp(b)) return null;
  const chunks = riffChunks(b, 12, Math.min(b.length, 8 + ((b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) >>> 0)));
  const vp8x = chunks[0]!.data;
  const width = u24(vp8x, 4) + 1;
  const height = u24(vp8x, 7) + 1;
  const anim = chunks.find((c) => c.type === 'ANIM');
  if (!anim || anim.data.length < 6) throw new Error('WebP: animated file without an ANIM chunk.');
  const loops = anim.data[4]! | (anim.data[5]! << 8);
  const frames: WebpFrame[] = [];
  for (const c of chunks) {
    if (c.type !== 'ANMF') continue;
    const d = c.data;
    if (d.length < 16) throw new Error('WebP: truncated ANMF.');
    const f: WebpFrame = {
      x: u24(d, 0) * 2,
      y: u24(d, 3) * 2,
      width: u24(d, 6) + 1,
      height: u24(d, 9) + 1,
      durationMs: u24(d, 12),
      blend: (d[15]! & 0x02) === 0,
      disposeToBackground: (d[15]! & 0x01) !== 0,
      bitstream: riffChunks(d, 16, d.length).filter((x) => x.type === 'ALPH' || x.type === 'VP8 ' || x.type === 'VP8L'),
    };
    if (f.x + f.width > width || f.y + f.height > height) throw new Error('WebP: a frame lies outside the canvas.');
    if (!f.bitstream.some((x) => x.type === 'VP8 ' || x.type === 'VP8L')) throw new Error('WebP: a frame has no bitstream.');
    frames.push(f);
  }
  if (frames.length === 0) throw new Error('WebP: animation without frames.');
  return { width, height, loops, frames };
}

/** A standalone still WebP for one frame's bitstream (VP8X only when an ALPH chunk needs it). */
export function frameWebp(f: Pick<WebpFrame, 'width' | 'height' | 'bitstream'>): Uint8Array {
  const hasAlph = f.bitstream.some((c) => c.type === 'ALPH');
  const parts: Uint8Array[] = [];
  if (hasAlph) {
    const x = new Uint8Array(10);
    x[0] = 0x10;
    const w = f.width - 1;
    const h = f.height - 1;
    x.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 4);
    parts.push(riffChunk('VP8X', x));
  }
  for (const c of f.bitstream) parts.push(riffChunk(c.type, c.data));
  return riff(parts);
}

/**
 * libwebp's BlendPixelRowNonPremult + BlendPixelNonPremult (anim_decode.c), exactly: an opaque
 * source pixel is copied (the row blender skips it; the formula alone would give 254 for 255),
 * a fully transparent one leaves the destination, anything else uses the integer formula.
 */
export function blendNonPremult(src: Uint8ClampedArray | Uint8Array, si: number, dst: Uint8ClampedArray | Uint8Array, di: number): void {
  const srcA = src[si + 3]!;
  if (srcA === 255) {
    dst[di] = src[si]!;
    dst[di + 1] = src[si + 1]!;
    dst[di + 2] = src[si + 2]!;
    dst[di + 3] = 255;
    return;
  }
  if (srcA === 0) return;
  const dstA = dst[di + 3]!;
  const dstFactorA = (dstA * (256 - srcA)) >> 8;
  const blendA = (srcA + dstFactorA) & 255;
  const scale = Math.floor((1 << 24) / blendA);
  for (let c = 0; c < 3; c++) {
    const blendUnscaled = src[si + c]! * srcA + dst[di + c]! * dstFactorA;
    // In libwebp this is a uint32 product (it asserts no overflow); doubles hold it exactly.
    dst[di + c] = Math.floor((blendUnscaled * scale) / 16777216) & 255;
  }
  dst[di + 3] = blendA;
}

/** Decodes and composites every frame (8-bit RGBA, whole canvas, as libwebp displays it). */
export async function decodeAnimatedWebp(b: Uint8Array, decodeStill: (webp: Uint8Array) => Promise<PixelData>): Promise<Animation | null> {
  const s = parseAnimatedWebp(b);
  if (!s) return null;
  const canvas = allocate(s.width, s.height, 8);
  const frames: AnimationFrame[] = [];
  let pendingDispose: WebpFrame | null = null;
  for (const f of s.frames) {
    if (pendingDispose) {
      const p = pendingDispose;
      for (let y = 0; y < p.height; y++) canvas.data.fill(0, ((p.y + y) * s.width + p.x) * 4, ((p.y + y) * s.width + p.x + p.width) * 4);
    }
    const px = await decodeStill(frameWebp(f));
    if (px.width !== f.width || px.height !== f.height || px.bitDepth !== 8) throw new Error('WebP: a frame decoded to an unexpected size.');
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const si = (y * f.width + x) * 4;
        const di = ((f.y + y) * s.width + f.x + x) * 4;
        if (f.blend) blendNonPremult(px.data as Uint8ClampedArray, si, canvas.data as Uint8ClampedArray, di);
        else canvas.data.set(px.data.subarray(si, si + 4), di);
      }
    }
    frames.push({ pixels: { ...canvas, data: canvas.data.slice() } as PixelData, delayNum: f.durationMs, delayDen: 1000 });
    pendingDispose = f.disposeToBackground ? f : null;
  }
  return { frames, loops: s.loops, hiddenDefault: false };
}

/** Milliseconds for an APNG-style delay, rounded to the nearest whole millisecond (24-bit field). */
export function delayToMs(f: Pick<AnimationFrame, 'delayNum' | 'delayDen'>): number {
  return Math.min(0xffffff, Math.round((1000 * f.delayNum) / (f.delayDen || 100)));
}

/** True when every delay is a whole number of milliseconds (WebP stores no finer timing). */
export function delaysFitMs(frames: Pick<AnimationFrame, 'delayNum' | 'delayDen'>[]): boolean {
  return frames.every((f) => (1000 * f.delayNum) % (f.delayDen || 100) === 0);
}

function changedBox(a: PixelData, b: PixelData): { x: number; y: number; width: number; height: number } | null {
  let x0 = a.width;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function crop(px: PixelData, x0: number, y0: number, w: number, h: number): PixelData {
  const out = allocate(w, h, 8);
  for (let y = 0; y < h; y++) out.data.set(px.data.subarray(((y0 + y) * px.width + x0) * 4, ((y0 + y) * px.width + x0 + w) * 4), y * w * 4);
  return out;
}

/**
 * Writes an animated WebP whose composited frames are `anim.frames` (8-bit). `encodeStill`
 * produces a still WebP for a rectangle of pixels with the requested lossless/quality settings;
 * its bitstream chunks become the frame. Loop count is clamped to 16 bits (0 = forever).
 */
export async function encodeAnimatedWebp(anim: Animation, encodeStill: (px: PixelData) => Promise<Uint8Array>, hasAlpha: boolean): Promise<Uint8Array> {
  const frames = anim.frames;
  if (frames.length === 0) throw new Error('Animated WebP needs at least one frame.');
  const { width, height } = frames[0]!.pixels;
  const anmfs: Uint8Array[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.pixels.width !== width || f.pixels.height !== height || f.pixels.bitDepth !== 8) throw new Error('Animated WebP frames must be 8-bit and match the canvas.');
    let box = i === 0 ? { x: 0, y: 0, width, height } : (changedBox(frames[i - 1]!.pixels, f.pixels) ?? { x: 0, y: 0, width: 1, height: 1 });
    // Offsets are stored halved: round the rectangle out to even coordinates.
    const x = box.x & ~1;
    const y = box.y & ~1;
    box = { x, y, width: box.x + box.width - x, height: box.y + box.height - y };
    const still = await encodeStill(crop(f.pixels, box.x, box.y, box.width, box.height));
    const bitstream = riffChunks(still, 12, still.length).filter((c) => c.type === 'ALPH' || c.type === 'VP8 ' || c.type === 'VP8L');
    const head = new Uint8Array(16);
    const put24 = (o: number, v: number) => head.set([v & 255, (v >> 8) & 255, (v >> 16) & 255], o);
    put24(0, box.x / 2);
    put24(3, box.y / 2);
    put24(6, box.width - 1);
    put24(9, box.height - 1);
    put24(12, delayToMs(f));
    head[15] = 0x02; // do not blend, do not dispose
    anmfs.push(riffChunk('ANMF', concat([head, ...bitstream.map((c) => riffChunk(c.type, c.data))])));
  }
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02 | (hasAlpha ? 0x10 : 0);
  const w = width - 1;
  const h = height - 1;
  vp8x.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 4);
  const animChunk = new Uint8Array(6); // background colour 0 (transparent black), loop count
  animChunk[4] = Math.min(0xffff, anim.loops) & 255;
  animChunk[5] = Math.min(0xffff, anim.loops) >> 8;
  return riff([riffChunk('VP8X', vp8x), riffChunk('ANIM', animChunk), ...anmfs]);
}
