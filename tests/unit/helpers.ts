import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodecCapabilities, ImageMetadata, PixelData } from '../../src/codecs/types';
import { allocate } from '../../src/pixels';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(here, '..', 'fixtures', name)));
export const fixturePath = (name: string): string => join(here, '..', 'fixtures', name);

export const META: ImageMetadata = {
  bitDepth: 8,
  hasAlpha: false,
  hasTransparency: false,
  hasSemiTransparency: false,
  hasExif: false,
  hasGps: false,
  hasIcc: false,
  hasXmp: false,
  isAnimated: false,
};

/** Capabilities of an ideal, fully verified codec. */
export function caps(over: Partial<CodecCapabilities> = {}): CodecCapabilities {
  return {
    decode: true,
    encode: true,
    lossless: true,
    alpha: true,
    exactAlpha: true,
    decodeBitDepth: 16,
    decodeExact: true,
    decodeAppliesIcc: false,
    encodeBitDepths: [8, 16],
    metadata: { exif: true, icc: true, xmp: true },
    ...over,
  };
}

/** What the probed canvas codec looks like. */
export function canvasCaps(format: 'png' | 'jpeg' | 'webp'): CodecCapabilities {
  return caps({
    lossless: format !== 'jpeg',
    alpha: format !== 'jpeg',
    exactAlpha: false,
    decodeBitDepth: 8,
    encodeBitDepths: [8],
  });
}

export function pixelsFrom(values: number[], width: number, height: number, bitDepth = 8): PixelData {
  const px = allocate(width, height, bitDepth);
  px.data.set(values);
  return px;
}

export function rasterFrom(dims: { width: number; height: number }, fill: (x: number, y: number) => number[], bitDepth = 8): PixelData {
  const px = allocate(dims.width, dims.height, bitDepth);
  const max = (1 << bitDepth) - 1;
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const [r, g, b, a = max] = fill(x, y);
      px.data.set([r!, g!, b!, a], (y * dims.width + x) * 4);
    }
  }
  return px;
}
