/**
 * APNG (animated PNG), read and written by Airgap from the specification
 * (https://wiki.mozilla.org/APNG_Specification, now part of PNG Third Edition).
 * Pure: the per-frame zlib/filter decoding is delegated to an injected still-PNG
 * decoder (the Rust `png` crate in the app), everything else is here.
 *
 * Reading composites every frame onto the canvas exactly as the specification
 * says (dispose_op NONE / BACKGROUND / PREVIOUS, blend_op SOURCE / OVER), so a
 * frame is what a viewer shows at that moment. Writing stores frame 0 whole and
 * each later frame as the bounding box of what changed, with dispose NONE and
 * blend SOURCE: every composited frame is reproduced exactly, with no blending
 * arithmetic involved.
 */
import { pngChunk } from '../metadata/containers';
import { concat } from '../metadata/tiff-ifd';
import { allocate, maxValue } from '../pixels';
import { analyzeImages, encodeImageData, headerChunks, layoutOf, PNG_SIGNATURE, type PngLayout } from './png-writer';
import type { Animation, AnimationFrame, PixelData } from './types';

export const DISPOSE_NONE = 0;
export const DISPOSE_BACKGROUND = 1;
export const DISPOSE_PREVIOUS = 2;
export const BLEND_SOURCE = 0;
export const BLEND_OVER = 1;

interface Chunk {
  type: string;
  data: Uint8Array;
}

function chunks(b: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  while (off + 8 <= b.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!);
    if (off + 12 + len > b.length) throw new Error(`APNG: chunk ${type} is truncated.`);
    out.push({ type, data: b.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

export interface FrameControl {
  width: number;
  height: number;
  x: number;
  y: number;
  delayNum: number;
  delayDen: number;
  dispose: number;
  blend: number;
}

export interface ApngStructure {
  width: number;
  height: number;
  numFrames: number;
  /** 0 = loop forever. */
  plays: number;
  /** The IDAT image is not part of the animation (no fcTL before IDAT). */
  hiddenDefault: boolean;
  frames: { control: FrameControl; data: Uint8Array[] }[];
}

/** Null for a still PNG (no acTL). Throws on a malformed animation. */
export function parseApng(b: Uint8Array): ApngStructure | null {
  const cs = chunks(b);
  const actl = cs.find((c) => c.type === 'acTL');
  if (!actl) return null;
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('APNG: no IHDR.');
  const dvI = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = dvI.getUint32(0);
  const height = dvI.getUint32(4);
  const dvA = new DataView(actl.data.buffer, actl.data.byteOffset, actl.data.byteLength);
  const numFrames = dvA.getUint32(0);
  const plays = dvA.getUint32(4);
  const frames: ApngStructure['frames'] = [];
  let sawIdat = false;
  let hiddenDefault = true;
  let current: ApngStructure['frames'][number] | null = null;
  let expectSeq = 0;
  for (const c of cs) {
    if (c.type === 'fcTL') {
      const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
      if (dv.getUint32(0) !== expectSeq++) throw new Error('APNG: sequence numbers out of order.');
      const control: FrameControl = {
        width: dv.getUint32(4),
        height: dv.getUint32(8),
        x: dv.getUint32(12),
        y: dv.getUint32(16),
        delayNum: dv.getUint16(20),
        delayDen: dv.getUint16(22),
        dispose: c.data[24]!,
        blend: c.data[25]!,
      };
      if (control.width === 0 || control.height === 0 || control.x + control.width > width || control.y + control.height > height) throw new Error('APNG: a frame lies outside the canvas.');
      if (control.dispose > 2 || control.blend > 1) throw new Error('APNG: unknown dispose or blend operation.');
      if (!sawIdat) {
        hiddenDefault = false;
        if (control.x !== 0 || control.y !== 0 || control.width !== width || control.height !== height) throw new Error('APNG: the first frame must cover the canvas.');
      }
      current = { control, data: [] };
      frames.push(current);
    } else if (c.type === 'IDAT') {
      sawIdat = true;
      if (current && frames.length === 1 && !hiddenDefault) current.data.push(c.data);
    } else if (c.type === 'fdAT') {
      const dv = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
      if (dv.getUint32(0) !== expectSeq++) throw new Error('APNG: sequence numbers out of order.');
      if (!current) throw new Error('APNG: fdAT before any fcTL.');
      current.data.push(c.data.subarray(4));
    }
  }
  if (frames.length !== numFrames) throw new Error(`APNG: acTL declares ${numFrames} frames, the file has ${frames.length}.`);
  if (frames.some((f) => f.data.length === 0)) throw new Error('APNG: a frame has no image data.');
  return { width, height, numFrames, plays, hiddenDefault, frames };
}

/** A standalone PNG for one frame: the original header chunks with the frame's size, and its data as IDAT. */
function framePng(b: Uint8Array, f: { control: FrameControl; data: Uint8Array[] }): Uint8Array {
  const out: Uint8Array[] = [PNG_SIGNATURE];
  for (const c of chunks(b)) {
    if (c.type === 'IHDR') {
      const d = c.data.slice();
      const dv = new DataView(d.buffer);
      dv.setUint32(0, f.control.width);
      dv.setUint32(4, f.control.height);
      out.push(pngChunk('IHDR', d));
    } else if (c.type === 'PLTE' || c.type === 'tRNS') out.push(pngChunk(c.type, c.data));
  }
  out.push(pngChunk('IDAT', concat(f.data)), pngChunk('IEND', new Uint8Array(0)));
  return concat(out);
}

/** Composites `src` over `dst` at (x, y), straight alpha, any depth. Rounds to nearest. */
function blendOver(dst: PixelData, src: PixelData, x0: number, y0: number): void {
  const max = maxValue(dst.bitDepth);
  const d = dst.data;
  const s = src.data;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = ((y0 + y) * dst.width + x0 + x) * 4;
      const as = s[si + 3]!;
      if (as === max) {
        d[di] = s[si]!;
        d[di + 1] = s[si + 1]!;
        d[di + 2] = s[si + 2]!;
        d[di + 3] = max;
        continue;
      }
      if (as === 0) continue;
      const ad = d[di + 3]!;
      const fs = as / max;
      const fd = (ad / max) * (1 - fs);
      const ao = fs + fd;
      for (let c = 0; c < 3; c++) d[di + c] = Math.round((s[si + c]! * fs + d[di + c]! * fd) / ao);
      d[di + 3] = Math.round(ao * max);
    }
  }
}

function copyRect(dst: PixelData, src: PixelData, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    const from = y * src.width * 4;
    dst.data.set(src.data.subarray(from, from + src.width * 4), ((y0 + y) * dst.width + x0) * 4);
  }
}

