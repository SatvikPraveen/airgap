/**
 * Generic TIFF IFD parser and serializer. Pure. Used for EXIF payloads
 * (which are TIFF-structured) and by the TIFF codec itself.
 *
 * Values are kept as raw bytes in the file's byte order so that unknown tags
 * round-trip untouched. Sub-IFDs (Exif, GPS, Interop) and the IFD1 chain are
 * parsed into a tree; the serializer lays everything out again with fresh
 * offsets, appending "blob" entries (thumbnail JPEG, image strips) after the
 * directories.
 */

export const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

export const TAG = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  BitsPerSample: 0x0102,
  Compression: 0x0103,
  Photometric: 0x0106,
  Make: 0x010f,
  Model: 0x0110,
  StripOffsets: 0x0111,
  Orientation: 0x0112,
  SamplesPerPixel: 0x0115,
  RowsPerStrip: 0x0116,
  StripByteCounts: 0x0117,
  XResolution: 0x011a,
  YResolution: 0x011b,
  PlanarConfiguration: 0x011c,
  ResolutionUnit: 0x0128,
  Software: 0x0131,
  DateTime: 0x0132,
  Artist: 0x013b,
  JPEGInterchangeFormat: 0x0201,
  JPEGInterchangeFormatLength: 0x0202,
  ExtraSamples: 0x0152,
  SampleFormat: 0x0153,
  XMP: 0x02bc,
  Copyright: 0x8298,
  ExifIFD: 0x8769,
  MakerNote: 0x927c,
  IccProfile: 0x8773,
  GpsIFD: 0x8825,
  InteropIFD: 0xa005,
} as const;

const SUB_IFD_TAGS = new Set<number>([TAG.ExifIFD, TAG.GpsIFD, TAG.InteropIFD]);
/** Entries whose LONG value is an offset to a blob we must relocate. Paired with a length tag. */
const BLOB_TAGS: Record<number, number> = { [TAG.JPEGInterchangeFormat]: TAG.JPEGInterchangeFormatLength };

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes, length = count * TYPE_SIZE[type], in the structure's byte order. */
  value: Uint8Array;
  /** For sub-IFD pointer tags: the parsed sub-directory. */
  sub?: Ifd;
  /** For blob tags (thumbnail): the referenced bytes; `value` is rewritten on serialize. */
  blob?: Uint8Array;
}

export interface Ifd {
  entries: IfdEntry[];
  /** IFD1 (thumbnail directory) for IFD0, if present. */
  next?: Ifd;
}

export interface TiffStructure {
  littleEndian: boolean;
  ifd0: Ifd;
}

export class TiffParseError extends Error {
  override name = 'TiffParseError';
}

export function parseTiffStructure(bytes: Uint8Array): TiffStructure {
  if (bytes.length < 8) throw new TiffParseError('TIFF header too short');
  const bo = String.fromCharCode(bytes[0]!, bytes[1]!);
  let littleEndian: boolean;
  if (bo === 'II') littleEndian = true;
  else if (bo === 'MM') littleEndian = false;
  else throw new TiffParseError('Not a TIFF structure (bad byte order mark)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(2, littleEndian) !== 42) throw new TiffParseError('Not a TIFF structure (magic != 42)');
  const ifd0Offset = dv.getUint32(4, littleEndian);
  const visited = new Set<number>();
  const ifd0 = readIfd(bytes, dv, littleEndian, ifd0Offset, visited, true);
  if (!ifd0) throw new TiffParseError('IFD0 offset out of range');
  return { littleEndian, ifd0 };
}

function readIfd(
  bytes: Uint8Array,
  dv: DataView,
  le: boolean,
  offset: number,
  visited: Set<number>,
  followNext: boolean,
): Ifd | null {
  if (offset < 8 || offset + 2 > bytes.length || visited.has(offset)) return null;
  visited.add(offset);
  const count = dv.getUint16(offset, le);
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = offset + 2 + i * 12;
    if (e + 12 > bytes.length) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const n = dv.getUint32(e + 4, le);
    const size = TYPE_SIZE[type];
    if (!size) continue; // unknown type: drop, cannot size it
    const byteLen = size * n;
    let value: Uint8Array;
    if (byteLen <= 4) {
      value = bytes.slice(e + 8, e + 8 + byteLen);
    } else {
      const off = dv.getUint32(e + 8, le);
      if (off + byteLen > bytes.length) continue; // truncated: drop the entry
      value = bytes.slice(off, off + byteLen);
    }
    const entry: IfdEntry = { tag, type, count: n, value };
    if (SUB_IFD_TAGS.has(tag) && (type === 4 || type === 13) && n === 1) {
      const sub = readIfd(bytes, dv, le, dv.getUint32(e + 8, le), visited, false);
      if (sub) entry.sub = sub;
      else continue;
    }
    entries.push(entry);
  }
  const ifd: Ifd = { entries };
  // Resolve blob references (thumbnail) inside this IFD.
  for (const entry of entries) {
    const lenTag = BLOB_TAGS[entry.tag];
    if (lenTag !== undefined && entry.type === 4 && entry.count === 1) {
      const lenEntry = entries.find((x) => x.tag === lenTag);
      const off = readUint32(entry.value, 0, le);
      const len = lenEntry ? readNumber(lenEntry, le) : 0;
      if (len > 0 && off + len <= bytes.length) entry.blob = bytes.slice(off, off + len);
    }
  }
  if (followNext) {
    const nextOff = offset + 2 + count * 12;
    if (nextOff + 4 <= bytes.length) {
      const next = dv.getUint32(nextOff, le);
      if (next !== 0) {
        const n = readIfd(bytes, dv, le, next, visited, false);
        if (n) ifd.next = n;
      }
    }
  }
  return ifd;
}

