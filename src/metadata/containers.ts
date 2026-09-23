/**
 * Container-level metadata plumbing for JPEG, PNG and WebP: pull EXIF / ICC /
 * XMP payloads out of a file, and put chosen payloads into an encoder's
 * output. Pure (pako for PNG iCCP zlib).
 *
 * The codecs we use carry no metadata themselves, so this is where
 * "preserve", "strip GPS only" and "strip all" actually happen.
 */
import { deflate, inflate } from 'pako';
import type { ImageFormat } from '../codecs/types';
import { concat } from './tiff-ifd';

export interface MetadataPayloads {
  exif?: Uint8Array;
  icc?: Uint8Array;
  xmp?: Uint8Array;
}

const EXIF_HEADER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
const XMP_NS = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
const ICC_HEADER = new TextEncoder().encode('ICC_PROFILE\0');
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';

export function extractMetadata(bytes: Uint8Array, format: ImageFormat): MetadataPayloads {
  switch (format) {
    case 'jpeg':
      return extractJpeg(bytes);
    case 'png':
      return extractPng(bytes);
    case 'webp':
      return extractWebp(bytes);
    default:
      return {};
  }
}

/** Returns new bytes with existing EXIF/ICC/XMP removed and the given payloads inserted. */
export function injectMetadata(bytes: Uint8Array, format: ImageFormat, meta: MetadataPayloads): Uint8Array {
  switch (format) {
    case 'jpeg':
      return injectJpeg(bytes, meta);
    case 'png':
      return injectPng(bytes, meta);
    case 'webp':
      return injectWebp(bytes, meta);
    default:
      throw new Error(`No metadata container support for ${format}`);
  }
}

function startsWith(b: Uint8Array, off: number, prefix: Uint8Array): boolean {
  if (off + prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[off + i] !== prefix[i]) return false;
  return true;
}

// ------------------------------------------------------------------- JPEG

interface JpegSegment {
  marker: number;
  /** Whole segment bytes including marker and length. */
  bytes: Uint8Array;
}

/** Splits the header segments before SOS; the remainder (SOS..EOI) is returned as `tail`. */
function splitJpeg(b: Uint8Array): { segments: JpegSegment[]; tail: Uint8Array } {
  if (!(b[0] === 0xff && b[1] === 0xd8)) throw new Error('Not a JPEG');
  const segments: JpegSegment[] = [];
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) throw new Error('Corrupt JPEG segment structure');
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xda) break; // SOS: entropy-coded data follows
    if (marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      segments.push({ marker, bytes: b.slice(off, off + 2) });
      off += 2;
      continue;
    }
    const len = (b[off + 2]! << 8) | b[off + 3]!;
    segments.push({ marker, bytes: b.slice(off, off + 2 + len) });
    off += 2 + len;
  }
  return { segments, tail: b.slice(off) };
}

function segmentPayload(s: JpegSegment): Uint8Array {
  return s.bytes.subarray(4);
}

function isExifSeg(s: JpegSegment): boolean {
  return s.marker === 0xe1 && startsWith(s.bytes, 4, EXIF_HEADER);
}
function isXmpSeg(s: JpegSegment): boolean {
  return s.marker === 0xe1 && startsWith(s.bytes, 4, XMP_NS);
}
function isIccSeg(s: JpegSegment): boolean {
  return s.marker === 0xe2 && startsWith(s.bytes, 4, ICC_HEADER);
}

function extractJpeg(b: Uint8Array): MetadataPayloads {
  const { segments } = splitJpeg(b);
  const out: MetadataPayloads = {};
  const iccChunks: { seq: number; data: Uint8Array }[] = [];
  for (const s of segments) {
    if (isExifSeg(s) && !out.exif) out.exif = segmentPayload(s).slice(EXIF_HEADER.length);
    else if (isXmpSeg(s) && !out.xmp) out.xmp = segmentPayload(s).slice(XMP_NS.length);
    else if (isIccSeg(s)) {
      const p = segmentPayload(s);
      iccChunks.push({ seq: p[ICC_HEADER.length]!, data: p.slice(ICC_HEADER.length + 2) });
    }
  }
  if (iccChunks.length) {
    iccChunks.sort((x, y) => x.seq - y.seq);
    out.icc = concat(iccChunks.map((c) => c.data));
  }
  return out;
}

function app(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  if (len > 0xffff) throw new Error('JPEG segment payload too large');
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (len >> 8) & 255;
  out[3] = len & 255;
  out.set(payload, 4);
  return out;
}