function clearRect(dst: PixelData, x0: number, y0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) dst.data.fill(0, ((y0 + y) * dst.width + x0) * 4, ((y0 + y) * dst.width + x0 + w) * 4);
}

function cloneRect(src: PixelData, x0: number, y0: number, w: number, h: number): PixelData {
  const out = allocate(w, h, src.bitDepth);
  for (let y = 0; y < h; y++) out.data.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + w) * 4), y * w * 4);
  return out;
}

/**
 * Decodes and composites every frame. `decodeStill` turns a standalone PNG into pixels (8 or
 * 16-bit RGBA). Frames are returned whole-canvas, as displayed.
 */
export async function decodeApng(b: Uint8Array, decodeStill: (png: Uint8Array) => Promise<PixelData>): Promise<Animation | null> {
  const s = parseApng(b);
  if (!s) return null;
  const decoded: PixelData[] = [];
  for (const f of s.frames) decoded.push(await decodeStill(framePng(b, f)));
  const depth = decoded[0]!.bitDepth;
  const canvas = allocate(s.width, s.height, depth); // fully transparent black, as the spec says
  const frames: AnimationFrame[] = [];
  s.frames.forEach((f, i) => {
    const c = f.control;
    const px = decoded[i]!;
    if (px.bitDepth !== depth || px.width !== c.width || px.height !== c.height) throw new Error('APNG: a frame decoded to an unexpected size or depth.');
    // dispose PREVIOUS on the first frame is treated as BACKGROUND.
    const dispose = i === 0 && c.dispose === DISPOSE_PREVIOUS ? DISPOSE_BACKGROUND : c.dispose;
    const saved = dispose === DISPOSE_PREVIOUS ? cloneRect(canvas, c.x, c.y, c.width, c.height) : null;
    if (c.blend === BLEND_SOURCE) copyRect(canvas, px, c.x, c.y);
    else blendOver(canvas, px, c.x, c.y);
    frames.push({ pixels: { ...canvas, data: canvas.data.slice() } as PixelData, delayNum: c.delayNum, delayDen: c.delayDen === 0 ? 100 : c.delayDen });
    if (dispose === DISPOSE_BACKGROUND) clearRect(canvas, c.x, c.y, c.width, c.height);
    else if (saved) copyRect(canvas, saved, c.x, c.y);
  });
  return { frames, loops: s.plays, hiddenDefault: s.hiddenDefault };
}

