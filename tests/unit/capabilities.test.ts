/**
 * Table-driven coverage of computeLosses() over the Phase 3 matrix: every
 * source archetype x every target, through an ideal (fully verified) wasm
 * pipeline, plus the canvas fallback pipeline, plus metadata/ICC modes.
 * Codecs are never named: only capability fields go in.
 */
import { describe, expect, it } from 'vitest';
import {
  computeLosses,
  DEFAULT_MODES,
  isFullyLossless,
  isPixelLossless,
  needsFlatten,
  plannedBitDepth,
  type LossKind,
  type SourceDescription,
  type TargetSpec,
} from '../../src/capabilities';
import type { CodecCapabilities, ImageFormat } from '../../src/codecs/types';
import { canvasCaps, caps, META } from './helpers';

const src = (format: ImageFormat, over: Partial<SourceDescription['metadata']> = {}): SourceDescription => ({
  format,
  metadata: { ...META, ...over },
});

const sources: Record<string, SourceDescription> = {
  'png rgb8': src('png', { sourceLossless: true }),
  'png rgba opaque': src('png', { hasAlpha: true, sourceLossless: true }),
  'png rgba binary alpha': src('png', { hasAlpha: true, hasTransparency: true, sourceLossless: true }),
  'png rgba partial': src('png', { hasAlpha: true, hasTransparency: true, hasSemiTransparency: true, sourceLossless: true }),
  'png rgb16': src('png', { bitDepth: 16, sourceLossless: true }),
  'png rgba16 partial': src('png', { bitDepth: 16, hasAlpha: true, hasTransparency: true, hasSemiTransparency: true, sourceLossless: true }),
  apng: src('png', { isAnimated: true, sourceLossless: true }),
  'jpeg plain': src('jpeg', { sourceLossless: false }),
  'jpeg exif+gps': src('jpeg', { hasExif: true, hasGps: true, orientation: 6, sourceLossless: false }),
  'jpeg icc matrix': src('jpeg', { hasIcc: true, iccKind: 'matrix', sourceLossless: false }),
  'webp lossless alpha partial': src('webp', { hasAlpha: true, hasTransparency: true, hasSemiTransparency: true, sourceLossless: true }),
  'avif 10-bit alpha': src('avif', { bitDepth: 10, hasAlpha: true, hasTransparency: true, hasSemiTransparency: true }),
  'avif 12-bit': src('avif', { bitDepth: 12 }),
  'jxl 8-bit': src('jxl', {}),
  'jxl unknown depth': src('jxl', { bitDepthUncertain: true }),
  'tiff rgb16': src('tiff', { bitDepth: 16, sourceLossless: true }),
  'tiff rgba8 associated alpha': src('tiff', { hasAlpha: true, hasTransparency: true, hasSemiTransparency: true, alphaAssociated: true, sourceLossless: true }),
};

/** Probed capabilities of the wasm codec set, as the Phase 3 registry declares them (all verified). */
const ENC: Record<ImageFormat, CodecCapabilities> = {
  png: caps({ encodeBitDepths: [8, 16] }),
  jpeg: caps({ lossless: false, alpha: false, exactAlpha: false, decodeBitDepth: 8, encodeBitDepths: [8] }),
  webp: caps({ decodeBitDepth: 8, encodeBitDepths: [8] }),
  avif: caps({ decodeBitDepth: 12, encodeBitDepths: [8, 10, 12], metadata: { exif: false, icc: false, xmp: false } }),
  // Reality in Chromium: the @jsquash/jxl pair is off by 1 on some pixels, so neither lossless nor decodeExact is verified.
  jxl: caps({ lossless: false, exactAlpha: false, decodeBitDepth: 8, decodeExact: false, decodeAppliesIcc: true, encodeBitDepths: [8], metadata: { exif: false, icc: false, xmp: false } }),
  tiff: caps({ encodeBitDepths: [8, 16] }),
};
const DEC = ENC;