export function readUint16(v: Uint8Array, o: number, le: boolean): number {
  return le ? v[o]! | (v[o + 1]! << 8) : (v[o]! << 8) | v[o + 1]!;
}
export function readUint32(v: Uint8Array, o: number, le: boolean): number {
  return le
    ? (v[o]! | (v[o + 1]! << 8) | (v[o + 2]! << 16) | (v[o + 3]! << 24)) >>> 0
    : ((v[o]! << 24) | (v[o + 1]! << 16) | (v[o + 2]! << 8) | v[o + 3]!) >>> 0;
}

/** First numeric value of a SHORT/LONG/BYTE entry. */
export function readNumber(e: IfdEntry, le: boolean): number {
  switch (e.type) {
    case 1:
    case 6:
    case 7:
      return e.value[0] ?? 0;
    case 3:
    case 8:
      return readUint16(e.value, 0, le);
    case 4:
    case 9:
    case 13:
      return readUint32(e.value, 0, le);
    default:
      return 0;
  }
}

export function readNumbers(e: IfdEntry, le: boolean): number[] {
  const out: number[] = [];
  const size = TYPE_SIZE[e.type] ?? 1;
  for (let i = 0; i < e.count; i++) {
    const o = i * size;
    if (size === 1) out.push(e.value[o] ?? 0);
    else if (size === 2) out.push(readUint16(e.value, o, le));
    else if (size === 4) out.push(readUint32(e.value, o, le));
    else if (size === 8) out.push(readUint32(e.value, o, le) / (readUint32(e.value, o + 4, le) || 1));
  }
  return out;
}

