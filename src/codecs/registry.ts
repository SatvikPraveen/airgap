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

const LOADERS: Record<ImageFormat, Loader[]> = {
  png: [() => import('./wasm/png').then((m) => m.createWasmPngCodec()), async () => createCanvasCodec('png')],
  jpeg: [() => import('./wasm/jpeg').then((m) => m.createWasmJpegCodec()), async () => createCanvasCodec('jpeg')],
  webp: [() => import('./wasm/webp').then((m) => m.createWasmWebpCodec()), async () => createCanvasCodec('webp')],
  avif: [() => import('./wasm/avif').then((m) => m.createWasmAvifCodec()), async () => createCanvasCodec('avif')],
  jxl: [() => import('./wasm/jxl').then((m) => m.createWasmJxlCodec())],
  tiff: [async () => createTiffCodec()],
};

interface Loaded {
  codec: Codec;
  resolved: ResolvedCodec;
}

export class CodecRegistry {
  private loaded = new Map<ImageFormat, (Loaded | null)[]>();
  private loading = new Map<string, Promise<Loaded | null>>();
  private chosen: CapabilityTable = {};

  /** Loads and probes the i-th codec for a format, once. null = failed to load. */
  private async loadOne(format: ImageFormat, i: number): Promise<Loaded | null> {
    const key = `${format}:${i}`;
    let p = this.loading.get(key);
    if (!p) {
      p = (async () => {
        const loader = LOADERS[format][i];
        if (!loader) return null;
        try {
          const codec = await loader();
          // Cross-check opaque pixels with the browser's own decoder when it is a different codec.
          const canvas = createCanvasCodec(format);
          const independent = canvas.capabilities.decode && canvas.id !== codec.id ? canvas : undefined;
          const resolved = await probeCodec(codec, independent);
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
