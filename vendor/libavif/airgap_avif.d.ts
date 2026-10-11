export interface AirgapAvifModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _aavif_free(p: number): void;
  _aavif_version(): number;
  UTF8ToString(p: number): string;
  _aavif_decode_frames(data: number, size: number, w: number, h: number, depth: number, outBits: number, alpha: number, frames: number, loops: number, timescale: number, durations: number, outSize: number): number;
  _aavif_encode_frames(px: number, w: number, h: number, depth: number, alpha: number, frames: number, timescale: number, durations: number, loops: number, lossless: number, quality: number, speed: number, outSize: number): number;
}
declare const createAirgapAvif: (opts: Record<string, unknown>) => Promise<AirgapAvifModule>;
export default createAirgapAvif;
