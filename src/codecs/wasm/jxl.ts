/** JPEG XL via @jsquash/jxl (libjxl snapshot, 8-bit RGBA). The decoder applies orientation and ICC itself. */
import type { Codec, EncodeOptions } from '../types';
import { asDecoded, buildMetadata, compileWasm, defaults, fromImageData, initEmscripten, u8view, type Bytes } from './shared';

type DecModule = { decode(data: Bytes): ImageData | null };
type EncModule = { encode(data: Bytes, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };

export async function createWasmJxlCodec(): Promise<Codec> {
  let dec: Promise<DecModule> | undefined;
  let enc: Promise<{ mod: EncModule; defaults: Record<string, unknown> }> | undefined;
  const decoder = () =>
    (dec ??= Promise.all([import('@jsquash/jxl/codec/dec/jxl_dec.js'), import('@jsquash/jxl/codec/dec/jxl_dec.wasm?b64')]).then(
      async ([m, { default: b64 }]) => initEmscripten<DecModule>(m.default as never, await compileWasm(b64)),
    ));
  const encoder = () =>
    (enc ??= Promise.all([import('@jsquash/jxl/codec/enc/jxl_enc.js'), import('@jsquash/jxl/codec/enc/jxl_enc.wasm?b64'), import('@jsquash/jxl/meta.js')]).then(
      async ([m, { default: b64 }, meta]) => ({ mod: await initEmscripten<EncModule>(m.default as never, await compileWasm(b64)), defaults: defaults(meta) }),
    ));

  return {
    id: 'wasm-jxl',
    format: 'jxl',
    capabilities: {
      decode: true,
      encode: true,
      lossless: true,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 8,
      decodeExact: true,
      decodeAppliesIcc: true,
      encodeBitDepths: [8],
      metadata: { exif: false, icc: false, xmp: false },
    },
    async decode(bytes) {
      const m = await decoder();
      const img = m.decode(bytes);
      if (!img) throw new Error('libjxl could not decode this JPEG XL file.');
      const pixels = fromImageData(img);
      return asDecoded(pixels, buildMetadata(bytes, 'jxl', pixels, { orientationApplied: true }));
    },
    async encode(img, opts: EncodeOptions) {
      if (img.pixels.bitDepth !== 8) throw new Error('JPEG XL encoder takes 8-bit input.');
      const { mod, defaults } = await encoder();
      const q = Math.round(Math.min(1, Math.max(0, opts.quality ?? 0.75)) * 100);
      const options = opts.lossless
        ? { ...defaults, lossless: true, quality: 100, lossyModular: false, lossyPalette: false }
        : { ...defaults, lossless: false, quality: q };
      const out = mod.encode(u8view(img.pixels), img.pixels.width, img.pixels.height, options);
      if (!out) throw new Error('libjxl encoding failed');
      return new Uint8Array(out);
    },
  };
}
