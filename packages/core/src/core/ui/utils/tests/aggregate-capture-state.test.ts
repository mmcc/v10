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
    micActive: false,
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

  it('counts the mic like a video pipeline under explicit intent', () => {
    for (const status of PRECEDENCE) {
      expect(aggregateCaptureState(source({ micState: status, micActive: true }))).toBe(status);
    }
  });

  it('mic-only acquiring outranks a denied video pipeline', () => {
    expect(aggregateCaptureState(source({ cameraState: 'denied', micState: 'acquiring', micActive: true }))).toBe(
      'acquiring'
    );
  });

  // The load-bearing rule: an implied mic (acquired as a side effect of
  // video intent) must never enable capture-gated controls on its own —
  // e.g. a mic that outlives a dismissed screen picker by a beat.
  it("ignores an implied mic's in-flight states", () => {
    expect(aggregateCaptureState(source({ micState: 'active' }))).toBe('idle');
    expect(aggregateCaptureState(source({ micState: 'acquiring' }))).toBe('idle');
    expect(aggregateCaptureState(source({ cameraState: 'ended', micState: 'active' }))).toBe('ended');
  });

  // The acquire pipeline consumes micActive on denied/ended while parking
  // micState there so UIs can say why capture stopped — a mic-only denial
  // must still surface after consumption, and terminal states can never
  // enable a publish control anyway.
  it('counts the mic terminal residue after the intent is consumed', () => {
    expect(aggregateCaptureState(source({ micState: 'denied' }))).toBe('denied');
    expect(aggregateCaptureState(source({ micState: 'ended' }))).toBe('ended');
    expect(aggregateCaptureState(source({ cameraState: 'acquiring', micState: 'denied' }))).toBe('acquiring');
  });
});
