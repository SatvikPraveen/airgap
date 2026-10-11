/**
 * JPEG XL encoding (and fallback decoding) via Airgap's own libjxl 0.12.0 build (libjxl.ts):
 * lossless and lossy, 8 and 16-bit, exact alpha, ICC in the codestream, EXIF and XMP as boxes.
 * jxl-oxide stays the first decoder and the verifier, so libjxl's output is always checked by
 * code that shares nothing with it.
 */
import { iccFacts } from '../../metadata/icc';
import { alphaStats } from '../../pixels';
import type { Codec, EncodeOptions } from '../types';
import { decodeJxl, encodeJxl, loadLibjxl } from './libjxl';
import { asDecoded, buildMetadata } from './shared';

export async function createWasmJxlCodec(): Promise<Codec> {
  const m = await loadLibjxl();
  return {
    id: 'libjxl',
    format: 'jxl',
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
      const d = decodeJxl(m, bytes);
      // Facts from the container; libjxl applies the orientation itself.
      const metadata = buildMetadata(bytes, 'jxl', d.pixels, { orientationApplied: true });
      if (metadata.hasIcc && d.icc) Object.assign(metadata, { icc: d.icc }, iccFacts(d.icc));
      if (metadata.hasAlpha) Object.assign(metadata, alphaStats(d.pixels));
      return asDecoded(d.pixels, metadata);
    },
    async encode(img, opts: EncodeOptions) {
      return encodeJxl(m, img.pixels, img.metadata.hasAlpha, {
        lossless: !!opts.lossless,
        ...(opts.quality !== undefined && { quality: opts.quality }),
        ...(opts.icc && { icc: opts.icc }),
        ...(opts.exif && { exif: opts.exif }),
        ...(opts.xmp && { xmp: opts.xmp }),
      });
    },
  };
}
