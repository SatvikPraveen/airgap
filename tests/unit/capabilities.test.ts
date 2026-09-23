/**
 * Table-driven coverage of computeLosses() over the whole Phase 1 matrix:
 * every source archetype x every target, with the canvas codec's capabilities.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLosses,
  isFullyLossless,
  isPixelLossless,
  needsFlatten,
  type LossKind,
  type SourceDescription,
  type TargetSpec,
} from '../../src/capabilities';
import { canvasCapabilities } from '../../src/codecs/canvas-capabilities';
import type { ImageMetadata } from '../../src/codecs/types';

const base: ImageMetadata = {
  bitDepth: 8,
  hasAlpha: false,
  hasTransparency: false,
  hasSemiTransparency: false,
  hasExif: false,
  hasGps: false,
  hasIcc: false,
  isAnimated: false,
};

const sources: Record<string, SourceDescription> = {
  'png rgb8': { format: 'png', metadata: { ...base, sourceLossless: true } },
  'png rgba opaque': {
    format: 'png',
    metadata: { ...base, hasAlpha: true, sourceLossless: true },
  },
  'png rgba binary alpha': {
    format: 'png',
    metadata: { ...base, hasAlpha: true, hasTransparency: true, sourceLossless: true },
  },
  'png rgba partial': {
    format: 'png',
    metadata: {
      ...base,
      hasAlpha: true,
      hasTransparency: true,
      hasSemiTransparency: true,
      sourceLossless: true,
    },
  },
  'png rgb16': { format: 'png', metadata: { ...base, bitDepth: 16, sourceLossless: true } },
  'png rgba16 partial + icc': {
    format: 'png',
    metadata: {
      ...base,
      bitDepth: 16,
      hasAlpha: true,
      hasTransparency: true,
      hasSemiTransparency: true,
      hasIcc: true,
      sourceLossless: true,
    },
  },
  'apng': { format: 'png', metadata: { ...base, isAnimated: true, sourceLossless: true } },
  'jpeg plain': { format: 'jpeg', metadata: { ...base, sourceLossless: false } },
  'jpeg exif+gps': {
    format: 'jpeg',
    metadata: { ...base, hasExif: true, hasGps: true, orientation: 6, sourceLossless: false },
  },
  'jpeg icc': { format: 'jpeg', metadata: { ...base, hasIcc: true, sourceLossless: false } },
  'webp lossless alpha partial': {
    format: 'webp',
    metadata: {
      ...base,
      hasAlpha: true,
      hasTransparency: true,
      hasSemiTransparency: true,
      sourceLossless: true,
    },
  },
  'webp lossy': { format: 'webp', metadata: { ...base, sourceLossless: false } },
  'webp animated exif': {
    format: 'webp',
    metadata: { ...base, isAnimated: true, hasExif: true, sourceLossless: false },
  },
};

const targets: Record<string, TargetSpec> = {
  png: { format: 'png', lossless: true },
  jpeg: { format: 'jpeg', lossless: false },
  'webp lossless': { format: 'webp', lossless: true },
  'webp lossy': { format: 'webp', lossless: false },
};

const capsWith = (webpLossless: boolean) => ({
  png: canvasCapabilities('png', webpLossless),
  jpeg: canvasCapabilities('jpeg', webpLossless),
  webp: canvasCapabilities('webp', webpLossless),
});

/**
 * Expected loss kinds, in order, for [source][target] with a browser whose
 * WebP encoder IS lossless at quality 1 (Chromium: verified by the browser tests).
 */
const expected: Record<string, Record<string, LossKind[]>> = {
  'png rgb8': {
    png: [],
    jpeg: ['pixels-lossy'],
    'webp lossless': [],
    'webp lossy': ['pixels-lossy'],
  },
  'png rgba opaque': {
    png: [],
    jpeg: ['pixels-lossy', 'alpha'],
    'webp lossless': [],
    'webp lossy': ['pixels-lossy'],
  },
  'png rgba binary alpha': {
    png: ['transparent-color'],
    jpeg: ['pixels-lossy', 'alpha'],
    'webp lossless': ['transparent-color'],
    'webp lossy': ['pixels-lossy', 'transparent-color'],
  },
  'png rgba partial': {
    png: ['premultiplied-alpha', 'transparent-color'],
    jpeg: ['pixels-lossy', 'alpha'],
    'webp lossless': ['premultiplied-alpha', 'transparent-color'],
    'webp lossy': ['pixels-lossy', 'premultiplied-alpha', 'transparent-color'],
  },
  'png rgb16': {
    png: ['bit-depth'],
    jpeg: ['pixels-lossy', 'bit-depth'],
    'webp lossless': ['bit-depth'],
    'webp lossy': ['pixels-lossy', 'bit-depth'],
  },
  'png rgba16 partial + icc': {
    png: ['bit-depth', 'premultiplied-alpha', 'transparent-color', 'icc'],
    jpeg: ['pixels-lossy', 'bit-depth', 'alpha', 'icc'],
    'webp lossless': ['bit-depth', 'premultiplied-alpha', 'transparent-color', 'icc'],
    'webp lossy': ['pixels-lossy', 'bit-depth', 'premultiplied-alpha', 'transparent-color', 'icc'],
  },
  apng: {
    png: ['animation'],
    jpeg: ['pixels-lossy', 'animation'],
    'webp lossless': ['animation'],
    'webp lossy': ['pixels-lossy', 'animation'],
  },
  'jpeg plain': {
    png: [],
    jpeg: ['pixels-lossy'],
    'webp lossless': [],
    'webp lossy': ['pixels-lossy'],
  },
  'jpeg exif+gps': {
    png: ['exif'],
    jpeg: ['pixels-lossy', 'exif'],
    'webp lossless': ['exif'],
    'webp lossy': ['pixels-lossy', 'exif'],
  },
  'jpeg icc': {
    png: ['icc'],
    jpeg: ['pixels-lossy', 'icc'],
    'webp lossless': ['icc'],
    'webp lossy': ['pixels-lossy', 'icc'],
  },
  'webp lossless alpha partial': {
    png: ['premultiplied-alpha', 'transparent-color'],
    jpeg: ['pixels-lossy', 'alpha'],
    'webp lossless': ['premultiplied-alpha', 'transparent-color'],
    'webp lossy': ['pixels-lossy', 'premultiplied-alpha', 'transparent-color'],
  },
  'webp lossy': {
    png: [],
    jpeg: ['pixels-lossy'],
    'webp lossless': [],
    'webp lossy': ['pixels-lossy'],
  },
  'webp animated exif': {
    png: ['animation', 'exif'],
    jpeg: ['pixels-lossy', 'animation', 'exif'],
    'webp lossless': ['animation', 'exif'],
    'webp lossy': ['pixels-lossy', 'animation', 'exif'],
  },
};