/** Bounding box of pixels that differ between two same-size images, or null when identical. */
function changedBox(a: PixelData, b: PixelData): { x: number; y: number; width: number; height: number } | null {
  let x0 = a.width;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  const da = a.data;
  const db = b.data;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2] || da[i + 3] !== db[i + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

function fctl(seq: number, w: number, h: number, x: number, y: number, f: AnimationFrame): Uint8Array {
  const d = new Uint8Array(26);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, seq);
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  dv.setUint32(12, x);
  dv.setUint32(16, y);
  dv.setUint16(20, f.delayNum);
  dv.setUint16(22, f.delayDen);
  d[24] = DISPOSE_NONE;
  d[25] = BLEND_SOURCE;
  return pngChunk('fcTL', d);
}

/**
 * Writes an APNG whose composited frames are exactly `anim.frames`. `defaultImage` is the
 * IDAT image: when `anim.hiddenDefault` it is stored outside the animation, otherwise it must
 * equal frame 0. One layout (the smallest exact one) is chosen across all images.
 */
export function encodeApng(anim: Animation, defaultImage: PixelData, hasAlpha: boolean): { bytes: Uint8Array; layout: PngLayout } {
  const frames = anim.frames;
  if (frames.length === 0) throw new Error('APNG needs at least one frame.');
  const { width, height, bitDepth } = defaultImage;
  for (const f of frames) {
    if (f.pixels.width !== width || f.pixels.height !== height || f.pixels.bitDepth !== bitDepth) throw new Error('APNG frames must match the canvas size and depth.');
    if (f.delayNum > 0xffff || f.delayDen > 0xffff) throw new Error('APNG frame delay out of range.');
  }
  const images = anim.hiddenDefault ? [defaultImage, ...frames.map((f) => f.pixels)] : frames.map((f) => f.pixels);
  const a = analyzeImages(images, hasAlpha);
  const actl = new Uint8Array(8);
  new DataView(actl.buffer).setUint32(0, frames.length);
  new DataView(actl.buffer).setUint32(4, anim.loops);
  const out: Uint8Array[] = [PNG_SIGNATURE, ...headerChunks(width, height, a), pngChunk('acTL', actl)];
  let seq = 0;
  const fdat = (data: Uint8Array) => {
    const d = new Uint8Array(4 + data.length);
    new DataView(d.buffer).setUint32(0, seq++);
    d.set(data, 4);
    return pngChunk('fdAT', d);
  };
  if (anim.hiddenDefault) out.push(pngChunk('IDAT', encodeImageData(defaultImage, a)));
  frames.forEach((f, i) => {
    if (i === 0) {
      out.push(fctl(seq++, width, height, 0, 0, f));
      const data = encodeImageData(f.pixels, a);
      out.push(anim.hiddenDefault ? fdat(data) : pngChunk('IDAT', data));
      return;
    }
    // Only the changed region; an unchanged frame still needs one pixel of data.
    const box = changedBox(frames[i - 1]!.pixels, f.pixels) ?? { x: 0, y: 0, width: 1, height: 1 };
    out.push(fctl(seq++, box.width, box.height, box.x, box.y, f));
    out.push(fdat(encodeImageData(cloneRect(f.pixels, box.x, box.y, box.width, box.height), a)));
  });
  out.push(pngChunk('IEND', new Uint8Array(0)));
  return { bytes: concat(out), layout: layoutOf(a) };
}

/** Total duration of one loop, in milliseconds. */
export function durationMs(anim: Pick<Animation, 'frames'>): number {
  return anim.frames.reduce((t, f) => t + (1000 * f.delayNum) / (f.delayDen || 100), 0);
}