const targets: Record<string, TargetSpec> = {
  png: { format: 'png', lossless: true, ...DEFAULT_MODES },
  jpeg: { format: 'jpeg', lossless: false, ...DEFAULT_MODES },
  'webp lossless': { format: 'webp', lossless: true, ...DEFAULT_MODES },
  'webp lossy': { format: 'webp', lossless: false, ...DEFAULT_MODES },
  'avif lossless': { format: 'avif', lossless: true, ...DEFAULT_MODES },
  'avif lossy': { format: 'avif', lossless: false, ...DEFAULT_MODES },
  'jxl lossless': { format: 'jxl', lossless: true, ...DEFAULT_MODES },
  'jxl lossy': { format: 'jxl', lossless: false, ...DEFAULT_MODES },
  tiff: { format: 'tiff', lossless: true, ...DEFAULT_MODES },
};

const L = (...k: LossKind[]) => k;
const lossy = 'pixels-lossy' as const;

/** Expected kinds, in order, source x target, default modes (strip-all / strip ICC). */
const expected: Record<string, Record<string, LossKind[]>> = {
  'png rgb8': { png: L(), jpeg: L(lossy), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy), 'jxl lossy': L(lossy), tiff: L() },
  'png rgba opaque': { png: L(), jpeg: L(lossy, 'alpha'), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy), 'jxl lossy': L(lossy), tiff: L() },
  'png rgba binary alpha': { png: L(), jpeg: L(lossy, 'alpha'), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy, 'transparent-color'), 'jxl lossy': L(lossy, 'transparent-color'), tiff: L() },
  'png rgba partial': { png: L(), jpeg: L(lossy, 'alpha'), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy, 'premultiplied-alpha', 'transparent-color'), 'jxl lossy': L(lossy, 'premultiplied-alpha', 'transparent-color'), tiff: L() },
  'png rgb16': { png: L(), jpeg: L(lossy, 'bit-depth'), 'webp lossless': L('bit-depth'), 'webp lossy': L(lossy, 'bit-depth'), 'avif lossless': L('bit-depth'), 'avif lossy': L(lossy, 'bit-depth'), 'jxl lossless': L(lossy, 'bit-depth'), 'jxl lossy': L(lossy, 'bit-depth'), tiff: L() },
  'png rgba16 partial': { png: L(), jpeg: L(lossy, 'bit-depth', 'alpha'), 'webp lossless': L('bit-depth'), 'webp lossy': L(lossy, 'bit-depth'), 'avif lossless': L('bit-depth'), 'avif lossy': L(lossy, 'bit-depth'), 'jxl lossless': L(lossy, 'bit-depth', 'premultiplied-alpha', 'transparent-color'), 'jxl lossy': L(lossy, 'bit-depth', 'premultiplied-alpha', 'transparent-color'), tiff: L() },
  apng: { png: L('animation'), jpeg: L(lossy, 'animation'), 'webp lossless': L('animation'), 'webp lossy': L(lossy, 'animation'), 'avif lossless': L('animation'), 'avif lossy': L(lossy, 'animation'), 'jxl lossless': L(lossy, 'animation'), 'jxl lossy': L(lossy, 'animation'), tiff: L('animation') },
  'jpeg plain': { png: L(), jpeg: L(lossy), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy), 'jxl lossy': L(lossy), tiff: L() },
  'jpeg exif+gps': { png: L('exif'), jpeg: L(lossy, 'exif'), 'webp lossless': L('exif'), 'webp lossy': L(lossy, 'exif'), 'avif lossless': L('exif'), 'avif lossy': L(lossy, 'exif'), 'jxl lossless': L(lossy, 'exif'), 'jxl lossy': L(lossy, 'exif'), tiff: L('exif') },
  'jpeg icc matrix': { png: L('icc'), jpeg: L(lossy, 'icc'), 'webp lossless': L('icc'), 'webp lossy': L(lossy, 'icc'), 'avif lossless': L('icc'), 'avif lossy': L(lossy, 'icc'), 'jxl lossless': L(lossy, 'icc'), 'jxl lossy': L(lossy, 'icc'), tiff: L('icc') },
  'webp lossless alpha partial': { png: L(), jpeg: L(lossy, 'alpha'), 'webp lossless': L(), 'webp lossy': L(lossy), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy, 'premultiplied-alpha', 'transparent-color'), 'jxl lossy': L(lossy, 'premultiplied-alpha', 'transparent-color'), tiff: L() },
  'avif 10-bit alpha': { png: L(), jpeg: L(lossy, 'bit-depth', 'alpha'), 'webp lossless': L('bit-depth'), 'webp lossy': L(lossy, 'bit-depth'), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy, 'bit-depth', 'premultiplied-alpha', 'transparent-color'), 'jxl lossy': L(lossy, 'bit-depth', 'premultiplied-alpha', 'transparent-color'), tiff: L() },
  'avif 12-bit': { png: L(), jpeg: L(lossy, 'bit-depth'), 'webp lossless': L('bit-depth'), 'webp lossy': L(lossy, 'bit-depth'), 'avif lossless': L(), 'avif lossy': L(lossy), 'jxl lossless': L(lossy, 'bit-depth'), 'jxl lossy': L(lossy, 'bit-depth'), tiff: L() },
  'jxl 8-bit': { png: L('decoder-unverified'), jpeg: L(lossy, 'decoder-unverified'), 'webp lossless': L('decoder-unverified'), 'webp lossy': L(lossy, 'decoder-unverified'), 'avif lossless': L('decoder-unverified'), 'avif lossy': L(lossy, 'decoder-unverified'), 'jxl lossless': L(lossy, 'decoder-unverified'), 'jxl lossy': L(lossy, 'decoder-unverified'), tiff: L('decoder-unverified') },
  'jxl unknown depth': { png: L('bit-depth-unknown', 'decoder-unverified'), jpeg: L(lossy, 'bit-depth-unknown', 'decoder-unverified'), 'webp lossless': L('bit-depth-unknown', 'decoder-unverified'), 'webp lossy': L(lossy, 'bit-depth-unknown', 'decoder-unverified'), 'avif lossless': L('bit-depth-unknown', 'decoder-unverified'), 'avif lossy': L(lossy, 'bit-depth-unknown', 'decoder-unverified'), 'jxl lossless': L(lossy, 'bit-depth-unknown', 'decoder-unverified'), 'jxl lossy': L(lossy, 'bit-depth-unknown', 'decoder-unverified'), tiff: L('bit-depth-unknown', 'decoder-unverified') },
  'tiff rgb16': { png: L(), jpeg: L(lossy, 'bit-depth'), 'webp lossless': L('bit-depth'), 'webp lossy': L(lossy, 'bit-depth'), 'avif lossless': L('bit-depth'), 'avif lossy': L(lossy, 'bit-depth'), 'jxl lossless': L(lossy, 'bit-depth'), 'jxl lossy': L(lossy, 'bit-depth'), tiff: L() },
  'tiff rgba8 associated alpha': { png: L('associated-alpha'), jpeg: L(lossy, 'alpha', 'associated-alpha'), 'webp lossless': L('associated-alpha'), 'webp lossy': L(lossy, 'associated-alpha'), 'avif lossless': L('associated-alpha'), 'avif lossy': L(lossy, 'associated-alpha'), 'jxl lossless': L(lossy, 'premultiplied-alpha', 'transparent-color', 'associated-alpha'), 'jxl lossy': L(lossy, 'premultiplied-alpha', 'transparent-color', 'associated-alpha'), tiff: L('associated-alpha') },
};

