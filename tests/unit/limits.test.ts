import { describe, expect, it } from 'vitest';
import { estimatedPeakBytes, HARD_LIMIT_MEGAPIXELS, PREVIEW_AUTO_MEGAPIXELS, previewOnDemand, sizeRefusal, sizeWarning, SOFT_LIMIT_MEGAPIXELS } from '../../src/limits';

describe('memory guard', () => {
  it('small and medium images are neither refused nor warned about', () => {
    expect(sizeRefusal(4000, 3000)).toBeNull();
    expect(sizeWarning(4000, 3000, 8)).toBeNull();
  });
  it('warns above the soft limit, refuses above the hard limit, with the dimensions in the message', () => {
    const w = 7000;
    const h = Math.ceil((SOFT_LIMIT_MEGAPIXELS * 1_000_000) / w) + 1;
    expect(sizeRefusal(w, h)).toBeNull();
    expect(sizeWarning(w, h, 16)).toMatch(/Large image/);
    const hh = Math.ceil((HARD_LIMIT_MEGAPIXELS * 1_000_000) / w) + 1;
    expect(sizeRefusal(w, hh)).toContain(`${w} × ${hh} px`);
    expect(sizeWarning(w, hh, 8)).toBeNull();
  });
  it('peak estimate: RGBA x 3 copies, doubled for 16-bit', () => {
    expect(estimatedPeakBytes(100, 100, 8)).toBe(100 * 100 * 4 * 3);
    expect(estimatedPeakBytes(100, 100, 16)).toBe(100 * 100 * 8 * 3);
  });
  it('the quality preview runs automatically up to the auto limit and on demand above it', () => {
    expect(previewOnDemand(2000, 2000)).toBe(false);
    const side = Math.ceil(Math.sqrt(PREVIEW_AUTO_MEGAPIXELS * 1_000_000)) + 1;
    expect(previewOnDemand(side, side)).toBe(true);
    expect(PREVIEW_AUTO_MEGAPIXELS).toBeLessThan(SOFT_LIMIT_MEGAPIXELS);
  });
});
