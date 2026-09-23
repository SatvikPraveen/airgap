#!/usr/bin/env node
/**
 * Generates tests/fixtures/*. Deterministic; re-run with `npm run fixtures`.
 *
 *   rgb8.png          64x48  8-bit RGB
 *   rgba-partial.png  64x48  8-bit RGBA with partial transparency
 *   rgb16.png         32x32  16-bit RGB
 *   exif-gps.jpg      64x48  JPEG with EXIF (Orientation + GPS lat/long)
 *   one-pixel.png     1x1    8-bit RGB
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import * as P from '../tests/fixtures/pattern.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'tests', 'fixtures');
mkdirSync(out, { recursive: true });

function png8({ width, height }, colorType, fill) {
  const img = new PNG({ width, height, colorType, bitDepth: 8, deflateLevel: 9, filterType: 0 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b, a = 255] = fill(x, y);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  return PNG.sync.write(img, { colorType, bitDepth: 8 });
}

// --- rgb8.png -------------------------------------------------------------
{
  const noise = P.lcg(1);
  writeFileSync(join(out, 'rgb8.png'), png8(P.RGB8, 2, (x, y) => P.rgb8Pixel(x, y, noise)));
}

// --- rgba-partial.png -----------------------------------------------------
{
  const noise = P.lcg(2);
  writeFileSync(join(out, 'rgba-partial.png'), png8(P.RGBA_PARTIAL, 6, (x, y) => P.rgbaPixel(x, y, noise)));
}

// --- one-pixel.png --------------------------------------------------------
writeFileSync(join(out, 'one-pixel.png'), png8(P.ONE_PIXEL, 2, () => P.ONE_PIXEL.rgb));

// --- rgb16.png ------------------------------------------------------------
{
  const { width, height } = P.RGB16;
  const img = new PNG({ width, height, colorType: 2, bitDepth: 16, deflateLevel: 9, filterType: 0 });
  // pngjs's 16-bit writer expects RGBA samples as big-endian 16-bit values.
  const data = Buffer.alloc(width * height * 4 * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 8;
      const [r, g, b] = P.rgb16Pixel(x, y);
      data.writeUInt16BE(r, i);
      data.writeUInt16BE(g, i + 2);
      data.writeUInt16BE(b, i + 4);
      data.writeUInt16BE(0xffff, i + 6);
    }
  }
  img.data = data;
  writeFileSync(join(out, 'rgb16.png'), PNG.sync.write(img, { colorType: 2, bitDepth: 16 }));
}

// --- exif-gps.jpg ---------------------------------------------------------
{
  const { width, height } = P.EXIF_GPS;
  const noise = P.lcg(3);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = P.rgb8Pixel(x, y, noise);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const encoded = jpeg.encode({ data, width, height }, 90).data;
  // Insert an APP1 EXIF segment right after SOI (FF D8).
  const app1 = buildExifApp1();
  const withExif = Buffer.concat([encoded.subarray(0, 2), app1, encoded.subarray(2)]);
  writeFileSync(join(out, 'exif-gps.jpg'), withExif);
}

/**
 * Minimal big-endian TIFF with IFD0 { Orientation=1, GPSInfo -> GPS IFD }
 * and a GPS IFD with version, lat/long refs and rational lat/long.
 * Coordinates: 28.0587 N, 82.4139 W (deliberately real-looking, fictional use).
 */
function buildExifApp1() {
  const entries0 = 2;
  const entriesGps = 5;
  const ifd0Off = 8;
  const ifd0Size = 2 + entries0 * 12 + 4;
  const gpsOff = ifd0Off + ifd0Size;
  const gpsSize = 2 + entriesGps * 12 + 4;
  const latOff = gpsOff + gpsSize;
  const lonOff = latOff + 24;
  const total = lonOff + 24;
  const t = Buffer.alloc(total);
  t.write('MM', 0, 'ascii');
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(ifd0Off, 4);

  let o = ifd0Off;
  t.writeUInt16BE(entries0, o);
  o += 2;
  o = entry(t, o, 0x0112, 3, 1, (b, p) => b.writeUInt16BE(1, p)); // Orientation = 1
  o = entry(t, o, 0x8825, 4, 1, (b, p) => b.writeUInt32BE(gpsOff, p)); // GPSInfo IFD pointer
  t.writeUInt32BE(0, o); // next IFD

  o = gpsOff;
  t.writeUInt16BE(entriesGps, o);
  o += 2;
  o = entry(t, o, 0x0000, 1, 4, (b, p) => b.set([2, 3, 0, 0], p)); // GPSVersionID
  o = entry(t, o, 0x0001, 2, 2, (b, p) => b.write('N\0', p, 'ascii')); // GPSLatitudeRef
  o = entry(t, o, 0x0002, 5, 3, (b, p) => b.writeUInt32BE(latOff, p)); // GPSLatitude
  o = entry(t, o, 0x0003, 2, 2, (b, p) => b.write('W\0', p, 'ascii')); // GPSLongitudeRef
  o = entry(t, o, 0x0004, 5, 3, (b, p) => b.writeUInt32BE(lonOff, p)); // GPSLongitude
  t.writeUInt32BE(0, o);

  rationals(t, latOff, [[28, 1], [3, 1], [3132, 100]]); // 28° 3' 31.32"
  rationals(t, lonOff, [[82, 1], [24, 1], [5004, 100]]); // 82° 24' 50.04"

  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), t]);
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(payload.length + 2, 2);
  payload.copy(seg, 4);
  return seg;
}

function entry(buf, o, tag, type, count, writeValue) {
  buf.writeUInt16BE(tag, o);
  buf.writeUInt16BE(type, o + 2);
  buf.writeUInt32BE(count, o + 4);
  buf.writeUInt32BE(0, o + 8);
  writeValue(buf, o + 8);
  return o + 12;
}

function rationals(buf, o, pairs) {
  for (const [n, d] of pairs) {
    buf.writeUInt32BE(n, o);
    buf.writeUInt32BE(d, o + 4);
    o += 8;
  }
}

console.log('fixtures written to', out);
