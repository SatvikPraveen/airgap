/** WebP via @jsquash/webp (libwebp). Lossless with `exact: 1` so RGB under alpha 0 survives. */
import { injectMetadata } from '../../metadata/containers';
import { alphaStats } from '../../pixels';
import { decodeAnimatedWebp, encodeAnimatedWebp, isAnimatedWebp } from '../webp-anim';
import type { Codec, EncodeOptions } from '../types';
import { asDecoded, buildMetadata, compileWasm, defaults, fromImageData, initEmscripten, u8view, type Bytes } from './shared';

type DecModule = { decode(data: Bytes): ImageData | null };
type EncModule = { encode(data: Bytes, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };

export async function createWasmWebpCodec(): Promise<Codec> {
  let dec: Promise<DecModule> | undefined;
  let enc: Promise<{ mod: EncModule; defaults: Record<string, unknown> }> | undefined;
  const decoder = () =>
    (dec ??= Promise.all([import('@jsquash/webp/codec/dec/webp_dec.js'), import('@jsquash/webp/codec/dec/webp_dec.wasm?b64')]).then(
      async ([m, { default: b64 }]) => initEmscripten<DecModule>(m.default as never, await compileWasm(b64)),
    ));
  const encoder = () =>
    (enc ??= Promise.all([import('@jsquash/webp/codec/enc/webp_enc.js'), import('@jsquash/webp/codec/enc/webp_enc.wasm?b64'), import('@jsquash/webp/meta.js')]).then(
      async ([m, { default: b64 }, meta]) => ({ mod: await initEmscripten<EncModule>(m.default as never, await compileWasm(b64)), defaults: defaults(meta) }),
    ));

  return {
    id: 'wasm-webp',
    format: 'webp',
    capabilities: {
      decode: true,
      encode: true,
      lossless: true,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 8,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [8],
      metadata: { exif: true, icc: true, xmp: true },
      animation: true,
    },
    async decode(bytes) {
      const m = await decoder();
      if (isAnimatedWebp(bytes)) {
        // Every frame through libwebp's still decoder, composited as libwebp's animation decoder does.
        const animation = (await decodeAnimatedWebp(bytes, async (still) => {
          const f = m.decode(still);
          if (!f) throw new Error('libwebp could not decode a frame of this animated WebP.');
          return fromImageData(f);
        }))!;
        const pixels = animation.frames[0]!.pixels;
        const metadata = buildMetadata(bytes, 'webp', pixels);
        if (metadata.hasAlpha) {
          for (const f of animation.frames) {
            const st = alphaStats(f.pixels);
            metadata.hasTransparency ||= st.hasTransparency;
            metadata.hasSemiTransparency ||= st.hasSemiTransparency;
          }
        }
        return { pixels, metadata, animation };
      }
      const img = m.decode(bytes);
      if (!img) throw new Error('libwebp could not decode this WebP (animated WebP is not supported by this decoder).');
      const pixels = fromImageData(img);
      return asDecoded(pixels, buildMetadata(bytes, 'webp', pixels));
    },
    async encode(img, opts: EncodeOptions) {
      if (img.pixels.bitDepth !== 8) throw new Error('WebP encoder takes 8-bit input.');
      const { mod, defaults } = await encoder();
      const options = opts.lossless
        ? { ...defaults, lossless: 1, exact: 1, quality: 100, method: 4 }
        : { ...defaults, lossless: 0, exact: 1, quality: Math.round(Math.min(1, Math.max(0, opts.quality ?? 0.9)) * 100) };
      const encodeStill = (px: typeof img.pixels) => {
        const out = mod.encode(u8view(px), px.width, px.height, options);
        if (!out) throw new Error('libwebp encoding failed');
        return new Uint8Array(out);
      };
      let bytes: Uint8Array = img.animation ? await encodeAnimatedWebp(img.animation, async (px) => encodeStill(px), img.metadata.hasAlpha) : encodeStill(img.pixels);
      if (opts.exif || opts.icc || opts.xmp) {
        bytes = injectMetadata(bytes, 'webp', { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
      }
      return bytes;
    },
  };
}