function injectJpeg(b: Uint8Array, meta: MetadataPayloads): Uint8Array {
  const { segments, tail } = splitJpeg(b);
  const kept = segments.filter((s) => !isExifSeg(s) && !isXmpSeg(s) && !isIccSeg(s));
  const inserts: Uint8Array[] = [];
  if (meta.exif) {
    if (meta.exif.length + EXIF_HEADER.length + 2 > 0xffff) {
      throw new Error('EXIF payload exceeds the 64 KB JPEG APP1 limit');
    }
    inserts.push(app(0xe1, concat([EXIF_HEADER, meta.exif])));
  }
  if (meta.xmp) {
    if (meta.xmp.length + XMP_NS.length + 2 > 0xffff) throw new Error('XMP payload exceeds the 64 KB JPEG APP1 limit');
    inserts.push(app(0xe1, concat([XMP_NS, meta.xmp])));
  }
  if (meta.icc) {
    const maxData = 0xffff - 2 - ICC_HEADER.length - 2;
    const total = Math.ceil(meta.icc.length / maxData);
    if (total > 255) throw new Error('ICC profile too large for JPEG');
    for (let i = 0; i < total; i++) {
      const data = meta.icc.subarray(i * maxData, (i + 1) * maxData);
      inserts.push(app(0xe2, concat([ICC_HEADER, new Uint8Array([i + 1, total]), data])));
    }
  }
  // Insert after APP0 (JFIF) if present, else right after SOI.
  const out: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  let inserted = false;
  for (const s of kept) {
    if (!inserted && s.marker !== 0xe0) {
      out.push(...inserts);
      inserted = true;
    }
    out.push(s.bytes);
  }
  if (!inserted) out.push(...inserts);
  out.push(tail);
  return concat(out);
}

