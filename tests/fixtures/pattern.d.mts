export const RGB8: { width: number; height: number };
export const RGBA_PARTIAL: { width: number; height: number };
export const RGB16: { width: number; height: number };
export const EXIF_GPS: { width: number; height: number };
export const ONE_PIXEL: { width: number; height: number; rgb: [number, number, number] };
export function lcg(seed: number): () => number;
export function rgb8Pixel(x: number, y: number, noise: () => number): [number, number, number];
export function rgbaPixel(x: number, y: number, noise: () => number): [number, number, number, number];
export function rgb16Pixel(x: number, y: number): [number, number, number];
