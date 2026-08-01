import { afterEach, describe, expect, it, vi } from 'vitest';
// The real playback engine, from the `@videojs/spf/moq` entry module —
// parent-owned reference implementation; used, never modified.
import { createMoqEngine, type MoqEngineSignals } from '../../../../playback/engines/moq/index';
import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';

/**
 * Cross-engine regression suite: the real publish engine (DEFAULT encoder
 * config — H.264 in `annexb` bitstream format, self-describing keyframes;
 * see `probe-encoder-support.ts` for why `avc` + LOC Config carriage was
 * abandoned) publishing through an in-memory draft-19 relay hub to the
 * real playback engine rendering onto a canvas.
 *
 * Covers the three real-world publisher bugs:
 * - a LATE-joining subscriber (after ≥1 group boundary) must reach decoded
 *   video with the default codec config;
 * - a camera → screen capture switch must keep the session and the
 *   PUBLISHed tracks alive (no PUBLISH_DONE, no reconnect) and get the
 *   subscriber decoding the new-resolution video within a few seconds;
 * - audio must keep flowing to the subscriber across the switch.
 */

const disposals: (() => void)[] = [];

const CAMERA_SIZE = { width: 320, height: 240 } as const;
const SCREEN_SIZE = { width: 480, height: 360 } as const;