describe('computeLosses: Phase 3 matrix through verified wasm codecs', () => {
  for (const [sName, source] of Object.entries(sources)) {
    for (const [tName, target] of Object.entries(targets)) {
      it(`${sName} -> ${tName}`, () => {
        const losses = computeLosses(source, target, { decoder: DEC[source.format], encoder: ENC[target.format] });
        expect(losses.map((l) => l.kind)).toEqual(expected[sName]![tName]);
        for (const l of losses) expect(l.message.length).toBeGreaterThan(20);
      });
    }
  }
  it('the matrix covers every source and target exactly once', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(sources).sort());
    for (const row of Object.values(expected)) expect(Object.keys(row).sort()).toEqual(Object.keys(targets).sort());
  });
});

describe('computeLosses: canvas fallback pipeline (exactAlpha false, 8-bit)', () => {
  const cv = { decoder: canvasCaps('png'), encoder: canvasCaps('png') };
  it('RGB under alpha 0 is a PIXELS loss that trips lossless-only', () => {
    const l = computeLosses(sources['png rgba binary alpha']!, targets.png!, cv);
    expect(l.map((x) => x.kind)).toEqual(['transparent-color']);
    expect(l[0]!.severity).toBe('pixels');
    expect(isPixelLossless(l)).toBe(false);
  });
  it('semi-transparent sources list both alpha losses', () => {
    const l = computeLosses(sources['png rgba partial']!, targets.png!, cv);
    expect(l.map((x) => x.kind)).toEqual(['premultiplied-alpha', 'transparent-color']);
  });
  it('names the side at fault: exact decoder + canvas encoder', () => {
    const l = computeLosses(sources['png rgba partial']!, targets.png!, { decoder: ENC.png, encoder: canvasCaps('png') });
    expect(l[0]!.message).toMatch(/^The encoder in use/);
    const m = computeLosses(sources['png rgba partial']!, targets.png!, { decoder: canvasCaps('png'), encoder: ENC.png });
    expect(m[0]!.message).toMatch(/^The decoder in use/);
  });
  it('16-bit source through an 8-bit decoder is a decoder-side bit-depth loss', () => {
    const l = computeLosses(sources['png rgb16']!, targets.png!, { decoder: canvasCaps('png'), encoder: ENC.png });
    expect(l.map((x) => x.kind)).toEqual(['bit-depth']);
    expect(l[0]!.message).toMatch(/the decoder/);
    expect(plannedBitDepth(16, { decoder: canvasCaps('png'), encoder: ENC.png })).toBe(8);
  });
  it('a lossless target whose encoder failed the lossless probe is flagged lossy', () => {
    const l = computeLosses(sources['png rgb8']!, targets['webp lossless']!, { decoder: ENC.png, encoder: caps({ lossless: false, exactAlpha: false }) });
    expect(l.map((x) => x.kind)).toEqual(['pixels-lossy']);
    expect(l[0]!.message).toMatch(/could not be verified/);
  });
});

