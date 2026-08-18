import type { MediaCaptureState } from '@videojs/media';
import { describe, expect, it } from 'vitest';

import type { AggregatableCaptureSource } from '../aggregate-capture-state';
import { aggregateCaptureState } from '../aggregate-capture-state';

// Highest to lowest rank, mirroring the precedence documented on
// aggregateCaptureState: active > acquiring > denied > ended > idle.
const PRECEDENCE: readonly MediaCaptureState[] = ['active', 'acquiring', 'denied', 'ended', 'idle'];

function source(overrides: Partial<AggregatableCaptureSource> = {}): AggregatableCaptureSource {
  return {
    cameraState: 'idle',
    screenShareState: 'idle',
    micState: 'idle',
    micExplicit: false,
    ...overrides,
  };
}

describe('aggregateCaptureState', () => {
  it('picks the higher-ranked video state regardless of which side holds it', () => {
    for (const [i, higher] of PRECEDENCE.entries()) {
      for (const lower of PRECEDENCE.slice(i + 1)) {
        expect(aggregateCaptureState(source({ cameraState: higher, screenShareState: lower }))).toBe(higher);
        expect(aggregateCaptureState(source({ cameraState: lower, screenShareState: higher }))).toBe(higher);
      }
    }
  });

  it('returns the shared state when both video sides match', () => {
    for (const status of PRECEDENCE) {
      expect(aggregateCaptureState(source({ cameraState: status, screenShareState: status }))).toBe(status);
    }
  });

  // Called out explicitly in review: acquiring must win even though it
  // is the camera's less "bad" state than the screen's denial.
  it('camera denied + screen acquiring resolves to acquiring', () => {
    expect(aggregateCaptureState(source({ cameraState: 'denied', screenShareState: 'acquiring' }))).toBe('acquiring');
    expect(aggregateCaptureState(source({ cameraState: 'acquiring', screenShareState: 'denied' }))).toBe('acquiring');
  });

  it('denied outranks ended', () => {
    expect(aggregateCaptureState(source({ cameraState: 'denied', screenShareState: 'ended' }))).toBe('denied');
    expect(aggregateCaptureState(source({ cameraState: 'ended', screenShareState: 'denied' }))).toBe('denied');
  });

  it('counts the mic like a video pipeline when its lifecycle is explicitly claimed', () => {
    for (const status of PRECEDENCE) {
      expect(aggregateCaptureState(source({ micState: status, micExplicit: true }))).toBe(status);
    }
  });

  it('mic-only acquiring outranks a denied video pipeline', () => {
    expect(aggregateCaptureState(source({ cameraState: 'denied', micState: 'acquiring', micExplicit: true }))).toBe(
      'acquiring'
    );
  });

  // The parked terminal residue of a mic-only attempt — micActive already
  // consumed, micExplicit latched by the store feature — must keep
  // surfacing so a denied voice-only page can explain itself.
  it('counts the explicit mic terminal residue after the intent is consumed', () => {
    expect(aggregateCaptureState(source({ micState: 'denied', micExplicit: true }))).toBe('denied');
    expect(aggregateCaptureState(source({ micState: 'ended', micExplicit: true }))).toBe('ended');
  });

  // The load-bearing rule: an implied mic (acquired as a side effect of
  // video intent) must never surface capture feedback on its own — neither
  // an 'active' that would enable publish controls (a mic outliving a
  // dismissed screen picker by a beat) nor a 'denied' that would blame
  // permissions a camera-only page never asked for.
  it('ignores an implied mic entirely', () => {
    for (const status of PRECEDENCE) {
      expect(aggregateCaptureState(source({ micState: status }))).toBe('idle');
    }
    expect(aggregateCaptureState(source({ cameraState: 'ended', micState: 'active' }))).toBe('ended');
    expect(aggregateCaptureState(source({ cameraState: 'acquiring', micState: 'denied' }))).toBe('acquiring');
  });
});
