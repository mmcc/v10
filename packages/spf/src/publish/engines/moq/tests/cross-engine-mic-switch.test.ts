import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';
import { createSubscriber, makeSyntheticStream } from './helpers/cross-engine-harness';

/**
 * Cross-engine regression for the mic-switch A/V divergence: switching `audioInputDeviceId` mid-broadcast rebuilds the
 * audio encoder actor, and a rebuilt actor used to open a FRESH wallclock anchor — discarding whatever skew the old
 * anchor had accumulated, so the audio track's published timeline stepped (backward whenever the discarded skew
 * exceeded the real acquisition gap) while the video track's timeline sailed on. The player degrades gracefully per
 * track, but once the two tracks' timelines diverge, exact A/V correspondence is unrecoverable downstream — only the
 * publisher can keep the domains coherent.
 *
 * The wallclock step injected between the epochs is the hostile form of that skew (an NTP step landing mid-broadcast —
 * 30 s backward, well past the player's 1 s discontinuity threshold): the switched track must continue its published
 * domain — forward by the real acquisition gap, never onto the stepped wallclock — and playout must stay healthy on
 * both tracks, with presented video still tracking the audio master clock.
 */

const disposals: (() => void)[] = [];

const CAMERA_SIZE = { width: 320, height: 240 } as const;

/**
 * Stub capture: every mic acquisition — the initial one and each device-switch re-acquisition — gets a FRESH audio-only
 * stream on its own capture clock (a new `AudioContext`), the way a real device switch lands.
 */
function installCaptureStubs(): void {
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints?: MediaStreamConstraints) => {
    if (constraints?.audio) return makeSyntheticStream(CAMERA_SIZE, true, disposals); // audio-only ask: the mic pipeline

    return makeSyntheticStream(CAMERA_SIZE, false, disposals); // video-only ask: the camera pipeline
  });
}

describe('publish engine ↔ playback engine (mic-switch timeline continuity)', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('keeps the audio timeline continuous across a mic switch with a wallclock step between epochs', async () => {
    installCaptureStubs();
    const hub = createRelayHub();

    disposals.push(() => hub.destroy());

    const publisher = createMoqPublishEngine({
      groupDurationSec: 1,
      connectTransport: hub.connectPublisher,
    });

    disposals.push(() => void publisher.destroy());

    publisher.state.endpoint.set({ url: 'https://relay.test/moq', namespace: ['live'] });
    publisher.state.cameraActive.set(true);
    publisher.state.publishActivated.set(true);

    await vi.waitFor(() => expect(publisher.state.sessionStatus.get()).toBe('live'), { timeout: 10_000 });

    // Announce-and-serve ingest is pull-through: prime standing upstream
    // demand so both tracks flow before the viewer joins.
    hub.subscribeUpstream('video');
    hub.subscribeUpstream('audio');
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(35);
        expect(hub.objectCount('audio')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // The real playback engine, joined to the live broadcast.
    const { signals } = createSubscriber(hub, disposals);

    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()?.snapshot.get().context.framesScheduled ?? 0).toBeGreaterThan(
          0
        );
        expect(signals.context.videoRendererActor.get()?.snapshot.get().context.lastPresentedTimestampUs).toBeDefined();
      },
      { timeout: 15_000, interval: 100 }
    );

    // Sample the audio track's on-wire timestamps across the switch — the
    // publisher counter mirrors every object written. The MOQT track
    // publisher survives the encoder rebuild by design, so one sampler
    // spans both epochs.
    const audioTrackPublisher = publisher.context.audioTrackPublisher.get()!;
    const wireTimestamps: number[] = [];
    const sampler = setInterval(() => {
      const ts = audioTrackPublisher.snapshot.get().context.lastTimestampUs;

      if (Number.isFinite(ts) && ts !== wireTimestamps[wireTimestamps.length - 1]) wireTimestamps.push(ts);
    }, 10);

    disposals.push(() => clearInterval(sampler));
    await vi.waitFor(() => expect(wireTimestamps.length).toBeGreaterThan(0), { timeout: 15_000 });

    // ── The regression: wallclock steps 30 s BACK, then the mic switches ──
    const audioActorBefore = publisher.context.audioEncoderActor.get();
    const audioObjectsBefore = hub.objectCount('audio');
    const samplesBeforeSwitch = wireTimestamps.length;
    const realNow = Date.now.bind(Date);

    vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 30_000);

    publisher.state.audioInputDeviceId.set('studio-mic');
    await vi.waitFor(
      () => {
        const actor = publisher.context.audioEncoderActor.get();

        expect(actor).toBeDefined();
        expect(actor).not.toBe(audioActorBefore);
      },
      { timeout: 15_000, interval: 100 }
    );

    // Audio keeps flowing on the wire from the new epoch…
    await vi.waitFor(
      () => {
        expect(hub.objectCount('audio')).toBeGreaterThan(audioObjectsBefore + 20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // The sampler really spans both epochs — without post-switch samples
    // the monotonicity assertions below would pass vacuously.
    expect(samplesBeforeSwitch).toBeGreaterThan(0);
    await vi.waitFor(() => expect(wireTimestamps.length).toBeGreaterThan(samplesBeforeSwitch), { timeout: 15_000 });

    // …and the published timeline never stepped: on-wire timestamps stay
    // monotone across the epoch boundary (a fresh anchor would land them
    // 30 s backward), and the switch gap is the real re-acquisition gap
    // (test-scale seconds), not a wallclock artifact in either direction.
    const backwardSteps = wireTimestamps.filter((ts, index) => index > 0 && ts < wireTimestamps[index - 1]!);

    expect(backwardSteps).toEqual([]);
    const largestStepUs = Math.max(...wireTimestamps.slice(1).map((ts, index) => ts - wireTimestamps[index]!));

    expect(largestStepUs).toBeLessThan(15_000_000);

    // Playout stays healthy on BOTH tracks: audio keeps scheduling, video
    // keeps presenting…
    const scheduledAfterSwitch = signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled;
    const presentedAfterSwitch = signals.context.videoRendererActor.get()!.snapshot.get()
      .context.lastPresentedTimestampUs!;

    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled).toBeGreaterThan(
          scheduledAfterSwitch
        );
        expect(
          signals.context.videoRendererActor.get()!.snapshot.get().context.lastPresentedTimestampUs!
        ).toBeGreaterThan(presentedAfterSwitch);
      },
      { timeout: 15_000, interval: 100 }
    );
    // …and presented video still tracks the audio master clock — the
    // cross-track alignment that coherent published timelines buy.
    const clockUs = signals.context.audioRendererActor.get()!.getClockTimeUs()!;
    const presentedUs = signals.context.videoRendererActor.get()!.snapshot.get().context.lastPresentedTimestampUs!;

    expect(Math.abs(presentedUs - clockUs)).toBeLessThan(2_000_000);
  }, 120_000);
});
