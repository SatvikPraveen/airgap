/**
 * Per-engine record of what each codec's probe demonstrates. Runs in every engine CI tests;
 * the README's cross-browser matrix is this table. A change in any engine fails here first.
 */
import { describe, expect, it } from 'vitest';
import { CodecRegistry } from '../../src/codecs/registry';
import type { ImageFormat } from '../../src/codecs/types';
import { ENGINE } from './helpers';

const EXPECTED: Record<typeof ENGINE, Record<ImageFormat, { encoder: string; lossless: boolean; decoderExact: boolean }>> = {
  chromium: {
    png: { encoder: 'airgap-png', lossless: true, decoderExact: true },
    jpeg: { encoder: 'wasm-jpeg', lossless: false, decoderExact: true },
    webp: { encoder: 'wasm-webp', lossless: true, decoderExact: true },
    avif: { encoder: 'wasm-avif', lossless: true, decoderExact: true },
    jxl: { encoder: 'wasm-jxl', lossless: true, decoderExact: true },
    tiff: { encoder: 'utif-tiff', lossless: true, decoderExact: true },
  },
  firefox: {
    png: { encoder: 'airgap-png', lossless: true, decoderExact: true },
    jpeg: { encoder: 'wasm-jpeg', lossless: false, decoderExact: true },
    webp: { encoder: 'wasm-webp', lossless: true, decoderExact: true },
    avif: { encoder: 'wasm-avif', lossless: true, decoderExact: true },
    jxl: { encoder: 'wasm-jxl', lossless: true, decoderExact: true },
    tiff: { encoder: 'utif-tiff', lossless: true, decoderExact: true },
  },
  webkit: {
    png: { encoder: 'airgap-png', lossless: true, decoderExact: true },
    // ImageIO's JPEG decoder rounds differently from libjpeg-turbo, so mozjpeg's decoder
    // cannot be cross-checked and is reported unverified.
    jpeg: { encoder: 'wasm-jpeg', lossless: false, decoderExact: false },
    webp: { encoder: 'wasm-webp', lossless: true, decoderExact: true },
    avif: { encoder: 'wasm-avif', lossless: true, decoderExact: true },
    jxl: { encoder: 'wasm-jxl', lossless: true, decoderExact: true },
    tiff: { encoder: 'utif-tiff', lossless: true, decoderExact: true },
  },
};

describe(`probe outcomes in ${ENGINE}`, () => {
  const registry = new CodecRegistry();
  for (const format of ['png', 'jpeg', 'webp', 'avif', 'jxl', 'tiff'] as ImageFormat[]) {
    it(format, async () => {
      const enc = await registry.resolve(format, 'encode');
      const dec = await registry.resolve(format, 'decode');
      const seen = { encoder: enc.resolved.codecId, lossless: enc.resolved.capabilities.lossless, decoderExact: dec.resolved.capabilities.decodeExact };
      expect(seen, `${dec.resolved.codecId}: ${dec.resolved.probe.detail}`).toEqual(EXPECTED[ENGINE][format]);
    });
  }
});
