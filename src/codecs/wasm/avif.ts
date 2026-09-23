/** AVIF via @jsquash/avif (libavif + aom). Lossless = quality 100, YUV444, identity matrix. */
import { inspect } from '../../inspect';
import type { Codec, EncodeOptions, PixelData } from '../types';
import { asDecoded, buildMetadata, compileWasm, defaults, fromImageData, initEmscripten, u8view, type Bytes } from './shared';

type DecModule = { decode(data: Bytes, bitDepth: number): ImageData | { data: Uint16Array; width: number; height: number } | null };
type EncModule = { encode(data: Bytes, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };

export async function createWasmAvifCodec(): Promise<Codec> {
  let dec: Promise<DecModule> | undefined;
  let enc: Promise<{ mod: EncModule; defaults: Record<string, unknown> }> | undefined;
  const decoder = () =>
    (dec ??= Promise.all([import('@jsquash/avif/codec/dec/avif_dec.js'), import('@jsquash/avif/codec/dec/avif_dec.wasm?b64')]).then(
      async ([m, { default: b64 }]) => initEmscripten<DecModule>(m.default as never, await compileWasm(b64)),
    ));
  const encoder = () =>
    (enc ??= Promise.all([import('@jsquash/avif/codec/enc/avif_enc.js'), import('@jsquash/avif/codec/enc/avif_enc.wasm?b64'), import('@jsquash/avif/meta.js')]).then(
      async ([m, { default: b64 }, meta]) => ({ mod: await initEmscripten<EncModule>(m.default as never, await compileWasm(b64)), defaults: defaults(meta) }),
    ));

  return {
    id: 'wasm-avif',
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
    },
    async decode(bytes) {
      const m = await decoder();
      const header = inspect(bytes);
      const depth = header.metadata.bitDepthUncertain ? 8 : header.metadata.bitDepth;
      const img = m.decode(bytes, depth === 8 ? 8 : depth);
      if (!img) throw new Error('libavif could not decode this AVIF.');
      const pixels: PixelData =
        img.data instanceof Uint16Array
          ? { width: img.width, height: img.height, bitDepth: depth, data: img.data }
          : fromImageData(img as ImageData);
      return asDecoded(pixels, buildMetadata(bytes, 'avif', pixels));
    },
    async encode(img, opts: EncodeOptions) {
      const { mod, defaults } = await encoder();
      const px = img.pixels;
      if (![8, 10, 12].includes(px.bitDepth)) throw new Error(`AVIF encoder takes 8, 10 or 12-bit input, got ${px.bitDepth}`);
      const q = Math.round(Math.min(1, Math.max(0, opts.quality ?? 0.6)) * 100);
      const options = opts.lossless
        ? { ...defaults, quality: 100, qualityAlpha: -1, subsample: 3, bitDepth: px.bitDepth, speed: 6 }
        : { ...defaults, quality: q, qualityAlpha: -1, subsample: 1, bitDepth: px.bitDepth, speed: 6 };
      const out = mod.encode(u8view(px), px.width, px.height, options);
      if (!out) throw new Error('libavif encoding failed');
      return new Uint8Array(out);
    },
  };
}
