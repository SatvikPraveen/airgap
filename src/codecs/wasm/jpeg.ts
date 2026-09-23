/** JPEG via @jsquash/jpeg (mozjpeg). Decode is exact RGB; encode is lossy by nature. */
import { injectMetadata } from '../../metadata/containers';
import type { Codec, EncodeOptions } from '../types';
import { asDecoded, buildMetadata, compileWasm, defaults, fromImageData, initEmscripten, u8view, type Bytes } from './shared';

type DecModule = { decode(data: Bytes, preserveOrientation: boolean): ImageData | null };
type EncModule = { encode(data: Bytes, width: number, height: number, options: Record<string, unknown>): Uint8Array | null };

export async function createWasmJpegCodec(): Promise<Codec> {
  let dec: Promise<DecModule> | undefined;
  let enc: Promise<EncModule> | undefined;
  const decoder = () =>
    (dec ??= Promise.all([import('@jsquash/jpeg/codec/dec/mozjpeg_dec.js'), import('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm?b64')]).then(
      async ([m, { default: b64 }]) => initEmscripten<DecModule>(m.default as never, await compileWasm(b64)),
    ));
  const encoder = () =>
    (enc ??= Promise.all([import('@jsquash/jpeg/codec/enc/mozjpeg_enc.js'), import('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm?b64'), import('@jsquash/jpeg/meta.js')]).then(
      async ([m, { default: b64 }, meta]): Promise<EncModule> => {
        const mod = await initEmscripten<EncModule>(m.default as never, await compileWasm(b64));
        const base = defaults(meta);
        return { encode: (d, w, h, o) => mod.encode(d, w, h, { ...base, ...o }) };
      },
    ));

  return {
    id: 'wasm-jpeg',
    format: 'jpeg',
    capabilities: {
      decode: true,
      encode: true,
      lossless: false,
      alpha: false,
      exactAlpha: false,
      decodeBitDepth: 8,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [8],
      metadata: { exif: true, icc: true, xmp: true },
    },
    async decode(bytes) {
      const m = await decoder();
      const img = m.decode(bytes, false);
      if (!img) throw new Error('mozjpeg could not decode this JPEG (CMYK/YCCK JPEGs are not supported by this decoder).');
      const pixels = fromImageData(img);
      return asDecoded(pixels, buildMetadata(bytes, 'jpeg', pixels));
    },
    async encode(img, opts: EncodeOptions) {
      if (img.metadata.hasAlpha) throw new Error('Refusing to encode an image with alpha to JPEG without flattening.');
      if (img.pixels.bitDepth !== 8) throw new Error('JPEG encoder takes 8-bit input.');
      const m = await encoder();
      const quality = Math.round(Math.min(1, Math.max(0, opts.quality ?? 0.9)) * 100);
      const out = m.encode(u8view(img.pixels), img.pixels.width, img.pixels.height, { quality });
      if (!out) throw new Error('mozjpeg encoding failed');
      let bytes: Uint8Array = new Uint8Array(out);
      if (opts.exif || opts.icc || opts.xmp) {
        bytes = injectMetadata(bytes, 'jpeg', { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
      }
      return bytes;
    },
  };
}