describe('computeLosses: Phase 1 matrix (WebP lossless available)', () => {
  const caps = capsWith(true);
  for (const [sName, source] of Object.entries(sources)) {
    for (const [tName, target] of Object.entries(targets)) {
      it(`${sName} -> ${tName}`, () => {
        const losses = computeLosses(source, target, caps[target.format]);
        expect(losses.map((l) => l.kind)).toEqual(expected[sName]![tName]);
        // Every loss has a human-readable message.
        for (const l of losses) expect(l.message.length).toBeGreaterThan(20);
      });
    }
  }

  it('the matrix covers every source and target exactly once', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(sources).sort());
    for (const row of Object.values(expected)) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(targets).sort());
    }
  });
});

describe('computeLosses: browser WITHOUT lossless WebP', () => {
  const caps = capsWith(false);
  it('WebP "lossless" target is reported as lossy, with the browser-specific message', () => {
    const losses = computeLosses(sources['png rgb8']!, targets['webp lossless']!, caps.webp);
    expect(losses.map((l) => l.kind)).toEqual(['pixels-lossy']);
    expect(losses[0]!.message).toMatch(/not available in this browser/);
    expect(isPixelLossless(losses)).toBe(false);
  });
  it('PNG is unaffected', () => {
    expect(computeLosses(sources['png rgb8']!, targets.png!, caps.png)).toEqual([]);
  });
});

describe('severity classification', () => {
  const caps = capsWith(true);
  it('pixel-lossless allows hidden and metadata losses but not pixel losses', () => {
    const l1 = computeLosses(sources['jpeg exif+gps']!, targets.png!, caps.png);
    expect(isPixelLossless(l1)).toBe(true);
    expect(isFullyLossless(l1)).toBe(false);
    const l2 = computeLosses(sources['png rgba binary alpha']!, targets.png!, caps.png);
    expect(isPixelLossless(l2)).toBe(true);
    expect(l2[0]!.severity).toBe('hidden');
    const l3 = computeLosses(sources['png rgba partial']!, targets.png!, caps.png);
    expect(isPixelLossless(l3)).toBe(false);
    const l4 = computeLosses(sources['png rgb16']!, targets.png!, caps.png);
    expect(isPixelLossless(l4)).toBe(false);
  });
  it('fully lossless only when the list is empty', () => {
    expect(isFullyLossless(computeLosses(sources['png rgb8']!, targets.png!, caps.png))).toBe(true);
  });
  it('EXIF message names GPS when present', () => {
    const l = computeLosses(sources['jpeg exif+gps']!, targets.png!, caps.png);
    expect(l.find((x) => x.kind === 'exif')!.message).toMatch(/GPS/);
    const m = computeLosses(sources['webp animated exif']!, targets.png!, caps.png);
    expect(m.find((x) => x.kind === 'exif')!.message).not.toMatch(/GPS/);
  });
  it('alpha message distinguishes opaque alpha from real transparency', () => {
    const opaque = computeLosses(sources['png rgba opaque']!, targets.jpeg!, caps.jpeg);
    expect(opaque.find((x) => x.kind === 'alpha')!.message).toMatch(/fully opaque/);
    const partial = computeLosses(sources['png rgba partial']!, targets.jpeg!, caps.jpeg);
    expect(partial.find((x) => x.kind === 'alpha')!.message).toMatch(/background colour/);
  });
});

describe('needsFlatten', () => {
  const caps = capsWith(true);
  it('is true only for alpha sources into an alpha-less target', () => {
    expect(needsFlatten(sources['png rgba opaque']!, caps.jpeg)).toBe(true);
    expect(needsFlatten(sources['png rgba partial']!, caps.jpeg)).toBe(true);
    expect(needsFlatten(sources['png rgb8']!, caps.jpeg)).toBe(false);
    expect(needsFlatten(sources['png rgba partial']!, caps.png)).toBe(false);
    expect(needsFlatten(sources['png rgba partial']!, caps.webp)).toBe(false);
  });
});
