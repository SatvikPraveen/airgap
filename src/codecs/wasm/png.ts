/** PNG via @jsquash/png (Rust `png` crate, wasm-bindgen). Exact RGBA, 8 and 16-bit. */
import { injectMetadata } from '../../metadata/containers';
import type { Codec, EncodeOptions } from '../types';
import { asDecoded, buildMetadata, compileWasm, fromImageData, u8view } from './shared';

function swap16(src: Uint16Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = ((src[i]! & 255) << 8) | (src[i]! >> 8);
  return out;
}

export async function createWasmPngCodec(): Promise<Codec> {
  const [glue, { default: b64 }] = await Promise.all([
    import('@jsquash/png/codec/pkg/squoosh_png.js'),
    import('@jsquash/png/codec/pkg/squoosh_png_bg.wasm?b64'),
  ]);
  await glue.default(await compileWasm(b64));

  return {
    id: 'wasm-png',
    format: 'png',
    capabilities: {
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
    },
    async decode(bytes) {
      const { inspect } = await import('../../inspect');
      const header = inspect(bytes);
      const pixels =
        header.metadata.bitDepth === 16
          ? (() => {
              const r = glue.decode_rgba16(bytes);
              // decode_rgba16 hands back the PNG's big-endian sample bytes reinterpreted as
              // native (little-endian) u16; swap so values are real. Verified against the
              // independently written 16-bit fixtures in tests/browser.
              return { width: r.width, height: r.height, bitDepth: 16, data: swap16(r.data) };
            })()
          : fromImageData(glue.decode(bytes));
      return asDecoded(pixels, buildMetadata(bytes, 'png', pixels));
    },
    async encode(img, opts: EncodeOptions) {
      const px = img.pixels;
      if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`PNG encoder takes 8 or 16-bit input, got ${px.bitDepth}`);
      // The encoder reads native u16 samples and writes big-endian PNG itself: no swap here.
      let out = glue.encode(u8view(px), px.width, px.height, px.bitDepth);
      if (opts.exif || opts.icc || opts.xmp) {
        out = injectMetadata(out, 'png', { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
      }
      return out;
    },
  };
}
