/**
 * HEIC, read only, through the browser's or the operating system's OWN licensed HEVC decoder.
 * Airgap ships no HEVC code: HEVC is covered by patent pools that license per implementation,
 * and the usual open-source decoder (libde265) is LGPL. Two paths, tried in order:
 *
 *  1. the browser's image decoder (createImageBitmap on the file): Safari decodes HEIC itself;
 *  2. WebCodecs VideoDecoder: Airgap reads the HEIF container (heif.ts) and hands each coded
 *     HEVC tile to the platform's video decoder (Chrome and Edge where the OS provides one, and
 *     Safari), then assembles the grid, applies the alpha plane, rotation and mirroring.
 *
 * Neither can be cross-checked by an independent decoder, so the codec declares decodeExact false
 * and every HEIC source carries the decoder-unverified loss. Output is 8-bit through a canvas,
 * so alpha is not exact either. HEIC is never offered as a target.
 */
import { inspect } from '../inspect';
import { alphaStats } from '../pixels';
import { alphaItem, gridLayout, heifMetadata, parseHeif, prop, transformsOf, type HeifFile, type HeifItem } from './heif';
import type { Codec, DecodedImage, PixelData } from './types';
import { iccFacts } from '../metadata/icc';

export const HEIC_UNAVAILABLE =
  "This browser has no HEIC decoder of its own. Airgap does not ship one, because HEVC is patent-encumbered; it reads HEIC only through the browser's or operating system's licensed decoder (Safari, and Chrome or Edge where the system provides HEVC decoding).";

function canvas2d(w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable.');
  return ctx;
}

/** Path 1: the browser decodes the whole file (rotation and grids are its business). */
async function viaImageDecoder(bytes: Uint8Array): Promise<PixelData> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/heic' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const ctx = canvas2d(bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: d.width, height: d.height, bitDepth: 8, data: d.data };
  } finally {
    bmp.close();
  }
}

