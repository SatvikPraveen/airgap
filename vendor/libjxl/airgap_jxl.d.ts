export interface AirgapJxlModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  _malloc(n: number): number;
  _free(p: number): void;
  _ajxl_free(p: number): void;
  _ajxl_version(): number;
  _ajxl_encode(px: number, w: number, h: number, bits: number, alpha: number, lossless: number, distance: number, effort: number, icc: number, iccSize: number, exif: number, exifSize: number, xmp: number, xmpSize: number, outSize: number): number;
  _ajxl_decode(data: number, size: number, w: number, h: number, bits: number, alpha: number, origBits: number, iccOut: number, iccSize: number, outSize: number): number;
  _ajxl_jpeg_to_jxl(jpeg: number, size: number, effort: number, outSize: number): number;
  _ajxl_jxl_to_jpeg(jxl: number, size: number, outSize: number): number;
}
declare const createAirgapJxl: (opts: Record<string, unknown>) => Promise<AirgapJxlModule>;
export default createAirgapJxl;
