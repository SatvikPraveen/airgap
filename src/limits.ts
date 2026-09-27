/**
 * Memory guard. Decoded pixels are RGBA at up to 16 bits, and the pipeline
 * holds up to three copies (source, output, re-decoded verification), so a
 * 16-bit image costs about 24 bytes per pixel at peak. Beyond the hard limit
 * a browser tab dies with an out-of-memory error instead of a message;
 * Airgap refuses first and says why. Pure; used on the UI thread before any
 * bytes are handed to the worker.
 */

/** Above this the file is refused. */
export const HARD_LIMIT_MEGAPIXELS = 80;
/** Above this the source panel warns that conversion may be slow and memory-hungry. */
export const SOFT_LIMIT_MEGAPIXELS = 24;

export function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000;
}

/** Rough peak working-set estimate in bytes for the pipeline on this image. */
export function estimatedPeakBytes(width: number, height: number, bitDepth: number): number {
  const bytesPerSample = bitDepth > 8 ? 2 : 1;
  return width * height * 4 * bytesPerSample * 3;
}

export function formatMegapixels(mp: number): string {
  return `${mp >= 10 ? mp.toFixed(0) : mp.toFixed(1)} MP`;
}

export function sizeRefusal(width: number, height: number): string | null {
  const mp = megapixels(width, height);
  if (mp <= HARD_LIMIT_MEGAPIXELS) return null;
  return `This image is ${width} × ${height} px (${formatMegapixels(mp)}). Airgap holds decoded pixels in memory three times over to verify its output, and above ${HARD_LIMIT_MEGAPIXELS} MP a browser tab runs out of memory rather than finishing. Downscale it first.`;
}

export function sizeWarning(width: number, height: number, bitDepth: number): string | null {
  const mp = megapixels(width, height);
  if (mp > HARD_LIMIT_MEGAPIXELS || mp <= SOFT_LIMIT_MEGAPIXELS) return null;
  const gb = estimatedPeakBytes(width, height, bitDepth) / 1024 ** 3;
  return `Large image (${formatMegapixels(mp)}): conversion and verification may take a while and use about ${gb.toFixed(1)} GB of memory. Cancel is available at any time.`;
}