describe('metadata modes', () => {
  const s = sources['jpeg exif+gps']!;
  const withXmp = src('jpeg', { hasExif: true, hasGps: true, hasXmp: true, orientation: 1 });
  const mode = (metadataMode: TargetSpec['metadataMode'], format: ImageFormat = 'png'): TargetSpec => ({ format, lossless: true, metadataMode, iccMode: 'strip' });
  const pipe = (format: ImageFormat = 'png') => ({ decoder: DEC.jpeg, encoder: ENC[format] });

  it('strip-all: EXIF and XMP removed', () => {
    expect(computeLosses(withXmp, mode('strip-all'), pipe()).map((l) => l.kind)).toEqual(['exif', 'xmp']);
  });
  it('strip-gps: only GPS goes, orientation is normalised, XMP goes with a reason', () => {
    const l = computeLosses(s, mode('strip-gps'), pipe());
    expect(l.map((x) => x.kind)).toEqual(['gps', 'orientation']);
    expect(l.every((x) => x.severity === 'metadata')).toBe(true);
    const x = computeLosses(withXmp, mode('strip-gps'), pipe());
    expect(x.map((y) => y.kind)).toEqual(['gps', 'xmp']);
    expect(x[1]!.message).toMatch(/location/);
  });
  it('preserve: only the orientation tag is altered, and the message says so', () => {
    const l = computeLosses(s, mode('preserve'), pipe());
    expect(l.map((x) => x.kind)).toEqual(['orientation']);
    expect(l[0]!.message).toMatch(/rewritten to 1/);
    expect(computeLosses(withXmp, mode('preserve'), pipe())).toEqual([]);
  });
  it('preserve into a target whose encoder cannot carry EXIF says so (and names GPS)', () => {
    const l = computeLosses(s, mode('preserve', 'avif'), pipe('avif'));
    expect(l.map((x) => x.kind)).toEqual(['exif']);
    expect(l[0]!.message).toMatch(/encoder in use cannot embed/);
    expect(l[0]!.message).toMatch(/GPS/);
  });
  it('GPS-less EXIF in strip-gps mode lists nothing but orientation', () => {
    const noGps = src('jpeg', { hasExif: true, orientation: 1 });
    expect(computeLosses(noGps, mode('strip-gps'), pipe())).toEqual([]);
  });
});

