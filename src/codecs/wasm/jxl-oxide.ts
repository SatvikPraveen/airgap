/**
 * JPEG XL decoding via jxl-oxide (Rust, written from the specification,
 * independent of libjxl). Decode only. It renders to PNG bytes (8 or 16-bit,
 * with the colour description carried as ICC), which Airgap's PNG decoder
 * then reads. Used first for JXL sources and as the verifier for JXL output,
 * so that a JXL produced by libjxl is checked by code that shares nothing with
 * the encoder.
 */
import type { Codec } from '../types';
import { asDecoded, buildMetadata, compileWasm } from './shared';

type Glue = typeof import('jxl-oxide-wasm');

let gluePromise: Promise<Glue> | undefined;
function loadGlue(): Promise<Glue> {
  return (gluePromise ??= Promise.all([import('jxl-oxide-wasm'), import('jxl-oxide-wasm/module.wasm?b64')]).then(async ([glue, { default: b64 }]) => {
    // initSync with a compiled module: no fetch, so the CSP's connect-src 'none' is never tested.
    glue.initSync({ module: await compileWasm(b64) });
    return glue;
  }));
}

export async function createJxlOxideCodec(): Promise<Codec> {
  const glue = await loadGlue();
  const { createWasmPngCodec } = await import('./png');
  const png = await createWasmPngCodec();
  return {
    id: 'jxl-oxide',
    format: 'jxl',
    capabilities: {
      decode: true,
      encode: false,
      lossless: false,
      alpha: true,
      exactAlpha: true,
      decodeBitDepth: 16,
      decodeExact: true,
      decodeAppliesIcc: false,
      encodeBitDepths: [],
      metadata: { exif: false, icc: false, xmp: false },
    },
    async decode(bytes) {
      const image = new glue.JxlImage();
      try {
        image.feedBytes(bytes);
        if (!image.tryInit()) throw new Error('jxl-oxide: incomplete JPEG XL header.');
        if (!image.loaded) throw new Error('jxl-oxide: the JPEG XL file is truncated.');
        // encodeToPng() consumes the render result (it frees it on the Rust side).
        const rendered = image.render().encodeToPng();
        const decoded = await png.decode(rendered);
        // Facts come from the JXL container, not the intermediate PNG; jxl-oxide applies orientation.
        const metadata = buildMetadata(bytes, 'jxl', decoded.pixels, { orientationApplied: true });
        if (metadata.hasIcc) {
          // jxl-oxide keeps the stored values and hands the profile back with the PNG. Without
          // it, carrying the values would silently drop the colour meaning: refuse, and the
          // registry falls back to libjxl, which converts to sRGB and says so.
          if (!decoded.metadata.icc) throw new Error('jxl-oxide did not return the embedded ICC profile.');
          metadata.icc = decoded.metadata.icc;
          if (decoded.metadata.iccKind) metadata.iccKind = decoded.metadata.iccKind;
          if (decoded.metadata.iccDescription) metadata.iccDescription = decoded.metadata.iccDescription;
          if (decoded.metadata.iccConvertible !== undefined) metadata.iccConvertible = decoded.metadata.iccConvertible;
        }
        return asDecoded(decoded.pixels, metadata);
      } finally {
        image.free();
      }
    },
    async encode() {
      throw new Error('jxl-oxide is a decoder only.');
    },
  };
}
