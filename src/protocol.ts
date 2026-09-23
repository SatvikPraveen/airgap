/** Messages between the UI thread and the conversion worker. */
import type { CapabilityTable, ImageFormat, ImageMetadata, ResolvedCodec } from './codecs/types';
import type { ConversionPlan, Verification } from './convert';
import type { ExifSummary } from './metadata/exif';

export interface SourceInfo {
  format: ImageFormat;
  width: number;
  height: number;
  /** Payload bytes are stripped; only facts travel to the UI. */
  metadata: Omit<ImageMetadata, 'exif' | 'icc' | 'xmp'>;
  exifSummary?: ExifSummary;
  /** Which decoder actually read this file (after per-file fallback). */
  decoder: ResolvedCodec;
}

export type ToWorker =
  | { type: 'init' }
  | { type: 'ensure'; format: ImageFormat; role: 'decode' | 'encode' }
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | { type: 'convert'; id: number; plan: ConversionPlan }
  | { type: 'unload'; id: number };

export type FromWorker =
  | { type: 'ready'; caps: CapabilityTable }
  | { type: 'caps'; caps: CapabilityTable; format: ImageFormat; role: 'decode' | 'encode'; error?: string }
  | { type: 'loaded'; id: number; info: SourceInfo; caps: CapabilityTable }
  | {
      type: 'converted';
      id: number;
      bytes: ArrayBuffer;
      mime: string;
      format: ImageFormat;
      bitDepth: number;
      encoderId: string;
      verification: Verification;
      caps: CapabilityTable;
    }
  | { type: 'error'; id: number | null; message: string; name: string };
