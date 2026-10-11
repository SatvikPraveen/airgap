import type { CapabilityTable, ImageFormat } from '../codecs/types';
import type { Verification } from '../convert';
import type { SourceInfo } from '../protocol';
import type { IccMode, MetadataMode } from '../capabilities';

export type TargetKey =
  | 'png'
  | 'webp-lossless'
  | 'webp-lossy'
  | 'avif-lossless'
  | 'avif-lossy'
  | 'jxl-lossless'
  | 'jxl-lossy'
  | 'tiff'
  | 'jpeg';

export interface TargetDef {
  format: ImageFormat;
  lossless: boolean;
  label: string;
}

export const TARGETS: Record<TargetKey, TargetDef> = {
  png: { format: 'png', lossless: true, label: 'PNG (lossless)' },
  'webp-lossless': { format: 'webp', lossless: true, label: 'WebP (lossless)' },
  'webp-lossy': { format: 'webp', lossless: false, label: 'WebP (lossy)' },
  'avif-lossless': { format: 'avif', lossless: true, label: 'AVIF (lossless)' },
  'avif-lossy': { format: 'avif', lossless: false, label: 'AVIF (lossy)' },
  'jxl-lossless': { format: 'jxl', lossless: true, label: 'JPEG XL (lossless)' },
  'jxl-lossy': { format: 'jxl', lossless: false, label: 'JPEG XL (lossy)' },
  tiff: { format: 'tiff', lossless: true, label: 'TIFF (lossless, uncompressed)' },
  jpeg: { format: 'jpeg', lossless: false, label: 'JPEG (lossy)' },
};

export const TARGET_ORDER: TargetKey[] = ['png', 'webp-lossless', 'webp-lossy', 'avif-lossless', 'avif-lossy', 'jxl-lossless', 'jxl-lossy', 'tiff', 'jpeg'];

export interface LoadedSource {
  id: number;
  file: File;
  info: SourceInfo;
  previewUrl: string;
}

export interface ConversionOutput {
  url: string;
  size: number;
  mime: string;
  format: ImageFormat;
  bitDepth: number;
  encoderId: string;
  colorLayout?: string;
  filename: string;
  verification: Verification;
  target: TargetKey;
  pixelCount: number;
  width: number;
  height: number;
  /** Change magnitude per pixel; only when not identical. */
  diffMask?: Uint8Array;
  /** Blob URL of the source preview, for the compare view. */
  sourceUrl: string;
}

/** A quality preview: the real pipeline at the current settings, shown without producing a result. */
export interface PreviewOutput {
  /** Identity of the plan this preview was computed for (source id + every setting). */
  key: string;
  quality: number;
  url: string;
  size: number;
  verification: Verification;
  diffMask?: Uint8Array;
  width: number;
  height: number;
  sourceUrl: string;
}

export type BatchStatus = 'waiting' | 'reading' | 'ready' | 'error' | 'converting' | 'done' | 'cancelled';

export interface BatchOutput {
  bytes: Uint8Array;
  url: string;
  filename: string;
  size: number;
  format: ImageFormat;
  bitDepth: number;
  encoderId: string;
  verification: Verification;
}

export interface BatchItem {
  file: File;
  status: BatchStatus;
  /** Facts read when the file was decoded once up front; the pixels are not kept. */
  info?: SourceInfo;
  error?: string;
  output?: BatchOutput;
}

export interface BatchState {
  items: BatchItem[];
  /** The conversion loop is running (cancel stops it after the current file). */
  running: boolean;
  zip: { url: string; filename: string; size: number; entries: number } | null;
  /** Why no archive could be built (per-file downloads still work). */
  zipError: string | null;
}

export interface AppState {
  ready: boolean;
  caps: CapabilityTable;
  /** `${format}:${role}` currently being loaded/probed. */
  ensuring: Set<string>;
  ensureErrors: Partial<Record<ImageFormat, string>>;
  source: LoadedSource | null;
  /** Two or more files: settings apply to all, outputs go into one archive. Exclusive with `source`. */
  batch: BatchState | null;
  target: TargetKey;
  losslessOnly: boolean;
  metadataMode: MetadataMode;
  iccMode: IccMode;
  /** 1..100 */
  quality: number;
  /** #rrggbb */
  background: string;
  busy: 'idle' | 'loading' | 'converting';
  error: string | null;
  /** Non-blocking advice about the loaded source (e.g. a large-image warning). */
  notice: string | null;
  /** The metadata inspector's disclosure state survives re-renders. */
  inspectorOpen: boolean;
  result: ConversionOutput | null;
  /** Newest quality preview, possibly for an older plan than the current one (then shown as stale). */
  preview: PreviewOutput | null;
  previewBusy: boolean;
  previewError: string | null;
  /** The heat map / compare view under the slider is open. */
  previewCompareOpen: boolean;
  /** Above the auto-preview size the user runs previews one at a time; this is the plan key they asked for. */
  previewArmedKey: string | null;
}

export function initialState(): AppState {
  return {
    ready: false,
    caps: {},
    ensuring: new Set(),
    ensureErrors: {},
    source: null,
    batch: null,
    target: 'png',
    losslessOnly: false,
    metadataMode: 'strip-all',
    iccMode: 'strip',
    quality: 90,
    background: '#ffffff',
    busy: 'idle',
    error: null,
    notice: null,
    inspectorOpen: false,
    result: null,
    preview: null,
    previewBusy: false,
    previewError: null,
    previewCompareOpen: false,
    previewArmedKey: null,
  };
}