describe('ICC modes', () => {
  const matrix = sources['jpeg icc matrix']!;
  const lut = src('jpeg', { hasIcc: true, iccKind: 'lut' });
  const t = (iccMode: TargetSpec['iccMode'], format: ImageFormat = 'png'): TargetSpec => ({ format, lossless: true, metadataMode: 'strip-all', iccMode });
  const pipe = (format: ImageFormat = 'png') => ({ decoder: DEC.jpeg, encoder: ENC[format] });

  it('strip: metadata loss stating values kept, appearance not', () => {
    const l = computeLosses(matrix, t('strip'), pipe());
    expect(l.map((x) => x.kind)).toEqual(['icc']);
    expect(l[0]!.severity).toBe('metadata');
    expect(l[0]!.message).toMatch(/Values preserved, appearance not/);
  });
  it('preserve: nothing lost when the encoder can embed; loss when it cannot', () => {
    expect(computeLosses(matrix, t('preserve'), pipe())).toEqual([]);
    const l = computeLosses(matrix, t('preserve', 'avif'), pipe('avif'));
    expect(l.map((x) => x.kind)).toEqual(['icc']);
    expect(l[0]!.message).toMatch(/cannot embed/);
  });
  it('convert-srgb on a matrix profile: PIXELS loss stating appearance kept, values changed', () => {
    const l = computeLosses(matrix, t('convert-srgb'), pipe());
    expect(l.map((x) => x.kind)).toEqual(['icc-convert']);
    expect(l[0]!.severity).toBe('pixels');
    expect(l[0]!.message).toMatch(/Appearance is preserved; values change/);
    expect(isPixelLossless(l)).toBe(false);
  });
  it('convert-srgb on a LUT profile is refused, never approximated', () => {
    const l = computeLosses(lut, t('convert-srgb'), pipe());
    expect(l.map((x) => x.kind)).toEqual(['icc-convert-unavailable']);
    expect(l[0]!.message).toMatch(/will not approximate/);
  });
  it('a decoder that applies ICC itself reports the conversion regardless of mode', () => {
    const jxlIcc = src('jxl', { hasIcc: true });
    for (const m of ['strip', 'preserve', 'convert-srgb'] as const) {
      const l = computeLosses(jxlIcc, t(m), { decoder: { ...DEC.jxl, decodeExact: true }, encoder: ENC.png });
      expect(l.map((x) => x.kind)).toEqual(['icc-convert']);
      expect(l[0]!.message).toMatch(/decoder in use converts/);
    }
  });
  it('AVIF rotation properties are a pixel loss', () => {
    const l = computeLosses(src('avif', { hasTransformProperties: true }), targets.png!, { decoder: DEC.avif, encoder: ENC.png });
    expect(l.map((x) => x.kind)).toEqual(['transform-properties']);
  });
});

describe('helpers', () => {
  it('needsFlatten reads the encoder alpha capability only', () => {
    expect(needsFlatten(sources['png rgba partial']!, ENC.jpeg)).toBe(true);
    expect(needsFlatten(sources['png rgba partial']!, ENC.png)).toBe(false);
    expect(needsFlatten(sources['png rgb8']!, ENC.jpeg)).toBe(false);
  });
  it('plannedBitDepth picks the smallest encoder depth that fits, else the largest', () => {
    expect(plannedBitDepth(10, { decoder: DEC.avif, encoder: ENC.avif })).toBe(10);
    expect(plannedBitDepth(16, { decoder: DEC.png, encoder: ENC.avif })).toBe(12);
    expect(plannedBitDepth(8, { decoder: DEC.png, encoder: ENC.png })).toBe(8);
    expect(plannedBitDepth(12, { decoder: DEC.avif, encoder: ENC.png })).toBe(16);
  });
  it('isFullyLossless only when the list is empty', () => {
    expect(isFullyLossless(computeLosses(sources['png rgb8']!, targets.png!, { decoder: DEC.png, encoder: ENC.png }))).toBe(true);
    expect(isFullyLossless(computeLosses(sources['jpeg exif+gps']!, targets.png!, { decoder: DEC.jpeg, encoder: ENC.png }))).toBe(false);
  });
});
