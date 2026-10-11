/**
 * Codec registry: per format, an ordered list of lazily loaded codecs. The
 * first one whose runtime probe demonstrates the needed role wins; the canvas
 * codec is always last as the fallback. Nothing here special-cases a codec by
 * name: resolution reads the probed capability fields only.
 */
import { createCanvasCodec } from './canvas';
import { probeCodec } from './probe';
import { createTiffCodec } from './tiff';
import type { CapabilityTable, Codec, DecodedImage, ImageFormat, ResolvedCodec } from './types';

type Loader = () => Promise<Codec>;
type Role = 'decode' | 'encode';

/**
 * Per format, the codecs in order of preference. For JPEG XL, jxl-oxide (an independent
 * decoder written from the specification) comes first: it reads JXL sources and verifies
 * JXL output, while libjxl (whose 2022 decoder is off by one on some pixels) only encodes.
 */
const LOADERS: Record<ImageFormat, Loader[]> = {
  png: [() => import('./wasm/png').then((m) => m.createAirgapPngCodec()), () => import('./wasm/png').then((m) => m.createWasmPngCodec()), async () => createCanvasCodec('png')],
  jpeg: [() => import('./wasm/jpeg').then((m) => m.createWasmJpegCodec()), async () => createCanvasCodec('jpeg')],
  webp: [() => import('./wasm/webp').then((m) => m.createWasmWebpCodec()), async () => createCanvasCodec('webp')],
  avif: [() => import('./wasm/avif').then((m) => m.createWasmAvifCodec()), async () => createCanvasCodec('avif')],
  jxl: [() => import('./wasm/jxl-oxide').then((m) => m.createJxlOxideCodec()), () => import('./wasm/jxl').then((m) => m.createWasmJxlCodec())],
  tiff: [async () => createTiffCodec()],
};

/**
 * Per format, the loader index of a decoder that shares no code with the format's encoders.
 * It cross-checks those encoders' output in their probes. Formats not listed use the
 * browser's own decoder (the canvas codec) where it can read the format.
 */
const INDEPENDENT_DECODER: Partial<Record<ImageFormat, number>> = { jxl: 0 };

interface Loaded {
  codec: Codec;
  resolved: ResolvedCodec;
}

export class CodecRegistry {
  private loaded = new Map<ImageFormat, (Loaded | null)[]>();
  private loading = new Map<string, Promise<Loaded | null>>();
  /** Codec objects, loaded but not probed: probes of one codec may use another as a reference. */
  private codecs = new Map<string, Promise<Codec>>();
  private chosen: CapabilityTable = {};

  private codec(format: ImageFormat, i: number): Promise<Codec> {
    const key = `${format}:${i}`;
    let p = this.codecs.get(key);
    if (!p) {
      const loader = LOADERS[format][i];
      p = loader ? loader() : Promise.reject(new Error(`no codec ${key}`));
      this.codecs.set(key, p);
    }
    return p;
  }

  /** The decoder used to cross-check codec i's encoder: never codec i itself. */
  private async independentFor(format: ImageFormat, i: number, codec: Codec): Promise<Codec | undefined> {
    const j = INDEPENDENT_DECODER[format];
    if (j !== undefined && j !== i) {
      try {
        return await this.codec(format, j);
      } catch {
        /* fall through to the browser's decoder */
      }
    }
    const canvas = createCanvasCodec(format);
    return canvas.capabilities.decode && canvas.id !== codec.id ? canvas : undefined;
  }

  /** For a decode-only codec: the first other codec of the format that claims lossless encoding. */
  private async referenceEncoderFor(format: ImageFormat, i: number): Promise<Codec | undefined> {
    for (let j = 0; j < LOADERS[format].length; j++) {
      if (j === i) continue;
      try {
        const c = await this.codec(format, j);
        if (c.capabilities.encode && c.capabilities.lossless) return c;
      } catch {
        /* try the next one */
      }
    }
    return undefined;
  }

  /** Loads and probes the i-th codec for a format, once. null = failed to load. */
  private async loadOne(format: ImageFormat, i: number): Promise<Loaded | null> {
    const key = `${format}:${i}`;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        if (!LOADERS[format][i]) return null;
        try {
          const codec = await this.codec(format, i);
          const resolved = codec.capabilities.encode
            ? await probeCodec(codec, await this.independentFor(format, i, codec))
            : await probeCodec(codec, undefined, await this.referenceEncoderFor(format, i));
          return { codec, resolved };
        } catch (err) {
          return {
            codec: null as unknown as Codec,
            resolved: {
              codecId: `${format}#${i}`,
              capabilities: { decode: false, encode: false, lossless: false, alpha: false, exactAlpha: false, decodeBitDepth: 0, decodeExact: false, decodeAppliesIcc: false, encodeBitDepths: [], metadata: { exif: false, icc: false, xmp: false } },
              probe: { codecId: `${format}#${i}`, ok: false, detail: `failed to load: ${(err as Error).message}`, checks: {} },
            },
          };
        }
      })();
      this.loading.set(key, p);
    }
    const r = await p;
    const arr = this.loaded.get(format) ?? [];
    arr[i] = r;
    this.loaded.set(format, arr);
    return r;
  }

  /** First codec (in preference order) whose PROBED capabilities include the role. */
  async resolve(format: ImageFormat, role: Role): Promise<Loaded> {
    const already = this.chosen[format]?.[role];
    if (already) {
      const arr = this.loaded.get(format) ?? [];
      const hit = arr.find((l) => l && l.resolved.codecId === already.codecId);
      if (hit) return hit;
    }
    const failures: string[] = [];
    for (let i = 0; i < LOADERS[format].length; i++) {
      const l = await this.loadOne(format, i);
      if (l && l.codec && l.resolved.capabilities[role]) {
        this.chosen[format] = { ...this.chosen[format], [role]: l.resolved };
        return l;
      }
      if (l) failures.push(`${l.resolved.codecId}: ${l.resolved.probe.detail}`);
    }
    throw new Error(`No codec can ${role} ${format} in this browser. ${failures.join(' | ')}`);
  }

  /** Decode with the preferred codec, falling back to the next one on a per-file failure. */
  async decode(format: ImageFormat, bytes: Uint8Array): Promise<{ image: DecodedImage; used: Loaded }> {
    const errors: string[] = [];
    for (let i = 0; i < LOADERS[format].length; i++) {
      const l = await this.loadOne(format, i);
      if (!l || !l.codec || !l.resolved.capabilities.decode) continue;
      try {
        const image = await l.codec.decode(bytes);
        return { image, used: l };
      } catch (err) {
        errors.push(`${l.resolved.codecId}: ${(err as Error).message}`);
      }
    }
    throw new Error(`Could not decode this ${format.toUpperCase()} file. ${errors.join(' | ')}`);
  }

  table(): CapabilityTable {
    return JSON.parse(JSON.stringify(this.chosen)) as CapabilityTable;
  }
}
