/**
 * Runtime capability probe. A codec's DECLARED capabilities are only a
 * hypothesis; this demonstrates each claim in the running browser and
 * returns capabilities with every undemonstrated claim set to false.
 *
 * Pure with respect to the DOM: it only calls the codec's own API (plus an
 * optional independent decoder for cross-checking opaque pixels).
 */
import { inspect } from '../inspect';
import { summarizeExif } from '../metadata/exif';
import { comparePixels, convertBitDepth, maxValue, probeImage } from '../pixels';
import type { Codec, CodecCapabilities, DecodedImage, PixelData, ProbeReport, ResolvedCodec } from './types';

const PROBE_SIZE = 24;

/** Small but real payloads so metadata plumbing is exercised end to end. */
function probeMetadata(): { exif: Uint8Array; icc: Uint8Array; xmp: Uint8Array } {
  // TIFF: MM, 42, IFD0 @8 with Make="probe" (ASCII, 6 bytes @ offset 38) and Orientation=1.
  const exif = new Uint8Array([
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2,
    0x01, 0x0f, 0, 2, 0, 0, 0, 6, 0, 0, 0, 38,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 1, 0, 0,
    0, 0, 0, 0,
    0x70, 0x72, 0x6f, 0x62, 0x65, 0,
  ]);
  const icc = new Uint8Array(132 + 12 + 20);
  new DataView(icc.buffer).setUint32(0, icc.length);
  icc.set([0x6d, 0x6e, 0x74, 0x72], 12); // 'mntr'
  icc.set([0x52, 0x47, 0x42, 0x20], 16); // 'RGB '
  icc.set([0x58, 0x59, 0x5a, 0x20], 20); // 'XYZ '
  icc.set([0x61, 0x63, 0x73, 0x70], 36); // 'acsp'
  new DataView(icc.buffer).setUint32(128, 1);
  icc.set([0x64, 0x65, 0x73, 0x63], 132); // 'desc'
  new DataView(icc.buffer).setUint32(136, 144);
  new DataView(icc.buffer).setUint32(140, 20);
  icc.set([0x64, 0x65, 0x73, 0x63, 0, 0, 0, 0, 0, 0, 0, 6, 0x70, 0x72, 0x6f, 0x62, 0x65, 0], 144);
  const xmp = new TextEncoder().encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>');
  return { exif, icc, xmp };
}

function image(px: PixelData, hasAlpha: boolean): DecodedImage {
  return {
    pixels: px,
    metadata: {
      bitDepth: px.bitDepth,
      hasAlpha,
      hasTransparency: hasAlpha,
      hasSemiTransparency: hasAlpha,
      hasExif: false,
      hasGps: false,
      hasIcc: false,
      hasXmp: false,
      isAnimated: false,
    },
  };
}

function opaqueIdentical(a: PixelData, b: PixelData): boolean {
  const max = maxValue(a.bitDepth);
  if (a.width !== b.width || a.height !== b.height || a.bitDepth !== b.bitDepth) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i + 3] !== max) continue;
    for (let c = 0; c < 4; c++) if (a.data[i + c] !== b.data[i + c]) return false;
  }
  return true;
}

