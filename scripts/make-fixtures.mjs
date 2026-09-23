#!/usr/bin/env node
/**
 * Generates tests/fixtures/*. Deterministic; re-run with `npm run fixtures`.
 * Everything here is written by independent code (pngjs, jpeg-js, hand-built
 * containers), never by the app's own encoders or metadata writers, except
 * the WebP/AVIF/JXL bitstreams which come from the same wasm encoders the app
 * uses (there is no independent JS encoder for those); their containers are
 * still assembled by hand here.
 *
 *   rgb8.png            64x48  8-bit RGB
 *   rgba-partial.png    64x48  8-bit RGBA with partial transparency
 *   rgb16.png           32x32  16-bit RGB
 *   rgba16.png          24x20  16-bit RGBA with partial transparency
 *   one-pixel.png       1x1    8-bit RGB
 *   exif-gps.jpg        64x48  JPEG, EXIF (Make/Model/DateTime/Exif IFD) + GPS
 *   exif-orient6.jpg    48x32  JPEG, EXIF Orientation=6 + GPS, quadrant colours
 *   icc-p3.png          16x16  8-bit RGB PNG with an iCCP Display P3 (matrix/TRC) profile
 *   icc-lut.jpg         64x48  JPEG with an APP2 LUT-based (A2B0) ICC profile
 *   rgb8.tif            64x48  8-bit RGB TIFF, uncompressed, big-endian
 *   rgba-partial.tif    64x48  8-bit RGBA TIFF, ExtraSamples=2 (straight alpha)
 *   rgb16.tif           32x32  16-bit RGB TIFF
 *   exif-icc.webp       64x48  lossless WebP with VP8X + ICCP + EXIF (GPS) chunks
 *   rgba-partial.webp   64x48  lossless WebP (VP8L) with alpha
 *   rgba-partial.avif   64x48  lossless AVIF with alpha
 *   rgba-partial.jxl    64x48  lossless JPEG XL with alpha
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import * as P from '../tests/fixtures/pattern.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'tests', 'fixtures');
mkdirSync(out, { recursive: true });
const write = (name, bytes) => writeFileSync(join(out, name), Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length));

// ---------------------------------------------------------------- raster helpers

function raster8({ width, height }, fill) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a = 255] = fill(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return data;
}

function png8(dims, colorType, fill) {
  const img = new PNG({ ...dims, colorType, bitDepth: 8, deflateLevel: 9, filterType: 0 });
  img.data = raster8(dims, fill);
  return PNG.sync.write(img, { colorType, bitDepth: 8 });
}

function png16(dims, colorType, fill) {
  const { width, height } = dims;
  const img = new PNG({ width, height, colorType, bitDepth: 16, deflateLevel: 9, filterType: 0 });
  const data = Buffer.alloc(width * height * 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 8;
      const [r, g, b, a = 0xffff] = fill(x, y);
      data.writeUInt16BE(r, i);
      data.writeUInt16BE(g, i + 2);
      data.writeUInt16BE(b, i + 4);
      data.writeUInt16BE(a, i + 6);
    }
  }
  img.data = data;
  return PNG.sync.write(img, { colorType, bitDepth: 16 });
}

// ---------------------------------------------------------------- PNG chunk surgery

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const o = Buffer.alloc(12 + data.length);
  o.writeUInt32BE(data.length, 0);
  o.write(type, 4, 'ascii');
  data.copy(o, 8);
  o.writeUInt32BE(crc32(o.subarray(4, 8 + data.length)), 8 + data.length);
  return o;
}
/** Inserts chunks right after IHDR. */
function pngInsertAfterIhdr(png, chunks) {
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

// ---------------------------------------------------------------- TIFF/EXIF builder (big-endian)

const T = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, RATIONAL: 5, UNDEFINED: 7 };
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

function valueBytes(type, values) {
  if (type === T.ASCII) return Buffer.from(values + '\0', 'ascii');
  if (type === T.BYTE || type === T.UNDEFINED) return Buffer.from(values);
  const b = Buffer.alloc(values.length * SIZE[type]);
  values.forEach((v, i) => {
    if (type === T.SHORT) b.writeUInt16BE(v, i * 2);
    else if (type === T.LONG) b.writeUInt32BE(v, i * 4);
    else {
      b.writeUInt32BE(v[0], i * 8);
      b.writeUInt32BE(v[1], i * 8 + 4);
    }
  });
  return b;
}

