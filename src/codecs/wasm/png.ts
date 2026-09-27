/**
 * PNG codecs.
 *
 *  - `airgap-png` (preferred): decodes with @jsquash/png (the Rust `png`
 *    crate, exact RGBA, 8 and 16-bit) and encodes with Airgap's own writer
 *    (src/codecs/png-writer.ts), which stores the pixels in the smallest
 *    colour type that keeps them exactly: greyscale, palette, RGB or RGBA.
 *  - `wasm-png` (fallback): the same decoder with the Rust crate's encoder,
 *    which always writes RGBA. Used only if the writer's probe fails.
 */
import { injectMetadata } from '../../metadata/containers';
import { encodePng } from '../png-writer';
import type { Codec, CodecCapabilities, DecodedImage, EncodeOptions } from '../types';
import { asDecoded, buildMetadata, compileWasm, fromImageData, u8view } from './shared';

type Glue = typeof import('@jsquash/png/codec/pkg/squoosh_png.js');

function swap16(src: Uint16Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = ((src[i]! & 255) << 8) | (src[i]! >> 8);
  return out;
}

let gluePromise: Promise<Glue> | undefined;
function loadGlue(): Promise<Glue> {
  return (gluePromise ??= Promise.all([import('@jsquash/png/codec/pkg/squoosh_png.js'), import('@jsquash/png/codec/pkg/squoosh_png_bg.wasm?b64')]).then(
    async ([glue, { default: b64 }]) => {
      await glue.default(await compileWasm(b64));
      return glue;
    },
  ));
}

async function decodeWithRust(glue: Glue, bytes: Uint8Array): Promise<DecodedImage> {
  const { inspect } = await import('../../inspect');
  const header = inspect(bytes);
  const pixels =
    header.metadata.bitDepth === 16
      ? (() => {
          // decode_rgba16 returns real native u16 sample values. (An earlier version
          // byte-swapped here to match an encoder that wrote little-endian samples; the
          // browser's own decoder was the tie-breaker. See the 16-bit note in the README.)
          const r = glue.decode_rgba16(bytes);
          return { width: r.width, height: r.height, bitDepth: 16, data: r.data };
        })()
      : fromImageData(glue.decode(bytes));
  return asDecoded(pixels, buildMetadata(bytes, 'png', pixels));
}

function withMetadata(out: Uint8Array, opts: EncodeOptions): Uint8Array {
  if (opts.exif || opts.icc || opts.xmp) {
    return injectMetadata(out, 'png', { ...(opts.exif && { exif: opts.exif }), ...(opts.icc && { icc: opts.icc }), ...(opts.xmp && { xmp: opts.xmp }) });
  }
  return out;
}

const CAPABILITIES: CodecCapabilities = {
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
};

/** Rust decoder + Airgap's colour-type-minimising writer. */
export async function createAirgapPngCodec(): Promise<Codec> {
  const glue = await loadGlue();
  return {
    id: 'airgap-png',
    format: 'png',
    capabilities: { ...CAPABILITIES, encodeBitDepths: [...CAPABILITIES.encodeBitDepths], metadata: { ...CAPABILITIES.metadata } },
    decode: (bytes) => decodeWithRust(glue, bytes),
    async encode(img, opts: EncodeOptions) {
      const px = img.pixels;
      if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`PNG writer takes 8 or 16-bit input, got ${px.bitDepth}`);
      return withMetadata(encodePng(px, img.metadata.hasAlpha).bytes, opts);
    },
  };
}

/** Rust decoder + Rust encoder (always RGBA). */
export async function createWasmPngCodec(): Promise<Codec> {
  const glue = await loadGlue();
  return {
    id: 'wasm-png',
    format: 'png',
    capabilities: { ...CAPABILITIES, encodeBitDepths: [...CAPABILITIES.encodeBitDepths], metadata: { ...CAPABILITIES.metadata } },
    decode: (bytes) => decodeWithRust(glue, bytes),
    async encode(img, opts: EncodeOptions) {
      const px = img.pixels;
      if (px.bitDepth !== 8 && px.bitDepth !== 16) throw new Error(`PNG encoder takes 8 or 16-bit input, got ${px.bitDepth}`);
      // The Rust encoder copies the sample bytes it is given straight into the PNG, and
      // PNG samples are big-endian, so 16-bit input must be byte-swapped first.
      const data = px.bitDepth === 16 ? u8view({ ...px, data: swap16(px.data as Uint16Array) }) : u8view(px);
      return withMetadata(glue.encode(data, px.width, px.height, px.bitDepth), opts);
    },
  };
}
