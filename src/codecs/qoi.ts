/**
 * QOI ("Quite OK Image" format, https://qoiformat.org/qoi-specification.pdf),
 * encoder and decoder written by Airgap from the specification. Pure
 * TypeScript, no wasm. QOI is lossless 8-bit RGB or RGBA and stores alpha
 * straight, so RGB under alpha 0 survives exactly. It carries no metadata.
 * Tested against @jsquash/qoi (the reference C implementation compiled to
 * wasm, a dev dependency only) in tests/unit/qoi.test.ts.
 */
import { alphaStats } from '../pixels';
import type { Codec, DecodedImage, ImageMetadata } from './types';

const MAGIC = [0x71, 0x6f, 0x69, 0x66]; // "qoif"
const OP_INDEX = 0x00; // 00xxxxxx
const OP_DIFF = 0x40; // 01xxxxxx
const OP_LUMA = 0x80; // 10xxxxxx
const OP_RUN = 0xc0; // 11xxxxxx
const OP_RGB = 0xfe;
const OP_RGBA = 0xff;
const END = [0, 0, 0, 0, 0, 0, 0, 1];
/** The specification caps the pixel count to keep decoders safe. */
export const QOI_PIXELS_MAX = 400_000_000;

const hash = (r: number, g: number, b: number, a: number) => (r * 3 + g * 5 + b * 7 + a * 11) % 64;

export interface QoiHeader {
  width: number;
  height: number;
  channels: 3 | 4;
  /** 0: sRGB with linear alpha, 1: all channels linear. */
  colorspace: 0 | 1;
}

export function isQoi(b: Uint8Array): boolean {
  return b.length >= 14 && MAGIC.every((v, i) => b[i] === v);
}

export function readQoiHeader(b: Uint8Array): QoiHeader {
  if (!isQoi(b)) throw new Error('Not a QOI file.');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(4);
  const height = dv.getUint32(8);
  const channels = b[12]!;
  const colorspace = b[13]!;
  if (channels !== 3 && channels !== 4) throw new Error(`QOI header: ${channels} channels.`);
  if (colorspace !== 0 && colorspace !== 1) throw new Error(`QOI header: colorspace ${colorspace}.`);
  if (width === 0 || height === 0 || width * height > QOI_PIXELS_MAX) throw new Error(`QOI header: ${width} × ${height} is out of range.`);
  return { width, height, channels, colorspace };
}

/** Decodes to RGBA8. Throws on a truncated stream; trailing garbage after the end marker is ignored. */
export function decodeQoi(b: Uint8Array): { header: QoiHeader; data: Uint8ClampedArray } {
  const header = readQoiHeader(b);
  const n = header.width * header.height;
  const out = new Uint8ClampedArray(n * 4);
  const index = new Uint8Array(64 * 4);
  let r = 0;
  let g = 0;
  let bl = 0;
  let a = 255;
  let p = 14;
  const end = b.length - END.length;
  let run = 0;
  for (let px = 0; px < n; px++) {
    if (run > 0) run--;
    else {
      if (p >= end) throw new Error('QOI data is truncated.');
      const op = b[p++]!;
      if (op === OP_RGB) {
        r = b[p++]!;
        g = b[p++]!;
        bl = b[p++]!;
      } else if (op === OP_RGBA) {
        r = b[p++]!;
        g = b[p++]!;
        bl = b[p++]!;
        a = b[p++]!;
      } else {
        const tag = op & 0xc0;
        if (tag === OP_INDEX) {
          const i = (op & 63) * 4;
          r = index[i]!;
          g = index[i + 1]!;
          bl = index[i + 2]!;
          a = index[i + 3]!;
        } else if (tag === OP_DIFF) {
          r = (r + ((op >> 4) & 3) - 2) & 255;
          g = (g + ((op >> 2) & 3) - 2) & 255;
          bl = (bl + (op & 3) - 2) & 255;
        } else if (tag === OP_LUMA) {
          const second = b[p++]!;
          const dg = (op & 63) - 32;
          g = (g + dg) & 255;
          r = (r + dg - 8 + ((second >> 4) & 15)) & 255;
          bl = (bl + dg - 8 + (second & 15)) & 255;
        } else run = op & 63; // OP_RUN: this pixel plus `run` more
      }
      const h = hash(r, g, bl, a) * 4;
      index[h] = r;
      index[h + 1] = g;
      index[h + 2] = bl;
      index[h + 3] = a;
    }
    const o = px * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = bl;
    out[o + 3] = a;
  }
  return { header, data: out };
}

