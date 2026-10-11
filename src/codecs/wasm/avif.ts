/**
 * AVIF via Airgap's own libavif 1.4.2 + libaom 3.15.2 build (libavif.ts): stills and image
 * sequences (animated AVIF), 8, 10 and 12-bit. Lossless = 4:4:4, identity matrix, lossless
 * quantiser. Durations are kept as exact fractions (an integer timescale).
 */
import { alphaStats } from '../../pixels';
import type { Animation, Codec, EncodeOptions } from '../types';
import { animationTiming, decodeAvif, encodeAvif, loadLibavif } from './libavif';
import { asDecoded, buildMetadata } from './shared';

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export async function createWasmAvifCodec(): Promise<Codec> {
  const m = await loadLibavif();
  return {
    id: 'libavif',
    format: 'avif',
    capabilities: {
      decode: true,
      encode: true,
      lossless: true,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 12,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [8, 10, 12],
      metadata: { exif: false, icc: false, xmp: false },
      animation: true,
    },
    async decode(bytes) {
      const d = decodeAvif(m, bytes);
      const pixels = d.frames[0]!;
      const metadata = buildMetadata(bytes, 'avif', pixels);
      if (d.frames.length < 2) return asDecoded(pixels, metadata);
      const animation: Animation = {
        frames: d.frames.map((px, i) => {
          // Exact fraction num/timescale, reduced, kept within APNG's 16-bit fields where possible.
          const num = d.durations[i]!;
          const g = gcd(num, d.timescale) || 1;
          return { pixels: px, delayNum: num / g, delayDen: d.timescale / g };
        }),
        loops: d.loops,
        hiddenDefault: false,
      };
      metadata.isAnimated = true;
      metadata.animationInfo = {
        frames: d.frames.length,
        loops: d.loops,
        durationMs: Math.round(d.durations.reduce((t, n) => t + (1000 * n) / d.timescale, 0)),
        hiddenDefault: false,
        delaysWholeMs: d.durations.every((n) => (1000 * n) % d.timescale === 0),
      };
      if (metadata.hasAlpha) {
        for (const f of d.frames) {
          const st = alphaStats(f);
          metadata.hasTransparency ||= st.hasTransparency;
          metadata.hasSemiTransparency ||= st.hasSemiTransparency;
        }
      }
      return { pixels, metadata, animation };
    },
    async encode(img, opts: EncodeOptions) {
      const o = { lossless: !!opts.lossless, ...(opts.quality !== undefined && { quality: opts.quality }) };
      if (!img.animation) return encodeAvif(m, [img.pixels], img.metadata.hasAlpha, o);
      const t = animationTiming(img.animation);
      return encodeAvif(m, img.animation.frames.map((f) => f.pixels), img.metadata.hasAlpha, o, { timescale: t.timescale, durations: t.durations, loops: img.animation.loops });
    },
  };
}
