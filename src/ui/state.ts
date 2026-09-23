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
  filename: string;
  verification: Verification;
  target: TargetKey;
  pixelCount: number;
}

export interface AppState {
  ready: boolean;
  caps: CapabilityTable;
  /** `${format}:${role}` currently being loaded/probed. */
  ensuring: Set<string>;
  ensureErrors: Partial<Record<ImageFormat, string>>;
  source: LoadedSource | null;
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
  result: ConversionOutput | null;
}

export function initialState(): AppState {
  return {
    ready: false,
    caps: {},
    ensuring: new Set(),
    ensureErrors: {},
    source: null,
    target: 'png',
    losslessOnly: false,
    metadataMode: 'strip-all',
    iccMode: 'strip',
    quality: 90,
    background: '#ffffff',
    busy: 'idle',
    error: null,
    result: null,
  };
}
