import type { MediaCaptureState } from '@videojs/media';
import { describe, expect, it } from 'vitest';

import { aggregateCaptureState } from '../aggregate-capture-state';

// Highest to lowest rank, mirroring the precedence documented on
// aggregateCaptureState: active > acquiring > denied > ended > idle.
const PRECEDENCE: readonly MediaCaptureState[] = ['active', 'acquiring', 'denied', 'ended', 'idle'];

describe('aggregateCaptureState', () => {
  it('picks the higher-ranked state regardless of which side holds it', () => {
    for (const [i, higher] of PRECEDENCE.entries()) {
      for (const lower of PRECEDENCE.slice(i + 1)) {
        expect(aggregateCaptureState(higher, lower)).toBe(higher);
        expect(aggregateCaptureState(lower, higher)).toBe(higher);
      }
    }
  });

  it('returns the shared state when both sides match', () => {
    for (const status of PRECEDENCE) {
      expect(aggregateCaptureState(status, status)).toBe(status);
    }
  });

  // Called out explicitly in review: acquiring must win even though it
  // is the camera's less "bad" state than the screen's denial.
  it('camera denied + screen acquiring resolves to acquiring', () => {
    expect(aggregateCaptureState('denied', 'acquiring')).toBe('acquiring');
    expect(aggregateCaptureState('acquiring', 'denied')).toBe('acquiring');
  });

  it('denied outranks ended', () => {
    expect(aggregateCaptureState('denied', 'ended')).toBe('denied');
    expect(aggregateCaptureState('ended', 'denied')).toBe('denied');
  });
});