/**
 * entries: [{tag, type, values}] or {tag, sub: entries[]} or {tag, blob: Buffer, lengthTag}
 * Returns a complete big-endian TIFF structure (header + IFDs + data).
 */
function buildTiff(entries, { header = true } = {}) {
  const parts = [];
  let cursor = header ? 8 : 0;
  const patches = [];
  const blobs = [];
  function layout(list) {
    list = [...list].sort((a, b) => a.tag - b.tag);
    const dirOff = cursor;
    const dir = Buffer.alloc(2 + list.length * 12 + 4);
    dir.writeUInt16BE(list.length, 0);
    parts.push(dir);
    cursor += dir.length;
    const later = [];
    list.forEach((e, i) => {
      const at = 2 + i * 12;
      dir.writeUInt16BE(e.tag, at);
      if (e.sub) {
        dir.writeUInt16BE(T.LONG, at + 2);
        dir.writeUInt32BE(1, at + 4);
        later.push({ at, sub: e.sub });
        return;
      }
      if (e.blob) {
        dir.writeUInt16BE(T.LONG, at + 2);
        dir.writeUInt32BE(1, at + 4);
        blobs.push({ dir, at: at + 8, blob: e.blob });
        return;
      }
      const vb = valueBytes(e.type, e.values);
      const count = e.type === T.ASCII || e.type === T.BYTE || e.type === T.UNDEFINED ? vb.length : e.values.length;
      dir.writeUInt16BE(e.type, at + 2);
      dir.writeUInt32BE(count, at + 4);
      if (vb.length <= 4) vb.copy(dir, at + 8);
      else {
        dir.writeUInt32BE(cursor, at + 8);
        const padded = vb.length % 2 ? Buffer.concat([vb, Buffer.alloc(1)]) : vb;
        parts.push(padded);
        cursor += padded.length;
      }
    });
    for (const l of later) dir.writeUInt32BE(layout(l.sub), l.at + 8);
    dir.writeUInt32BE(0, 2 + list.length * 12);
    return dirOff;
  }
  const ifd0 = layout(entries);
  for (const b of blobs) {
    if (cursor % 2) {
      parts.push(Buffer.alloc(1));
      cursor++;
    }
    b.dir.writeUInt32BE(cursor, b.at);
    parts.push(b.blob);
    cursor += b.blob.length;
  }
  const head = Buffer.alloc(8);
  head.write('MM', 0, 'ascii');
  head.writeUInt16BE(42, 2);
  head.writeUInt32BE(ifd0, 4);
  return Buffer.concat([head, ...parts]);
}

/** MakerNote: vendor header, ASCII coordinates, then the same coordinates as raw rationals. */
function makerNoteBlob() {
  const rat = Buffer.alloc(48);
  [...P.LOCATION.lat, ...P.LOCATION.lon].forEach(([n, d], i) => {
    rat.writeUInt32BE(n, i * 8);
    rat.writeUInt32BE(d, i * 8 + 4);
  });
  return Buffer.concat([Buffer.from('AIRGAPCAM\0', 'ascii'), Buffer.from(P.LOCATION.makerAscii + '\0', 'ascii'), rat]);
}