/** An animated canvas track + oscillator audio, standing in for a device. */
function makeSyntheticStream(size: { width: number; height: number }, withAudio: boolean): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d')!;
  let hue = 0;
  const paint = setInterval(() => {
    hue = (hue + 11) % 360;
    context.fillStyle = `hsl(${hue}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  disposals.push(() => clearInterval(paint));
  const stream = canvas.captureStream(30);

  if (withAudio) {
    const audioContext = new AudioContext({ sampleRate: 48_000 });
    disposals.push(() => void audioContext.close().catch(() => undefined));
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    void audioContext.resume().catch(() => undefined);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }
  return stream;
}

/**
 * Stub capture: camera getUserMedia returns canvas+oscillator; screen
 * getDisplayMedia returns a different-resolution video-only canvas stream,
 * so the engine's mic-merge path issues an audio-only getUserMedia.
 */
function installCaptureStubs(): void {
  vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async (constraints?: MediaStreamConstraints) => {
    if (constraints && !constraints.video) {
      return makeSyntheticStream(CAMERA_SIZE, true); // audio-only ask: mic merge
    }
    return makeSyntheticStream(CAMERA_SIZE, true);
  });
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    getDisplayMedia: (constraints?: unknown) => Promise<MediaStream>;
  };
  vi.spyOn(mediaDevices, 'getDisplayMedia').mockImplementation(async () => makeSyntheticStream(SCREEN_SIZE, false));
}

describe('publish engine ↔ playback engine (relay hub)', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
    vi.restoreAllMocks();
  });

  it('late-joining playback decodes default-config video, and a camera→screen switch keeps tracks alive', async () => {
    installCaptureStubs();
    const hub = createRelayHub();
    disposals.push(() => hub.destroy());

    // ── Publish (default codec config: avc1, annexb format) ──────────────
    const publisher = createMoqPublishEngine({
      groupDurationSec: 1,
      connectTransport: hub.connectPublisher,
    });
    disposals.push(() => void publisher.destroy());

    publisher.state.endpoint.set({ url: 'https://relay.test/moq', namespace: ['live'] });
    publisher.state.captureSource.set({ kind: 'camera' });
    publisher.state.publishActivated.set(true);

    await vi.waitFor(() => expect(publisher.state.sessionStatus.get()).toBe('live'), { timeout: 10_000 });
    // The default ladder must have picked H.264 — the codec real-relay
    // interop runs on, and the one whose bitstream format choice decides
    // whether keyframes are self-describing.
    await vi.waitFor(() => {
      expect(publisher.state.activeEncodings.get()?.video?.codec).toMatch(/^avc1/);
    });

    // ── Let ≥1 group boundary pass before anyone subscribes ──────────────
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(35); // > one full 1s group at 30fps
        expect(hub.objectCount('audio')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    // ── Late join: the real playback engine ──────────────────────────────
    let signals!: MoqEngineSignals;
    const player = createMoqEngine({
      createMoqTransport: () => hub.connectSubscriber(),
      onSignalsReady: (refs) => {
        signals = refs;
      },
    });
    disposals.push(() => void player.destroy());

    const renderCanvas = document.createElement('canvas');
    const playerAudioContext = new AudioContext({ sampleRate: 48_000 });
    disposals.push(() => void playerAudioContext.close().catch(() => undefined));
    void playerAudioContext.resume().catch(() => undefined);
    signals.context.renderSurface.set(renderCanvas);
    signals.context.audioContext.set(playerAudioContext);
    signals.state.presentation.set({ url: 'moqt://relay.test/live#msf:live--catalog' });
    signals.state.loadActivated.set(true);

    // Bug A regression: the late joiner must reach decoded, PRESENTED
    // video from a post-join keyframe with the default codec config.
    await vi.waitFor(
      () => {
        const renderer = signals.context.videoRendererActor.get();
        expect(renderer?.snapshot.get().context.framesDecoded ?? 0).toBeGreaterThan(0);
        expect(renderer?.snapshot.get().context.lastPresentedTimestampUs).toBeDefined();
      },
      { timeout: 15_000, interval: 100 }
    );
    // The canvas took the camera stream's dimensions on present.
    expect(renderCanvas.width).toBe(CAMERA_SIZE.width);
    // Audio is being scheduled from the live opus track.
    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()?.snapshot.get().context.framesScheduled ?? 0).toBeGreaterThan(
          0
        );
      },
      { timeout: 15_000, interval: 100 }
    );

    // ── Bug B/C regression: switch camera → screen while subscribed ──────
    const audioObjectsBeforeSwitch = hub.objectCount('audio');
    const publishDonesBeforeSwitch = hub.publishDones.length;
    const connectionsBeforeSwitch = hub.publisherConnections();

    publisher.state.captureSource.set({ kind: 'screen' });

    // The subscriber reaches NEW-resolution video within a few seconds:
    // the switch produced a fresh keyframe-led group carrying the new
    // parameter sets, on the SAME track, session, and subscription.
    await vi.waitFor(() => expect(renderCanvas.width).toBe(SCREEN_SIZE.width), { timeout: 15_000, interval: 100 });

    // Audio objects kept flowing from the merged mic after the switch.
    await vi.waitFor(
      () => {
        expect(hub.objectCount('audio')).toBeGreaterThan(audioObjectsBeforeSwitch + 20);
      },
      { timeout: 15_000, interval: 100 }
    );
    // …and the subscriber keeps scheduling them.
    const scheduledAfterSwitch = signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled;
    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()!.snapshot.get().context.framesScheduled).toBeGreaterThan(
          scheduledAfterSwitch
        );
      },
      { timeout: 15_000, interval: 100 }
    );

    // No track ended and no session churn across the switch: a real relay
    // treats PUBLISH_DONE as the end of the track, freezing every
    // subscriber.
    expect(hub.publishDones.length).toBe(publishDonesBeforeSwitch);
    expect(hub.publisherConnections()).toBe(connectionsBeforeSwitch);
    expect(publisher.state.sessionStatus.get()).toBe('live');

    // Orderly unpublish still ends every track with PUBLISH_DONE.
    publisher.state.publishActivated.set(false);
    await vi.waitFor(
      () => {
        const doneTracks = hub.publishDones.map((done) => done.trackName);
        expect(doneTracks).toContain('video');
        expect(doneTracks).toContain('audio');
        expect(doneTracks).toContain('catalog');
      },
      { timeout: 10_000 }
    );
  }, 120_000);
});