/** Every tag of the input EXIF is present in the output EXIF with the same orientation value. */
function exifCarried(input: Uint8Array, output: Uint8Array | undefined): boolean {
  if (!output) return false;
  try {
    const a = summarizeExif(input);
    const b = summarizeExif(output);
    const superset = (x: number[], y: number[]) => x.every((t) => y.includes(t));
    return superset(a.ifd0, b.ifd0) && superset(a.exif, b.exif) && superset(a.gps, b.gps) && a.orientation === b.orientation;
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function probeCodec(codec: Codec, independentDecoder?: Codec): Promise<ResolvedCodec> {
  const claimed = codec.capabilities;
  const caps: CodecCapabilities = {
    ...claimed,
    encodeBitDepths: [...claimed.encodeBitDepths],
    metadata: { ...claimed.metadata },
  };
  const checks: ProbeReport['checks'] = {};
  const notes: string[] = [];
  const check = (name: string, c: boolean, v: boolean) => {
    checks[name] = { claimed: c, verified: v };
  };

  if (!claimed.encode) {
    caps.decodeExact = false;
    return {
      codecId: codec.id,
      capabilities: caps,
      probe: { codecId: codec.id, ok: true, detail: 'decoder only; verified by the post-conversion comparison at use', checks },
    };
  }

  try {
    // 1. 8-bit round trip, with alpha if the codec claims it.
    const src8 = probeImage(PROBE_SIZE, 8, claimed.alpha);
    const lossless = claimed.lossless;
    const bytes = await codec.encode(image(src8, claimed.alpha), lossless ? { lossless: true } : { lossless: false, quality: 1 });
    const back = await codec.decode(bytes);
    const back8 = convertBitDepth(back.pixels, 8);
    if (lossless) {
      const opaqueOk = opaqueIdentical(src8, back8);
      caps.lossless = opaqueOk;
      caps.decodeExact = opaqueOk;
      check('lossless', true, opaqueOk);
      check('decodeExact', claimed.decodeExact, opaqueOk);
      if (!opaqueOk) {
        const cmp = comparePixels(src8, back8);
        notes.push(`round trip NOT identical on opaque pixels (${cmp.differingPixels} px differ, max diff ${cmp.maxChannelDiff})`);
      }
      if (claimed.alpha) {
        const cmp = comparePixels(src8, back8);
        caps.exactAlpha = claimed.exactAlpha && cmp.identical;
        check('exactAlpha', claimed.exactAlpha, cmp.identical);
        notes.push(
          cmp.identical
            ? 'RGBA round trip exact, including RGB under alpha 0 and semi-transparent pixels'
            : `RGBA round trip NOT exact (${cmp.differingPixels} px differ, max diff ${cmp.maxChannelDiff})`,
        );
      }
      // Cross-check opaque pixels with an independent decoder when one exists.
      if (independentDecoder && independentDecoder.id !== codec.id) {
        try {
          const other = await independentDecoder.decode(bytes);
          const ok = opaqueIdentical(src8, convertBitDepth(other.pixels, 8));
          check('independentDecode', true, ok);
          if (!ok) {
            caps.lossless = false;
            notes.push(`independent decoder (${independentDecoder.id}) disagrees on opaque pixels`);
          } else notes.push(`opaque pixels confirmed by ${independentDecoder.id}`);
        } catch (err) {
          notes.push(`no independent cross-check (${independentDecoder.id} cannot decode this output: ${(err as Error).message})`);
        }
      }
    } else {
      caps.exactAlpha = false;
      check('lossless', false, false);
      // A lossy encoder cannot prove its decoder; compare against the independent decoder instead.
      let decodeOk = false;
      if (independentDecoder && independentDecoder.id !== codec.id) {
        try {
          const other = await independentDecoder.decode(bytes);
          decodeOk = opaqueIdentical(back8, convertBitDepth(other.pixels, 8));
          check('decodeExact', claimed.decodeExact, decodeOk);
          notes.push(decodeOk ? `decoder agrees with ${independentDecoder.id}` : `decoder disagrees with ${independentDecoder.id}`);
        } catch (err) {
          notes.push(`decoder not cross-checked (${(err as Error).message})`);
        }
      }
      caps.decodeExact = decodeOk;
      notes.push('lossy-only encoder: pixel loss is expected and reported');
    }

    // 2. Deeper bit depths: each claimed depth must round-trip exactly.
    for (const depth of claimed.encodeBitDepths.filter((d) => d > 8)) {
      let ok = false;
      try {
        const src = probeImage(PROBE_SIZE, depth, claimed.alpha, 0x1234567);
        const out = await codec.encode(image(src, claimed.alpha), lossless ? { lossless: true } : { lossless: false, quality: 1 });
        const dec = await codec.decode(out);
        ok = dec.pixels.bitDepth === depth && (lossless ? comparePixels(src, dec.pixels).identical : true);
      } catch (err) {
        notes.push(`${depth}-bit probe threw: ${(err as Error).message}`);
      }
      check(`encode${depth}bit`, true, ok);
      if (!ok) caps.encodeBitDepths = caps.encodeBitDepths.filter((d) => d !== depth);
      else notes.push(`${depth}-bit round trip exact`);
    }

    // 3. Metadata: what goes in must come back out.
    const meta = probeMetadata();
    if (claimed.metadata.exif || claimed.metadata.icc || claimed.metadata.xmp) {
      const opts = {
        ...(lossless ? { lossless: true } : { lossless: false, quality: 1 }),
        ...(claimed.metadata.exif ? { exif: meta.exif } : {}),
        ...(claimed.metadata.icc ? { icc: meta.icc } : {}),
        ...(claimed.metadata.xmp ? { xmp: meta.xmp } : {}),
      };
      const withMeta = await codec.encode(image(src8, claimed.alpha), opts);
      const header = inspect(withMeta);
      const dec = await codec.decode(withMeta);
      if (claimed.metadata.exif) {
        const ok = header.metadata.hasExif && exifCarried(meta.exif, dec.metadata.exif);
        check('metadata.exif', true, ok);
        caps.metadata.exif = ok;
      }
      if (claimed.metadata.icc) {
        const ok = header.metadata.hasIcc && bytesEqual(dec.metadata.icc, meta.icc);
        check('metadata.icc', true, ok);
        caps.metadata.icc = ok;
      }
      if (claimed.metadata.xmp) {
        const ok = header.metadata.hasXmp && bytesEqual(dec.metadata.xmp, meta.xmp);
        check('metadata.xmp', true, ok);
        caps.metadata.xmp = ok;
      }
    }
  } catch (err) {
    return {
      codecId: codec.id,
      capabilities: { ...caps, encode: false, lossless: false, exactAlpha: false, decodeExact: false },
      probe: { codecId: codec.id, ok: false, detail: `probe failed: ${(err as Error).message}`, checks },
    };
  }

  return {
    codecId: codec.id,
    capabilities: caps,
    probe: { codecId: codec.id, ok: true, detail: notes.join('; '), checks },
  };
}