function xmpWithLocation() {
  return Buffer.from(
    `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" exif:GPSLatitude="${P.LOCATION.xmpLat}" exif:GPSLongitude="${P.LOCATION.xmpLon}" exif:GPSAltitude="12/1"><dc:description>${P.LOCATION.decimalLat}, ${P.LOCATION.decimalLon}</dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    'utf8',
  );
}

function jpegApp1Xmp(xmp) {
  const payload = Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii'), xmp]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}

function exifEntries({ orientation = 1, gps = true, makerNote = false } = {}) {
  const e = [
    { tag: 0x010f, type: T.ASCII, values: 'Airgap Fixtures' },
    { tag: 0x0110, type: T.ASCII, values: 'Synthetic Camera 1' },
    { tag: 0x0112, type: T.SHORT, values: [orientation] },
    { tag: 0x011a, type: T.RATIONAL, values: [[72, 1]] },
    { tag: 0x011b, type: T.RATIONAL, values: [[72, 1]] },
    { tag: 0x0128, type: T.SHORT, values: [2] },
    { tag: 0x0131, type: T.ASCII, values: 'make-fixtures.mjs' },
    { tag: 0x0132, type: T.ASCII, values: '2026:09:23 10:00:00' },
    {
      tag: 0x8769,
      sub: [
        { tag: 0x829a, type: T.RATIONAL, values: [[1, 125]] },
        { tag: 0x8827, type: T.SHORT, values: [200] },
        { tag: 0x9003, type: T.ASCII, values: '2026:09:23 09:59:59' },
        { tag: 0xa002, type: T.LONG, values: [64] },
        { tag: 0xa003, type: T.LONG, values: [48] },
        ...(makerNote ? [{ tag: 0x927c, type: T.UNDEFINED, values: makerNoteBlob() }] : []),
      ],
    },
  ];
  if (gps) {
    e.push({
      tag: 0x8825,
      sub: [
        { tag: 0x0000, type: T.BYTE, values: [2, 3, 0, 0] },
        { tag: 0x0001, type: T.ASCII, values: 'N' },
        { tag: 0x0002, type: T.RATIONAL, values: [[28, 1], [3, 1], [3132, 100]] },
        { tag: 0x0003, type: T.ASCII, values: 'W' },
        { tag: 0x0004, type: T.RATIONAL, values: [[82, 1], [24, 1], [5004, 100]] },
      ],
    });
  }
  return e;
}

/** TIFF with IFD0 + IFD1 (thumbnail JPEG that itself carries an EXIF GPS segment). */
function buildTiffWithThumbnail(entries, thumbJpeg) {
  const main = buildTiff(entries);
  // Append IFD1 by hand: rewrite IFD0's next pointer to a new directory after the data.
  const dirCount = main.readUInt16BE(8);
  const nextPtrAt = 8 + 2 + dirCount * 12;
  let cursor = main.length + (main.length % 2);
  const ifd1Off = cursor;
  const ifd1 = Buffer.alloc(2 + 3 * 12 + 4);
  ifd1.writeUInt16BE(3, 0);
  const thumbOff = ifd1Off + ifd1.length;
  const e = (i, tag, type, count, value) => {
    const at = 2 + i * 12;
    ifd1.writeUInt16BE(tag, at);
    ifd1.writeUInt16BE(type, at + 2);
    ifd1.writeUInt32BE(count, at + 4);
    ifd1.writeUInt32BE(value, at + 8);
  };
  e(0, 0x0103, T.SHORT, 1, 6 << 16); // Compression = 6 (JPEG), SHORT left-justified
  e(1, 0x0201, T.LONG, 1, thumbOff);
  e(2, 0x0202, T.LONG, 1, thumbJpeg.length);
  ifd1.writeUInt32BE(0, 2 + 3 * 12);
  const out = Buffer.concat([main, Buffer.alloc(main.length % 2), ifd1, thumbJpeg]);
  out.writeUInt32BE(ifd1Off, nextPtrAt);
  return out;
}

function jpegApp1Exif(tiff) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}
function jpegApp2Icc(icc) {
  const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'ascii'), Buffer.from([1, 1]), icc]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe2;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}
function jpegWithSegments(rgba, dims, segments) {
  const encoded = jpeg.encode({ data: rgba, ...dims }, 90).data;
  return Buffer.concat([encoded.subarray(0, 2), ...segments, encoded.subarray(2)]);
}

// ---------------------------------------------------------------- ICC builders

function s15(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v * 65536), 0);
  return b;
}
function xyzTag(x, y, z) {
  return Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'ascii'), s15(x), s15(y), s15(z)]);
}
function paraSrgb() {
  // Parametric curve type 3: Y = (aX+b)^g for X >= d, cX otherwise (the sRGB curve).
  return Buffer.concat([
    Buffer.from('para\0\0\0\0', 'ascii'),
    Buffer.from([0, 3, 0, 0]),
    s15(2.4),
    s15(1 / 1.055),
    s15(0.055 / 1.055),
    s15(1 / 12.92),
    s15(0.04045),
  ]);
}
function descTag(text) {
  const b = Buffer.alloc(12 + text.length + 1 + 78);
  b.write('desc', 0, 'ascii');
  b.writeUInt32BE(text.length + 1, 8);
  b.write(text, 12, 'ascii');
  return b;
}
function textTag(text) {
  return Buffer.concat([Buffer.from('text\0\0\0\0', 'ascii'), Buffer.from(text + '\0', 'ascii')]);
}
function buildIcc(deviceClass, tags) {
  const header = Buffer.alloc(128);
  header.write('none', 4, 'ascii');
  header.writeUInt32BE(0x02100000, 8);
  header.write(deviceClass, 12, 'ascii');
  header.write('RGB ', 16, 'ascii');
  header.write('XYZ ', 20, 'ascii');
  header.write('acsp', 36, 'ascii');
  // D50 illuminant
  s15(0.9642).copy(header, 68);
  s15(1.0).copy(header, 72);
  s15(0.8249).copy(header, 76);
  const table = Buffer.alloc(4 + tags.length * 12);
  table.writeUInt32BE(tags.length, 0);
  let off = 128 + table.length;
  const datas = [];
  tags.forEach(([sig, data], i) => {
    const padded = data.length % 4 ? Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]) : data;
    table.write(sig, 4 + i * 12, 'ascii');
    table.writeUInt32BE(off, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
    datas.push(padded);
    off += padded.length;
  });
  const icc = Buffer.concat([header, table, ...datas]);
  icc.writeUInt32BE(icc.length, 0);
  return icc;
}
export function displayP3Icc() {
  const trc = paraSrgb();
  return buildIcc('mntr', [
    ['desc', descTag('Display P3 (fixture)')],
    ['cprt', textTag('no copyright')],
    ['wtpt', xyzTag(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyzTag(0.51512, 0.2412, -0.00105)],
    ['gXYZ', xyzTag(0.29198, 0.69225, 0.04189)],
    ['bXYZ', xyzTag(0.1571, 0.06657, 0.78407)],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
  ]);
}
function lutIcc() {
  // Minimal 'mft2' (lut16Type) A2B0: 3 in, 3 out, 2 grid points, identity matrix, 2-entry tables.
  const mft = Buffer.alloc(8 + 4 + 36 + 4 + 3 * 2 * 2 + 8 * 3 * 2 + 3 * 2 * 2);
  mft.write('mft2', 0, 'ascii');
  mft[8] = 3;
  mft[9] = 3;
  mft[10] = 2;
  let o = 12;
  for (const v of [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
    s15(v).copy(mft, o);
    o += 4;
  }
  mft.writeUInt16BE(2, o);
  mft.writeUInt16BE(2, o + 2);
  o += 4;
  for (let i = 0; i < 3; i++) {
    mft.writeUInt16BE(0, o);
    mft.writeUInt16BE(65535, o + 2);
    o += 4;
  }
  for (let g = 0; g < 8; g++) {
    for (let c = 0; c < 3; c++) {
      mft.writeUInt16BE(((g >> (2 - c)) & 1) * 65535, o);
      o += 2;
    }
  }
  for (let i = 0; i < 3; i++) {
    mft.writeUInt16BE(0, o);
    mft.writeUInt16BE(65535, o + 2);
    o += 4;
  }
  return buildIcc('prtr', [
    ['desc', descTag('LUT profile (fixture)')],
    ['cprt', textTag('no copyright')],
    ['wtpt', xyzTag(0.9642, 1.0, 0.8249)],
    ['A2B0', mft],
    ['B2A0', mft],
  ]);
}

// ---------------------------------------------------------------- TIFF image writer (big-endian, independent of src/)

function tiffImage(dims, samples, bitDepth, fill, extraSamples) {
  const { width, height } = dims;
  const bytes = bitDepth / 8;
  const strip = Buffer.alloc(width * height * samples * bytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = fill(x, y);
      for (let s = 0; s < samples; s++) {
        const o = ((y * width + x) * samples + s) * bytes;
        if (bytes === 1) strip[o] = px[s];
        else strip.writeUInt16BE(px[s], o);
      }
    }
  }
  const entries = [
    { tag: 256, type: T.LONG, values: [width] },
    { tag: 257, type: T.LONG, values: [height] },
    { tag: 258, type: T.SHORT, values: new Array(samples).fill(bitDepth) },
    { tag: 259, type: T.SHORT, values: [1] },
    { tag: 262, type: T.SHORT, values: [2] },
    { tag: 273, blob: strip },
    { tag: 277, type: T.SHORT, values: [samples] },
    { tag: 278, type: T.LONG, values: [height] },
    { tag: 279, type: T.LONG, values: [strip.length] },
    { tag: 284, type: T.SHORT, values: [1] },
    { tag: 305, type: T.ASCII, values: 'make-fixtures.mjs (independent writer)' },
  ];
  if (extraSamples !== undefined) entries.push({ tag: 338, type: T.SHORT, values: [extraSamples] });
  return buildTiff(entries);
}

// ================================================================ fixtures

{
  const noise = P.lcg(1);
  write('rgb8.png', png8(P.RGB8, 2, (x, y) => P.rgb8Pixel(x, y, noise)));
}
{
  const noise = P.lcg(2);
  write('rgba-partial.png', png8(P.RGBA_PARTIAL, 6, (x, y) => P.rgbaPixel(x, y, noise)));
}
write('one-pixel.png', png8(P.ONE_PIXEL, 2, () => P.ONE_PIXEL.rgb));
write('rgb16.png', png16(P.RGB16, 2, (x, y) => P.rgb16Pixel(x, y)));
write('rgba16.png', png16(P.RGBA16, 6, (x, y) => P.rgba16Pixel(x, y)));

{
  const noise = P.lcg(3);
  const rgba = raster8(P.EXIF_GPS, (x, y) => P.rgb8Pixel(x, y, noise));
  write('exif-gps.jpg', jpegWithSegments(rgba, P.EXIF_GPS, [jpegApp1Exif(buildTiff(exifEntries({ orientation: 1 })))]));
  write('icc-lut.jpg', jpegWithSegments(rgba, P.EXIF_GPS, [jpegApp2Icc(lutIcc())]));
}
{
  // location-everywhere.jpg: GPS IFD + MakerNote + XMP + thumbnail with its own EXIF GPS.
  const noise = P.lcg(3);
  const rgba = raster8(P.EXIF_GPS, (x, y) => P.rgb8Pixel(x, y, noise));
  const thumbRaster = raster8({ width: 16, height: 12 }, (x, y) => P.rgb8Pixel(x * 4, y * 4, noise));
  const thumb = jpegWithSegments(thumbRaster, { width: 16, height: 12 }, [jpegApp1Exif(buildTiff(exifEntries({ gps: true })))]);
  const tiff = buildTiffWithThumbnail(exifEntries({ gps: true, makerNote: true }), thumb);
  write('location-everywhere.jpg', jpegWithSegments(rgba, P.EXIF_GPS, [jpegApp1Exif(tiff), jpegApp1Xmp(xmpWithLocation())]));
}
{
  const rgba = raster8(P.ORIENT, (x, y) => P.quadrantPixel(x, y));
  write('exif-orient6.jpg', jpegWithSegments(rgba, P.ORIENT, [jpegApp1Exif(buildTiff(exifEntries({ orientation: 6 })))]));
}
{
  const png = png8(P.ICC_P3, 2, (x, y) => P.p3Pixel(x, y));
  const icc = displayP3Icc();
  const iccp = Buffer.concat([Buffer.from('Display P3\0', 'ascii'), Buffer.from([0]), deflateSync(icc, { level: 9 })]);
  write('icc-p3.png', pngInsertAfterIhdr(png, [pngChunk('iCCP', iccp)]));
  write('display-p3.icc', icc);
}
{
  const noise = P.lcg(1);
  write('rgb8.tif', tiffImage(P.RGB8, 3, 8, (x, y) => P.rgb8Pixel(x, y, noise)));
  const noise2 = P.lcg(2);
  write('rgba-partial.tif', tiffImage(P.RGBA_PARTIAL, 4, 8, (x, y) => P.rgbaPixel(x, y, noise2), 2));
  write('rgb16.tif', tiffImage(P.RGB16, 3, 16, (x, y) => P.rgb16Pixel(x, y)));
}

// ---- wasm-encoded bitstreams (same encoders as the app; containers hand-built) ----

function emscripten(factory, wasmPath) {
  const wasm = readFileSync(require.resolve(wasmPath));
  return factory({
    noInitialRun: true,
    instantiateWasm(imports, cb) {
      const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), imports);
      cb(inst);
      return inst.exports;
    },
  });
}
function riff(chunks) {
  const body = Buffer.concat(
    chunks.map(([t, d]) => {
      const c = Buffer.alloc(8 + d.length + (d.length & 1));
      c.write(t, 0, 'ascii');
      c.writeUInt32LE(d.length, 4);
      Buffer.from(d).copy(c, 8);
      return c;
    }),
  );
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'ascii');
  return Buffer.concat([head, body]);
}
function webpChunks(bytes) {
  const b = Buffer.from(bytes);
  const chunks = [];
  let off = 12;
  while (off + 8 <= b.length) {
    const type = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    chunks.push([type, b.subarray(off + 8, off + 8 + len)]);
    off += 8 + len + (len & 1);
  }
  return chunks;
}

try {
  const webpMeta = await import('@jsquash/webp/meta.js');
  const { default: webpFactory } = await import('@jsquash/webp/codec/enc/webp_enc.js');
  const enc = await emscripten(webpFactory, '@jsquash/webp/codec/enc/webp_enc.wasm');
  const noise = P.lcg(2);
  const rgba = raster8(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
  const opts = { ...webpMeta.defaultOptions, lossless: 1, exact: 1, quality: 100 };
  const simple = enc.encode(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), P.RGBA_PARTIAL.width, P.RGBA_PARTIAL.height, opts);
  write('rgba-partial.webp', simple);
  // Extended container: VP8X + ICCP + VP8L + EXIF
  const noise3 = P.lcg(3);
  const rgb = raster8(P.EXIF_GPS, (x, y) => P.rgb8Pixel(x, y, noise3));
  const rgbWebp = enc.encode(new Uint8ClampedArray(rgb.buffer, rgb.byteOffset, rgb.length), P.EXIF_GPS.width, P.EXIF_GPS.height, opts);
  const vp8l = webpChunks(rgbWebp).find(([t]) => t === 'VP8L')[1];
  const x = Buffer.alloc(10);
  x[0] = 0x20 | 0x08; // ICC + EXIF
  const w = P.EXIF_GPS.width - 1;
  const h = P.EXIF_GPS.height - 1;
  x[4] = w & 255; x[5] = (w >> 8) & 255; x[6] = (w >> 16) & 255;
  x[7] = h & 255; x[8] = (h >> 8) & 255; x[9] = (h >> 16) & 255;
  write('exif-icc.webp', riff([['VP8X', x], ['ICCP', displayP3Icc()], ['VP8L', vp8l], ['EXIF', buildTiff(exifEntries({ orientation: 1 }))]]));
} catch (err) {
  console.warn('WebP fixtures skipped:', err.message);
}

try {
  const meta = await import('@jsquash/avif/meta.js');
  const { default: factory } = await import('@jsquash/avif/codec/enc/avif_enc.js');
  const enc = await emscripten(factory, '@jsquash/avif/codec/enc/avif_enc.wasm');
  const noise = P.lcg(2);
  const rgba = raster8(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
  const opts = { ...meta.defaultOptions, quality: 100, qualityAlpha: -1, subsample: 3, bitDepth: 8, speed: 6 };
  const bytes = enc.encode(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length), P.RGBA_PARTIAL.width, P.RGBA_PARTIAL.height, opts);
  write('rgba-partial.avif', bytes);
} catch (err) {
  console.warn('AVIF fixture skipped:', err.message);
}

try {
  const meta = await import('@jsquash/jxl/meta.js');
  const { default: factory } = await import('@jsquash/jxl/codec/enc/jxl_enc.js');
  const enc = await emscripten(factory, '@jsquash/jxl/codec/enc/jxl_enc.wasm');
  const noise = P.lcg(2);
  const rgba = raster8(P.RGBA_PARTIAL, (x, y) => P.rgbaPixel(x, y, noise));
  const opts = { ...meta.defaultOptions, lossless: true, quality: 100, lossyModular: false, lossyPalette: false };
  const bytes = enc.encode(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length), P.RGBA_PARTIAL.width, P.RGBA_PARTIAL.height, opts);
  write('rgba-partial.jxl', bytes);
} catch (err) {
  console.warn('JXL fixture skipped:', err.message);
}

console.log('fixtures written to', out);