/** RFC 6381 codec string for an HEVCDecoderConfigurationRecord, e.g. "hvc1.1.6.L93.B0". */
export function hevcCodecString(hvcC: Uint8Array): string {
  const space = (hvcC[1]! >> 6) & 3;
  const tier = (hvcC[1]! >> 5) & 1;
  const idc = hvcC[1]! & 31;
  let compat = ((hvcC[2]! << 24) | (hvcC[3]! << 16) | (hvcC[4]! << 8) | hvcC[5]!) >>> 0;
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints: string[] = [];
  for (let i = 6; i < 12; i++) constraints.push(hvcC[i]!.toString(16).toUpperCase());
  while (constraints.length && constraints[constraints.length - 1] === '0') constraints.pop();
  const level = hvcC[12]!;
  return ['hvc1', `${space ? 'ABC'[space - 1] : ''}${idc}`, (rev >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${level}`, ...constraints].join('.');
}

/** YUV->RGB as the HEIF item's colr (nclx) says: matrix coefficients and full/limited range. */
export interface YuvSignal {
  /** H.273 matrix_coefficients: 1 BT.709, 5/6 BT.601, 9 BT.2020 (non-constant luminance). */
  matrix: number;
  fullRange: boolean;
}

export function nclxOf(item: HeifItem): YuvSignal | null {
  const c = item.props.find((p) => p.type === 'colr' && String.fromCharCode(...p.data.subarray(0, 4)) === 'nclx');
  return c && c.data.length >= 11 ? { matrix: (c.data[8]! << 8) | c.data[9]!, fullRange: (c.data[10]! & 0x80) !== 0 } : null;
}

function kr_kb(matrix: number): [number, number] {
  if (matrix === 1) return [0.2126, 0.0722];
  if (matrix === 9 || matrix === 10) return [0.2627, 0.0593];
  return [0.299, 0.114]; // 5, 6 and unspecified: BT.601
}

/**
 * Converts planar YUV (I420/I422/I444, optionally 10-bit) to RGBA8 with the given signalling,
 * chroma upsampled bilinearly (chroma sited between luma samples vertically and co-sited
 * horizontally, the HEVC default). Returns null for layouts it does not handle.
 */
export async function frameToRgba(frame: VideoFrame, sig: YuvSignal): Promise<ImageData | null> {
  // TypeScript's DOM types list only the 8-bit formats; browsers also report the P10 ones.
  const fmt = (frame.format ?? '') as string;
  const deep = fmt === 'I420P10' || fmt === 'I422P10' || fmt === 'I444P10';
  const nv12 = fmt === 'NV12'; // 4:2:0 with U and V interleaved in one plane (VideoToolbox's usual output)
  const base = nv12 ? 'I420' : deep ? fmt.replace('P10', '') : fmt;
  if (base !== 'I420' && base !== 'I422' && base !== 'I444') return null;
  const w = frame.codedWidth;
  const h = frame.codedHeight;
  const sx = base === 'I444' ? 1 : 2;
  const sy = base === 'I420' ? 2 : 1;
  const cw = Math.ceil(w / sx);
  const ch = Math.ceil(h / sy);
  const buf = new Uint8Array(frame.allocationSize());
  const layout = await frame.copyTo(buf);
  const plane = (i: number) => {
    const { offset, stride } = layout[i]!;
    return deep
      ? (x: number, y: number) => buf[offset + y * stride + x * 2]! | (buf[offset + y * stride + x * 2 + 1]! << 8)
      : (x: number, y: number) => buf[offset + y * stride + x]!;
  };
  const Y = plane(0);
  const interleaved = (k: number) => {
    const { offset, stride } = layout[1]!;
    return (x: number, y: number) => buf[offset + y * stride + x * 2 + k]!;
  };
  const U = nv12 ? interleaved(0) : plane(1);
  const V = nv12 ? interleaved(1) : plane(2);
  const max = deep ? 1023 : 255;
  // The RANGE of the samples in this buffer is the frame's: a platform decoder may hand back a
  // video-range buffer for full-range coded data (measured: Chrome on macOS), and says so in
  // frame.colorSpace. The MATRIX is the container's, which HEIF makes authoritative.
  const fullRange = frame.colorSpace?.fullRange ?? sig.fullRange;
  const [kr, kb] = kr_kb(sig.matrix);
  const kg = 1 - kr - kb;
  const yOff = fullRange ? 0 : (16 * (max + 1)) / 256;
  const yScale = fullRange ? max : (219 * (max + 1)) / 256;
  const cScale = fullRange ? max : (224 * (max + 1)) / 256;
  const mid = (max + 1) / 2;
  const chroma = (P: (x: number, y: number) => number, x: number, y: number) => {
    // Position of this luma sample in chroma coordinates.
    const fx = sx === 1 ? x : x / 2;
    const fy = sy === 1 ? y : (y - 0.5) / 2;
    const x0 = Math.max(0, Math.min(cw - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(ch - 1, Math.floor(fy)));
    const x1 = Math.min(cw - 1, x0 + 1);
    const y1 = Math.min(ch - 1, y0 + 1);
    const ax = Math.max(0, Math.min(1, fx - x0));
    const ay = Math.max(0, Math.min(1, fy - y0));
    return (P(x0, y0) * (1 - ax) + P(x1, y0) * ax) * (1 - ay) + (P(x0, y1) * (1 - ax) + P(x1, y1) * ax) * ay;
  };
  const vw = frame.visibleRect?.width ?? frame.displayWidth;
  const vh = frame.visibleRect?.height ?? frame.displayHeight;
  const vx = frame.visibleRect?.x ?? 0;
  const vy = frame.visibleRect?.y ?? 0;
  const out = new ImageData(vw, vh);
  const d = out.data;
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      const X = x + vx;
      const Yy = y + vy;
      const yy = (Y(X, Yy) - yOff) / yScale;
      const pb = (chroma(U, X, Yy) - mid) / cScale;
      const pr = (chroma(V, X, Yy) - mid) / cScale;
      const r = yy + 2 * (1 - kr) * pr;
      const b = yy + 2 * (1 - kb) * pb;
      const g = (yy - kr * r - kb * b) / kg;
      const o = (y * vw + x) * 4;
      d[o] = Math.round(r * 255);
      d[o + 1] = Math.round(g * 255);
      d[o + 2] = Math.round(b * 255);
      d[o + 3] = 255;
    }
  }
  return out;
}

async function decodeHevcItem(f: HeifFile, item: HeifItem, signal: YuvSignal | null): Promise<ImageData> {
  const hvcC = prop(item, 'hvcC');
  if (!hvcC) throw new Error('HEIF: coded item without hvcC.');
  const config = { codec: hevcCodecString(hvcC.data), description: hvcC.data, optimizeForLatency: true };
  const support = await VideoDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(HEIC_UNAVAILABLE);
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const dec = new VideoDecoder({ output: (fr) => resolve(fr), error: (e) => reject(e) });
    dec.configure(config);
    dec.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: f.data(item.id) }));
    dec.flush().then(() => dec.close(), reject);
  });
  try {
    // Prefer Airgap's own YUV->RGB with the container's signalling; the decoder's own colour
    // handling follows the bitstream's VUI, which HEIF's colr overrides.
    const own = signal ? await frameToRgba(frame, signal) : null;
    if (own) return own;
    const ctx = canvas2d(frame.displayWidth, frame.displayHeight);
    ctx.drawImage(frame, 0, 0);
    return ctx.getImageData(0, 0, frame.displayWidth, frame.displayHeight);
  } finally {
    frame.close();
  }
}

/** One coded image or a grid of them, as an RGBA canvas-sized buffer. */
async function decodeImageItem(f: HeifFile, item: HeifItem): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  // The signalling lives on the image item (the grid, for grids); tiles inherit it.
  const signal = nclxOf(item) ?? { matrix: 6, fullRange: true };
  if (item.type === 'hvc1') {
    const d = await decodeHevcItem(f, item, signal);
    return { width: d.width, height: d.height, data: d.data };
  }
  if (item.type !== 'grid') throw new Error(`HEIF: primary item type '${item.type}' is not supported.`);
  const g = gridLayout(f, item);
  const out = new Uint8ClampedArray(g.width * g.height * 4);
  let tileW = 0;
  let tileH = 0;
  for (let i = 0; i < g.tiles.length; i++) {
    const tile = f.items.get(g.tiles[i]!)!;
    const t = await decodeHevcItem(f, tile, nclxOf(tile) ?? signal);
    tileW ||= t.width;
    tileH ||= t.height;
    const x0 = (i % g.columns) * tileW;
    const y0 = Math.floor(i / g.columns) * tileH;
    // Tiles may overhang the output size (it need not be a multiple of the tile size): crop.
    for (let y = 0; y < t.height && y0 + y < g.height; y++) {
      const w = Math.min(t.width, g.width - x0);
      if (w <= 0) continue;
      out.set(t.data.subarray(y * t.width * 4, (y * t.width + w) * 4), ((y0 + y) * g.width + x0) * 4);
    }
  }
  return { width: g.width, height: g.height, data: out };
}

/** irot / imir in the order the item lists them (HEIF applies transformative properties in order). */
function applyTransforms(img: { width: number; height: number; data: Uint8ClampedArray }, item: HeifItem) {
  let cur = img;
  for (const p of item.props) {
    if (p.type !== 'irot' && p.type !== 'imir') continue;
    const { width: w, height: h, data } = cur;
    if (p.type === 'imir') {
      const leftRight = (p.data[0]! & 1) === 1;
      const out = new Uint8ClampedArray(data.length);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = leftRight ? w - 1 - x : x;
          const sy = leftRight ? y : h - 1 - y;
          out.set(data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
        }
      cur = { width: w, height: h, data: out };
    } else {
      const turns = transformsOf({ ...item, props: [p] }).rotateCcw;
      for (let t = 0; t < turns; t++) {
        const W = cur.width;
        const H = cur.height;
        const src = cur.data;
        const out = new Uint8ClampedArray(src.length);
        // One quarter turn counter-clockwise: (x, y) -> (y, W - 1 - x) in a H x W image.
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const nx = y;
            const ny = W - 1 - x;
            out.set(src.subarray((y * W + x) * 4, (y * W + x) * 4 + 4), (ny * H + nx) * 4);
          }
        cur = { width: H, height: W, data: out };
      }
    }
  }
  return cur;
}

/** Path 2: WebCodecs over Airgap's own HEIF parsing. */
export async function viaWebCodecs(bytes: Uint8Array): Promise<PixelData> {
  if (typeof VideoDecoder === 'undefined') throw new Error(HEIC_UNAVAILABLE);
  const f = parseHeif(bytes);
  const primary = f.items.get(f.primaryId);
  if (!primary) throw new Error('HEIF: primary item missing.');
  const colour = await decodeImageItem(f, primary);
  const alpha = alphaItem(f, primary.id);
  if (alpha) {
    const a = await decodeImageItem(f, alpha);
    // The alpha plane is a monochrome image: its grey value is the alpha.
    if (a.width === colour.width && a.height === colour.height) for (let i = 0; i < colour.data.length; i += 4) colour.data[i + 3] = a.data[i]!;
  }
  const out = applyTransforms(colour, primary);
  return { width: out.width, height: out.height, bitDepth: 8, data: out.data };
}

export function createHeicCodec(): Codec {
  return {
    id: 'platform-heic',
    format: 'heic',
    capabilities: {
      decode: true,
      encode: false,
      lossless: false,
      alpha: true,
      exactAlpha: false,
      decodeBitDepth: 8,
      decodeExact: false,
      decodeAppliesIcc: false,
      encodeBitDepths: [],
      metadata: { exif: false, icc: false, xmp: false },
    },
    async decode(bytes): Promise<DecodedImage> {
      let pixels: PixelData | undefined;
      let path = '';
      const errors: string[] = [];
      try {
        pixels = await viaImageDecoder(bytes);
        path = "the browser's own image decoder";
      } catch (err) {
        errors.push((err as Error).message);
      }
      if (!pixels) {
        try {
          pixels = await viaWebCodecs(bytes);
          path = "the platform's HEVC video decoder (WebCodecs) and Airgap's HEIF reader";
        } catch (err) {
          throw new Error((err as Error).message === HEIC_UNAVAILABLE ? HEIC_UNAVAILABLE : `${HEIC_UNAVAILABLE} (${(err as Error).message})`);
        }
      }
      const header = inspect(bytes);
      const payloads = heifMetadata(parseHeif(bytes));
      const metadata: DecodedImage['metadata'] = {
        ...header.metadata,
        ...(header.metadata.hasAlpha ? alphaStats(pixels) : { hasTransparency: false, hasSemiTransparency: false }),
        ...(payloads.exif && { exif: payloads.exif }),
        ...(payloads.xmp && { xmp: payloads.xmp }),
        ...(payloads.icc && { icc: payloads.icc, ...iccFacts(payloads.icc) }),
        // Both paths apply the container's rotation and mirroring, never the EXIF tag.
        orientationApplied: true,
        colorLayout: `HEVC, decoded by ${path}; 8-bit`,
      };
      return { pixels, metadata };
    },
    async encode() {
      throw new Error('Airgap never encodes HEIC.');
    },
  };
}
