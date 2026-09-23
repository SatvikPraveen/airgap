declare module 'utif' {
  export interface UtifIfd {
    width: number;
    height: number;
    data: Uint8Array;
    isLE: boolean;
    [tag: `t${number}`]: number[] | string[] | Uint8Array | undefined;
  }
  export function decode(buffer: ArrayBuffer | Uint8Array): UtifIfd[];
  export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: UtifIfd, ifds?: UtifIfd[]): void;
  export function toRGBA8(ifd: UtifIfd): Uint8Array;
  export function encodeImage(rgba: Uint8Array, width: number, height: number, metadata?: Record<string, unknown>): ArrayBuffer;
  const UTIF: {
    decode: typeof decode;
    decodeImage: typeof decodeImage;
    toRGBA8: typeof toRGBA8;
    encodeImage: typeof encodeImage;
  };
  export default UTIF;
}
