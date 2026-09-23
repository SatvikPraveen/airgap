import type { CapabilityTable, ImageFormat } from '../codecs/types';
import type { Verification } from '../convert';
import type { SourceInfo, WebpProbeResult } from '../protocol';
import type { TargetSpec } from '../capabilities';

export type TargetKey = 'png' | 'jpeg' | 'webp-lossless' | 'webp-lossy';

export const TARGETS: Record<TargetKey, TargetSpec & { label: string }> = {
  png: { format: 'png', lossless: true, label: 'PNG (lossless)' },
  'webp-lossless': { format: 'webp', lossless: true, label: 'WebP (lossless)' },
  'webp-lossy': { format: 'webp', lossless: false, label: 'WebP (lossy)' },
  jpeg: { format: 'jpeg', lossless: false, label: 'JPEG (lossy)' },
};

export const TARGET_ORDER: TargetKey[] = ['png', 'webp-lossless', 'webp-lossy', 'jpeg'];

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
  filename: string;
  verification: Verification;
  target: TargetKey;
  pixelCount: number;
}

export interface AppState {
  ready: boolean;
  caps: CapabilityTable | null;
  probe: WebpProbeResult | null;
  source: LoadedSource | null;
  target: TargetKey;
  losslessOnly: boolean;
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
    caps: null,
    probe: null,
    source: null,
    target: 'png',
    losslessOnly: false,
    quality: 90,
    background: '#ffffff',
    busy: 'idle',
    error: null,
    result: null,
  };
}