/** Encodes RGBA8. Writes 3 channels when every alpha is 255, 4 otherwise. */
export function encodeQoi(data: Uint8ClampedArray | Uint8Array, width: number, height: number, opts: { channels?: 3 | 4; colorspace?: 0 | 1 } = {}): Uint8Array {
  const n = width * height;
  if (data.length !== n * 4) throw new Error('QOI encoder expects RGBA8 input.');
  if (n === 0 || n > QOI_PIXELS_MAX) throw new Error(`QOI cannot store ${width} × ${height}.`);
  let channels = opts.channels;
  if (!channels) {
    channels = 3;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) (channels = 4), (i = data.length);
  }
  const out = new Uint8Array(14 + n * (channels + 1) + END.length);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, width);
  dv.setUint32(8, height);
  out[12] = channels;
  out[13] = opts.colorspace ?? 0;
  let p = 14;
  const index = new Uint8Array(64 * 4);
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 255;
  let run = 0;
  for (let px = 0; px < n; px++) {
    const o = px * 4;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    const a = data[o + 3]!;
    if (r === pr && g === pg && b === pb && a === pa) {
      run++;
      if (run === 62 || px === n - 1) {
        out[p++] = OP_RUN | (run - 1);
        run = 0;
      }
      continue;
    }
    if (run > 0) {
      out[p++] = OP_RUN | (run - 1);
      run = 0;
    }
    const h = hash(r, g, b, a);
    const hi = h * 4;
    if (index[hi] === r && index[hi + 1] === g && index[hi + 2] === b && index[hi + 3] === a) {
      out[p++] = OP_INDEX | h;
    } else {
      index[hi] = r;
      index[hi + 1] = g;
      index[hi + 2] = b;
      index[hi + 3] = a;
      if (a === pa) {
        const vr = ((r - pr + 384) & 255) - 128;
        const vg = ((g - pg + 384) & 255) - 128;
        const vb = ((b - pb + 384) & 255) - 128;
        const vgr = vr - vg;
        const vgb = vb - vg;
        if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
          out[p++] = OP_DIFF | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
        } else if (vgr > -9 && vgr < 8 && vg > -33 && vg < 32 && vgb > -9 && vgb < 8) {
          out[p++] = OP_LUMA | (vg + 32);
          out[p++] = ((vgr + 8) << 4) | (vgb + 8);
        } else {
          out[p++] = OP_RGB;
          out[p++] = r;
          out[p++] = g;
          out[p++] = b;
        }
      } else {
        out[p++] = OP_RGBA;
        out[p++] = r;
        out[p++] = g;
        out[p++] = b;
        out[p++] = a;
      }
    }
    pr = r;
    pg = g;
    pb = b;
    pa = a;
  }
  out.set(END, p);
  p += END.length;
  return out.slice(0, p);
}

function metadataFor(header: QoiHeader, pixels: DecodedImage['pixels']): ImageMetadata {
  const hasAlpha = header.channels === 4;
  return {
    bitDepth: 8,
    hasAlpha,
    ...(hasAlpha ? alphaStats(pixels) : { hasTransparency: false, hasSemiTransparency: false }),
    hasExif: false,
    hasGps: false,
    hasIcc: false,
    hasXmp: false,
    isAnimated: false,
    sourceLossless: true,
    colorLayout: `${hasAlpha ? 'RGBA' : 'RGB'}, 8-bit${header.colorspace === 1 ? ', linear' : ''}`,
    // colorspace 1 declares linear channels: viewers that assume sRGB will show it too dark.
    ...(header.colorspace === 1 && { colorDescription: { primaries: 1, transfer: 8 } }),
  };
}

export function createQoiCodec(): Codec {
  return {
    id: 'airgap-qoi',
    format: 'qoi',
    capabilities: {
      decode: true,
      encode: true,
      lossless: true,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 8,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [8],
      metadata: { exif: false, icc: false, xmp: false },
    },
    async decode(bytes) {
      const { header, data } = decodeQoi(bytes);
      const pixels = { width: header.width, height: header.height, bitDepth: 8, data };
      return { pixels, metadata: metadataFor(header, pixels) };
    },
    async encode(img) {
      const px = img.pixels;
      if (px.bitDepth !== 8) throw new Error('QOI stores 8-bit samples only.');
      return encodeQoi(px.data as Uint8ClampedArray, px.width, px.height);
    },
  };
}
