/** Capability table of the canvas codec. DOM-free so pure code and unit tests can import it. */
import type { CodecCapabilities, ImageFormat } from './types';

const CANVAS_BASE = {
  maxBitDepth: 8,
  keepsMetadata: false,
  premultipliedAlpha: true,
} as const;

export function canvasCapabilities(format: ImageFormat, webpLossless: boolean): CodecCapabilities {
  switch (format) {
    case 'png':
      return { ...CANVAS_BASE, lossless: true, alpha: true };
    case 'jpeg':
      return { ...CANVAS_BASE, lossless: false, alpha: false };
    case 'webp':
      return { ...CANVAS_BASE, lossless: webpLossless, alpha: true };
  }
}
