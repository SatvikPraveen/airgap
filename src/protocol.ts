/** Messages between the UI thread and the conversion worker. */
import type { CapabilityTable, ImageFormat, ImageMetadata, ResolvedCodec } from './codecs/types';
import type { ConversionPlan, Optimization, Verification } from './convert';
import type { ExifSummary } from './metadata/exif';
import type { ExifTagRow } from './metadata/exif-list';

export interface SourceInfo {
  format: ImageFormat;
  width: number;
  height: number;
  /** Payload bytes are stripped; only facts travel to the UI. */
  metadata: Omit<ImageMetadata, 'exif' | 'icc' | 'xmp'>;
  exifSummary?: ExifSummary;
  /** Every EXIF tag, for the inspector. Absent when there is no EXIF or it cannot be parsed. */
  exifTags?: ExifTagRow[];
  /** XMP packet as text, truncated for display. */
  xmpText?: string;
  xmpBytes?: number;
  xmpTruncated?: boolean;
  /** Which decoder actually read this file (after per-file fallback). */
  decoder: ResolvedCodec;
}

export type ToWorker =
  | { type: 'init' }
  | { type: 'ensure'; format: ImageFormat; role: 'decode' | 'encode' }
  | { type: 'load'; id: number; bytes: ArrayBuffer }
  | { type: 'convert'; id: number; plan: ConversionPlan }
  /**
   * Same pipeline as 'convert', run for the quality preview. `requestId` increases
   * monotonically per page; the worker skips a preview it has already seen a newer
   * request for (wasm cannot be interrupted, but a queued request can be dropped).
   */
  | { type: 'preview'; id: number; requestId: number; plan: ConversionPlan }
  | { type: 'unload'; id: number };

/** What a conversion produced, as sent to the UI. Bytes and mask are transferred. */
export interface ConvertedPayload {
  bytes: ArrayBuffer;
  mime: string;
  format: ImageFormat;
  bitDepth: number;
  encoderId: string;
  colorLayout?: string;
  /** Output geometry: differs from the source after a crop, rotation or resize. */
  width: number;
  height: number;
  optimization?: Optimization;
  verification: Verification;
  /** width*height bytes; present only when the output is not identical. Transferred. */
  diffMask?: ArrayBuffer;
}

export type FromWorker =
  | { type: 'ready'; caps: CapabilityTable }
  | { type: 'caps'; caps: CapabilityTable; format: ImageFormat; role: 'decode' | 'encode'; error?: string }
  | { type: 'loaded'; id: number; info: SourceInfo; caps: CapabilityTable }
  | ({ type: 'converted'; id: number; caps: CapabilityTable } & ConvertedPayload)
  | ({ type: 'previewed'; id: number; requestId: number; stale: false; caps: CapabilityTable } & ConvertedPayload)
  /** A newer preview request for the same image arrived before this one ran; nothing was encoded. */
  | { type: 'previewed'; id: number; requestId: number; stale: true; caps: CapabilityTable }
  | { type: 'error'; id: number | null; requestId?: number; message: string; name: string };