export function readAscii(e: IfdEntry): string {
  let s = '';
  for (let i = 0; i < e.value.length; i++) {
    const c = e.value[i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ------------------------------------------------------------------ builders

export function entryShort(le: boolean, tag: number, values: number[]): IfdEntry {
  const value = new Uint8Array(values.length * 2);
  values.forEach((v, i) => writeUint16(value, i * 2, v, le));
  return { tag, type: 3, count: values.length, value };
}
export function entryLong(le: boolean, tag: number, values: number[]): IfdEntry {
  const value = new Uint8Array(values.length * 4);
  values.forEach((v, i) => writeUint32(value, i * 4, v, le));
  return { tag, type: 4, count: values.length, value };
}
export function entryRational(le: boolean, tag: number, values: [number, number][]): IfdEntry {
  const value = new Uint8Array(values.length * 8);
  values.forEach(([n, d], i) => {
    writeUint32(value, i * 8, n, le);
    writeUint32(value, i * 8 + 4, d, le);
  });
  return { tag, type: 5, count: values.length, value };
}
export function entryAscii(tag: number, text: string): IfdEntry {
  const bytes = new TextEncoder().encode(text + '\0');
  return { tag, type: 2, count: bytes.length, value: bytes };
}
export function entryUndefined(tag: number, bytes: Uint8Array): IfdEntry {
  return { tag, type: 7, count: bytes.length, value: bytes };
}
export function entryByte(tag: number, bytes: Uint8Array): IfdEntry {
  return { tag, type: 1, count: bytes.length, value: bytes };
}
/** LONG offset entry whose bytes are appended to the file (strip data, thumbnail). */
export function entryBlob(le: boolean, tag: number, blob: Uint8Array): IfdEntry {
  return { tag, type: 4, count: 1, value: new Uint8Array(4), blob };
}
export function entrySubIfd(tag: number, sub: Ifd): IfdEntry {
  return { tag, type: 4, count: 1, value: new Uint8Array(4), sub };
}

export function writeUint16(v: Uint8Array, o: number, x: number, le: boolean): void {
  if (le) {
    v[o] = x & 255;
    v[o + 1] = (x >> 8) & 255;
  } else {
    v[o] = (x >> 8) & 255;
    v[o + 1] = x & 255;
  }
}
export function writeUint32(v: Uint8Array, o: number, x: number, le: boolean): void {
  if (le) {
    v[o] = x & 255;
    v[o + 1] = (x >>> 8) & 255;
    v[o + 2] = (x >>> 16) & 255;
    v[o + 3] = (x >>> 24) & 255;
  } else {
    v[o] = (x >>> 24) & 255;
    v[o + 1] = (x >>> 16) & 255;
    v[o + 2] = (x >>> 8) & 255;
    v[o + 3] = x & 255;
  }
}

// ---------------------------------------------------------------- serialize

/**
 * Lays out the structure: header, then each directory followed by its
 * out-of-line values, sub-IFDs after their parent, IFD1 after IFD0's tree,
 * blobs at the end. Entries are sorted by tag as TIFF requires.
 */
export function serializeTiffStructure(s: TiffStructure): Uint8Array {
  const le = s.littleEndian;
  const parts: Uint8Array[] = [];
  let cursor = 8;
  const blobs: { data: Uint8Array; dir: Uint8Array; at: number }[] = [];

  const header = new Uint8Array(8);
  header[0] = le ? 0x49 : 0x4d;
  header[1] = le ? 0x49 : 0x4d;
  writeUint16(header, 2, 42, le);
  parts.push(header);

  function layoutIfd(ifd: Ifd, nextIfd: Ifd | undefined): number {
    const entries = [...ifd.entries].sort((a, b) => a.tag - b.tag);
    const dirOffset = cursor;
    const dir = new Uint8Array(2 + entries.length * 12 + 4);
    writeUint16(dir, 0, entries.length, le);
    parts.push(dir);
    cursor += dir.length;
    const subs: { at: number; sub: Ifd }[] = [];
    const valueParts: Uint8Array[] = [];
    entries.forEach((e, i) => {
      const at = 2 + i * 12;
      writeUint16(dir, at, e.tag, le);
      writeUint16(dir, at + 2, e.type, le);
      writeUint32(dir, at + 4, e.count, le);
      if (e.sub) {
        subs.push({ at: at + 8, sub: e.sub });
      } else if (e.blob) {
        blobs.push({ data: e.blob, dir, at: at + 8 });
      } else if (e.value.length <= 4) {
        dir.set(e.value, at + 8);
      } else {
        const padded = e.value.length % 2 ? concat([e.value, new Uint8Array(1)]) : e.value;
        writeUint32(dir, at + 8, cursor, le);
        valueParts.push(padded);
        cursor += padded.length;
      }
    });
    parts.push(...valueParts);
    for (const { at, sub } of subs) writeUint32(dir, at, layoutIfd(sub, undefined), le);
    const nextAt = 2 + entries.length * 12;
    writeUint32(dir, nextAt, nextIfd ? layoutIfd(nextIfd, undefined) : 0, le);
    return dirOffset;
  }

  const ifd0Offset = layoutIfd(s.ifd0, s.ifd0.next);
  writeUint32(header, 4, ifd0Offset, le);

  for (const b of blobs) {
    if (cursor % 2) {
      parts.push(new Uint8Array(1));
      cursor++;
    }
    writeUint32(b.dir, b.at, cursor, le);
    parts.push(b.data);
    cursor += b.data.length;
  }
  return concat(parts);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function findEntry(ifd: Ifd, tag: number): IfdEntry | undefined {
  return ifd.entries.find((e) => e.tag === tag);
}

export function removeEntry(ifd: Ifd, tag: number): boolean {
  const i = ifd.entries.findIndex((e) => e.tag === tag);
  if (i < 0) return false;
  ifd.entries.splice(i, 1);
  return true;
}

/** Replace or add an entry. */
export function setEntry(ifd: Ifd, entry: IfdEntry): void {
  removeEntry(ifd, entry.tag);
  ifd.entries.push(entry);
}
