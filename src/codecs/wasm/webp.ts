/** WebP via @jsquash/webp (libwebp). Lossless with `exact: 1` so RGB under alpha 0 survives. */
import { injectMetadata } from '../../metadata/containers';
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
    },
    async decode(bytes) {
      const m = await decoder();
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
      const out = mod.encode(u8view(img.pixels), img.pixels.width, img.pixels.height, options);
      if (!out) throw new Error('libwebp encoding failed');
      let bytes: Uint8Array = new Uint8Array(out);
      if (opts.exif || opts.icc || opts.xmp) {
        bytes = injectMetadata(bytes, 'webp', { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
      }
      return bytes;
    },
  };
}
