/// <reference path="../../../behaviors/dom/mediastream-track-processor.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';
import { createSubscriber, makeSyntheticStream } from './helpers/cross-engine-harness';

/**
 * Cross-engine regression for the field late-join failure against relay.mux.dev: audio plays but video is never
 * presented.
 *
 * Chrome's capture pipelines stamp `VideoFrame.timestamp` and `AudioData.timestamp` on _different clocks_ (measurably
 * so in this harness: WebAudio-destination audio rides a boot-relative clock while canvas-capture video starts near
 * zero — real camera/mic splits the same way, with the polarity varying by source). The playback engine's audio
 * renderer owns the master clock and the video renderer presents strictly by timestamp against it (hold-early /
 * drop-late), so the publisher must rebase both tracks onto one shared wallclock timeline before LOC-packaging them.
 * Unrebased, one polarity holds every decoded video frame "in the future" forever — audio plays, video bytes flow, and
 * not one frame is drawn (the field failure) — while the other presents video with no actual A/V alignment at all.
 *
 * The sibling cross-engine test never caught this because its synthetic sources happen to land video _behind_ the audio
 * clock — the sloppy polarity. This test measures the two capture bases at the platform boundary the engine reads
 * (`MediaStreamTrackProcessor`) and re-stamps video onto a clock two hours _ahead_ of the audio clock — the field
 * polarity, too wide for the latency controller to ever close — then requires presented video to track the audio master
 * clock.
 */

const disposals: (() => void)[] = [];

const CAMERA_SIZE = { width: 320, height: 240 } as const;
/**
 * How far ahead of the _audio_ capture clock the video capture clock is pushed. Two hours in microseconds — the audio
 * master clock advances at ≈1×, so no test-scale wait can close it; only a publisher-side rebase can.
 */
const VIDEO_AHEAD_US = 2 * 60 * 60 * 1_000_000;

// The publish-engines project runs in Chromium, where the API exists.
const RealTrackProcessor = MediaStreamTrackProcessor!;

/**
 * Read one frame off each capture pipeline to measure this environment's video-vs-audio capture-clock offset, so the
 * injected skew lands video deterministically ahead of the audio clock whatever the platform bases are.
 */
async function measureAudioMinusVideoBaseUs(): Promise<number> {
  const stream = makeSyntheticStream(CAMERA_SIZE, true, disposals);
  const videoReader = new RealTrackProcessor<VideoFrame>({
    track: stream.getVideoTracks()[0]!,
  }).readable.getReader();
  const audioReader = new RealTrackProcessor<AudioData>({
    track: stream.getAudioTracks()[0]!,
  }).readable.getReader();
  const [video, audio] = await Promise.all([videoReader.read(), audioReader.read()]);
  const offsetUs = audio.value!.timestamp - video.value!.timestamp;

  video.value?.close();
  audio.value?.close();
  await videoReader.cancel().catch(() => undefined);
  await audioReader.cancel().catch(() => undefined);

  for (const track of stream.getTracks()) track.stop();

  return offsetUs;
}

/**
 * Wrap the platform `MediaStreamTrackProcessor` so video tracks deliver frames re-stamped `skewUs` ahead — the
 * cross-track clock split real capture devices exhibit, injected at the exact seam the publish engine's frame pump
 * consumes.
 */
function installSkewedTrackProcessor(skewUs: number): void {
  class SkewedProcessor<T extends AudioData | VideoFrame> {
    readable: ReadableStream<T>;
    constructor(init: { track: MediaStreamTrack }) {
      const inner = new RealTrackProcessor<T>(init);

      if (init.track.kind !== 'video') {
        this.readable = inner.readable;
        return;
      }

      this.readable = (inner.readable as ReadableStream<VideoFrame>).pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          transform(frame, controller) {
            const skewed = new VideoFrame(frame, { timestamp: frame.timestamp + skewUs });

            frame.close();
            controller.enqueue(skewed);
          },
        })
      ) as ReadableStream<T>;
    }
  }
  vi.stubGlobal('MediaStreamTrackProcessor', SkewedProcessor);
}

describe('publish engine ↔ playback engine (cross-domain capture clocks)', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('late-joining playback presents video aligned with the audio master clock despite skewed capture clocks', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () =>
      makeSyntheticStream(CAMERA_SIZE, true, disposals)
    );
    // Video capture two hours ahead of audio capture — the field polarity:
    // decoded video sits "in the future" of the audio master clock.
    installSkewedTrackProcessor((await measureAudioMinusVideoBaseUs()) + VIDEO_AHEAD_US);

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

    // Late join: let ≥1 full video group land at the relay first, the way
    // the field viewer joined ~5s after publish start. Announce-and-serve
    // ingest is pull-through — nothing flows until the relay subscribes —
    // so prime standing upstream demand (the field viewer's predecessors)
    // before measuring the pre-join backlog.
    hub.subscribeUpstream('video');
    hub.subscribeUpstream('audio');
    await vi.waitFor(
      () => {
        expect(hub.objectCount('video')).toBeGreaterThan(35);
        expect(hub.objectCount('audio')).toBeGreaterThan(20);
      },
      { timeout: 15_000, interval: 100 }
    );

    const { canvas: renderCanvas, signals } = createSubscriber(hub, disposals);

    // The audio leg comes up first (`next-object` join) and owns the
    // master clock from then on — the exact regime that starved video in
    // the field.
    await vi.waitFor(
      () => {
        expect(signals.context.audioRendererActor.get()?.snapshot.get().context.framesScheduled ?? 0).toBeGreaterThan(
          0
        );
      },
      { timeout: 15_000, interval: 100 }
    );

    // Video must reach PRESENTED frames under the audio master clock.
    // Unrebased, every decoded frame stays two hours in the future and
    // this times out with audio playing — the field failure signature.
    await vi.waitFor(
      () => {
        const renderer = signals.context.videoRendererActor.get();

        expect(renderer?.snapshot.get().context.lastPresentedTimestampUs).toBeDefined();
      },
      { timeout: 15_000, interval: 100 }
    );
    expect(renderCanvas.width).toBe(CAMERA_SIZE.width);

    // Presentation keeps advancing (not a single self-clocked frame that
    // snuck in before audio scheduled), and the presented video timestamps
    // track the audio master clock — the cross-track alignment contract.
    const firstPresentedUs = signals.context.videoRendererActor.get()!.snapshot.get().context.lastPresentedTimestampUs!;

    await vi.waitFor(
      () => {
        const presentedUs = signals.context.videoRendererActor.get()?.snapshot.get().context.lastPresentedTimestampUs;

        expect(presentedUs ?? 0).toBeGreaterThan(firstPresentedUs);
      },
      { timeout: 15_000, interval: 100 }
    );
    const clockUs = signals.context.audioRendererActor.get()!.getClockTimeUs()!;
    const presentedUs = signals.context.videoRendererActor.get()!.snapshot.get().context.lastPresentedTimestampUs!;

    expect(Math.abs(presentedUs - clockUs)).toBeLessThan(2_000_000);
  }, 120_000);
});
