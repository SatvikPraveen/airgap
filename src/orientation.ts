/**
 * EXIF orientation (tag 0x0112) applied to pixels. Pure, any bit depth.
 *
 *  1 = upright            2 = mirror horizontal
 *  3 = rotate 180         4 = mirror vertical
 *  5 = transpose          6 = rotate 90 CW
 *  7 = transverse         8 = rotate 90 CCW
 */
import { allocate } from './pixels';
import type { PixelData } from './codecs/types';

export function applyOrientation(px: PixelData, orientation: number | undefined): PixelData {
  if (!orientation || orientation === 1) return px;
  if (orientation < 2 || orientation > 8) return px;
  const swaps = orientation >= 5;
  const w = px.width;
  const h = px.height;
  const ow = swaps ? h : w;
  const oh = swaps ? w : h;
  const out = allocate(ow, oh, px.bitDepth);
  const src = px.data;
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number;
      let oy: number;
      switch (orientation) {
        case 2: ox = w - 1 - x; oy = y; break;
        case 3: ox = w - 1 - x; oy = h - 1 - y; break;
        case 4: ox = x; oy = h - 1 - y; break;
        case 5: ox = y; oy = x; break;
        case 6: ox = h - 1 - y; oy = x; break;
        case 7: ox = h - 1 - y; oy = w - 1 - x; break;
        default: ox = y; oy = w - 1 - x; break; // 8
      }
      const si = (y * w + x) * 4;
      const di = (oy * ow + ox) * 4;
      dst[di] = src[si]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
  return out;
}