// -------------------------------------------------------------------- PNG

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function splitPng(b: Uint8Array): PngChunk[] {
  if (!startsWith(b, 0, PNG_SIG)) throw new Error('Not a PNG');
  const chunks: PngChunk[] = [];
  let off = 8;
  while (off + 8 <= b.length) {
    const len = ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
    const type = String.fromCharCode(b[off + 4]!, b[off + 5]!, b[off + 6]!, b[off + 7]!);
    if (off + 12 + len > b.length) break;
    chunks.push({ type, data: b.slice(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function isPngXmp(c: PngChunk): boolean {
  if (c.type !== 'iTXt') return false;
  const kw = new TextDecoder().decode(c.data.subarray(0, PNG_XMP_KEYWORD.length));
  return kw === PNG_XMP_KEYWORD && c.data[PNG_XMP_KEYWORD.length] === 0;
}

function extractPng(b: Uint8Array): MetadataPayloads {
  const out: MetadataPayloads = {};
  for (const c of splitPng(b)) {
    if (c.type === 'eXIf' && !out.exif) out.exif = c.data;
    else if (c.type === 'iCCP' && !out.icc) {
      let i = 0;
      while (i < c.data.length && c.data[i] !== 0) i++;
      const method = c.data[i + 1];
      if (method === 0) {
        try {
          out.icc = inflate(c.data.subarray(i + 2));
        } catch {
          /* corrupt iCCP: ignore */
        }
      }
    } else if (isPngXmp(c) && !out.xmp) {
      // keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
      let i = PNG_XMP_KEYWORD.length + 1;
      const compressed = c.data[i] === 1;
      i += 2;
      while (i < c.data.length && c.data[i] !== 0) i++;
      i++;
      while (i < c.data.length && c.data[i] !== 0) i++;
      i++;
      const text = c.data.subarray(i);
      out.xmp = compressed ? inflate(text) : text.slice();
    }
  }
  return out;
}

function injectPng(b: Uint8Array, meta: MetadataPayloads): Uint8Array {
  const chunks = splitPng(b).filter((c) => c.type !== 'eXIf' && c.type !== 'iCCP' && !isPngXmp(c));
  const inserts: Uint8Array[] = [];
  if (meta.icc) {
    const name = new TextEncoder().encode('ICC Profile\0');
    inserts.push(pngChunk('iCCP', concat([name, new Uint8Array([0]), deflate(meta.icc, { level: 9 })])));
  }
  if (meta.exif) inserts.push(pngChunk('eXIf', meta.exif));
  if (meta.xmp) {
    const head = new TextEncoder().encode(PNG_XMP_KEYWORD + '\0');
    inserts.push(pngChunk('iTXt', concat([head, new Uint8Array([0, 0, 0, 0]), meta.xmp])));
  }
  const out: Uint8Array[] = [PNG_SIG];
  for (const c of chunks) {
    out.push(pngChunk(c.type, c.data));
    if (c.type === 'IHDR') out.push(...inserts); // ancillary chunks go right after IHDR (before PLTE/IDAT)
  }
  return concat(out);
}

// ------------------------------------------------------------------- WebP

interface RiffChunk {
  type: string;
  data: Uint8Array;
}

function splitWebp(b: Uint8Array): RiffChunk[] {
  const fourcc = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (fourcc(0) !== 'RIFF' || fourcc(8) !== 'WEBP') throw new Error('Not a WebP');
  const chunks: RiffChunk[] = [];
  let off = 12;
  while (off + 8 <= b.length) {
    const type = fourcc(off);
    const len = (b[off + 4]! | (b[off + 5]! << 8) | (b[off + 6]! << 16) | (b[off + 7]! << 24)) >>> 0;
    if (off + 8 + len > b.length) break;
    chunks.push({ type, data: b.slice(off + 8, off + 8 + len) });
    off += 8 + len + (len & 1);
  }
  return chunks;
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(new TextEncoder().encode(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

function extractWebp(b: Uint8Array): MetadataPayloads {
  const out: MetadataPayloads = {};
  for (const c of splitWebp(b)) {
    if (c.type === 'EXIF' && !out.exif) {
      // Some writers wrongly prefix "Exif\0\0"; tolerate it.
      out.exif = startsWith(c.data, 0, EXIF_HEADER) ? c.data.slice(EXIF_HEADER.length) : c.data;
    } else if (c.type === 'ICCP' && !out.icc) out.icc = c.data;
    else if (c.type === 'XMP ' && !out.xmp) out.xmp = c.data;
  }
  return out;
}

/** Image geometry and flags from the bitstream chunks, for building a VP8X header. */
function webpGeometry(chunks: RiffChunk[]): { width: number; height: number; alpha: boolean; animated: boolean } {
  let width = 0;
  let height = 0;
  let alpha = false;
  let animated = false;
  for (const c of chunks) {
    const d = c.data;
    if (c.type === 'VP8X') {
      alpha = (d[0]! & 0x10) !== 0;
      animated = (d[0]! & 0x02) !== 0;
      width = (d[4]! | (d[5]! << 8) | (d[6]! << 16)) + 1;
      height = (d[7]! | (d[8]! << 8) | (d[9]! << 16)) + 1;
    } else if (c.type === 'VP8L' && !width) {
      const bits = (d[1]! | (d[2]! << 8) | (d[3]! << 16) | (d[4]! << 24)) >>> 0;
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
      if ((bits >>> 28) & 1) alpha = true;
    } else if (c.type === 'VP8 ' && !width) {
      width = (d[6]! | (d[7]! << 8)) & 0x3fff;
      height = (d[8]! | (d[9]! << 8)) & 0x3fff;
    } else if (c.type === 'ALPH') alpha = true;
    else if (c.type === 'ANIM') animated = true;
  }
  return { width, height, alpha, animated };
}

function injectWebp(b: Uint8Array, meta: MetadataPayloads): Uint8Array {
  const chunks = splitWebp(b);
  const geo = webpGeometry(chunks);
  const body = chunks.filter((c) => !['VP8X', 'ICCP', 'EXIF', 'XMP '].includes(c.type));
  const needVp8x = !!(meta.icc || meta.exif || meta.xmp || geo.animated || body.some((c) => c.type === 'ALPH'));
  const out: Uint8Array[] = [];
  if (needVp8x) {
    const x = new Uint8Array(10);
    x[0] = (meta.icc ? 0x20 : 0) | (geo.alpha ? 0x10 : 0) | (meta.exif ? 0x08 : 0) | (meta.xmp ? 0x04 : 0) | (geo.animated ? 0x02 : 0);
    const w = geo.width - 1;
    const h = geo.height - 1;
    x[4] = w & 255;
    x[5] = (w >> 8) & 255;
    x[6] = (w >> 16) & 255;
    x[7] = h & 255;
    x[8] = (h >> 8) & 255;
    x[9] = (h >> 16) & 255;
    out.push(riffChunk('VP8X', x));
    if (meta.icc) out.push(riffChunk('ICCP', meta.icc));
  }
  for (const c of body) out.push(riffChunk(c.type, c.data));
  if (needVp8x) {
    if (meta.exif) out.push(riffChunk('EXIF', meta.exif));
    if (meta.xmp) out.push(riffChunk('XMP ', meta.xmp));
  }
  const payload = concat(out);
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(head.buffer).setUint32(4, payload.length + 4, true);
  head.set(new TextEncoder().encode('WEBP'), 8);
  return concat([head, payload]);
}
