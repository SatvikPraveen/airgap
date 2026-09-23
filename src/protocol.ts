/** Messages between the UI thread and the conversion worker. */
import type { CapabilityTable, ImageFormat, ImageMetadata } from './codecs/types';
import type { ConversionPlan, Verification } from './convert';

export interface SourceInfo {
  format: ImageFormat;
  width: number;
  height: number;
  metadata: ImageMetadata;
}

export type ToWorker =
  | { type: 'init' }
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | { type: 'convert'; id: number; plan: ConversionPlan }
  | { type: 'unload'; id: number };

export type FromWorker =
  | { type: 'ready'; caps: CapabilityTable; webpLosslessProbe: WebpProbeResult }
  | { type: 'loaded'; id: number; info: SourceInfo }
  | {
      type: 'converted';
      id: number;
      bytes: ArrayBuffer;
      mime: string;
      format: ImageFormat;
      verification: Verification;
    }
  | { type: 'error'; id: number | null; message: string; name: string };

export interface WebpProbeResult {
  /** The encoder reproduced a noisy RGBA test image exactly at quality 1. */
  lossless: boolean;
  /** The browser can encode WebP at all via canvas. */
  supported: boolean;
  detail: string;
}
