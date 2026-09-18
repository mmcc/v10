import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createRelayHub } from '../../../tests/helpers/relay-hub';
import { createMoqPublishEngine } from '../engine';
import { createSubscriber, makeSyntheticStream } from './helpers/cross-engine-harness';

const disposals: (() => void)[] = [];

describe('createMoqPublishEngine', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();

    vi.restoreAllMocks();
  });

  it('keeps presented video aligned with audio through delayed object streams and recovery', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockImplementation(async () =>
      makeSyntheticStream({ width: 320, height: 240 }, true, disposals)
    );
    let impaired = false;
    let delayedAudio = 0;
    const hub = createRelayHub({
      deliveryDelayMs: (trackName, object) => {
        if (!impaired || trackName === 'catalog') return 0;

        // Every fifth audio packet arrives after its successor has been
        // consumed. These short holes used to disappear from decoder
        // output timestamps, accumulating permanent A/V drift.
        if (trackName === 'audio' && object.groupId % 5 === 0) {
          delayedAudio++;
          return 700;
        }

        return 100 + ((object.groupId * 37 + object.objectId * 17) % 100);
      },
    });

    disposals.push(() => hub.destroy());
    const publisher = createMoqPublishEngine({
      camera: { codec: 'vp8' },
      connectTransport: hub.connectPublisher,
    });

    disposals.push(() => void publisher.destroy());
    publisher.state.endpoint.set({ url: 'https://relay.test/moq', namespace: ['live'] });
    publisher.state.cameraActive.set(true);
    publisher.state.micActive.set(true);
    publisher.state.publishActivated.set(true);

    const { signals } = createSubscriber(hub, disposals);

    signals.state.paused.set(false);
    await vi.waitFor(
      () => {
        expect(signals.context.videoRendererActor.get()?.snapshot.get().context.lastPresentedTimestampUs).toBeDefined();
        expect(signals.context.audioRendererActor.get()?.getClockTimeUs()).toBeDefined();
      },
      { timeout: 10_000 }
    );

    for (const phase of ['baseline', 'impaired', 'recovery'] as const) {
      impaired = phase === 'impaired';
      const audio = signals.context.audioRendererActor.get()!;
      const video = signals.context.videoRendererActor.get()!;
      const firstAudioUs = audio.getClockTimeUs()!;
      const firstVideoUs = video.snapshot.get().context.lastPresentedTimestampUs!;
      const skews: number[] = [];
      const durationMs = phase === 'impaired' ? 12_000 : 3_000;
      const started = performance.now();

      while (performance.now() - started < durationMs) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const presentedUs = video.snapshot.get().context.lastPresentedTimestampUs!;
        const audioUs = audio.getClockTimeUs()!;

        skews.push(Math.abs(presentedUs - audioUs));
      }

      skews.sort((a, b) => a - b);
      expect(skews[Math.floor(skews.length * 0.95)], `${phase} p95 A/V skew`).toBeLessThan(150_000);
      expect(Math.max(...skews), `${phase} maximum A/V skew`).toBeLessThan(750_000);
      // Aligned frozen clocks are not successful playback.
      expect(audio.getClockTimeUs()! - firstAudioUs, `${phase} audio progress`).toBeGreaterThan(durationMs * 700);
      expect(
        video.snapshot.get().context.lastPresentedTimestampUs! - firstVideoUs,
        `${phase} video progress`
      ).toBeGreaterThan(durationMs * 700);
      expect(audio.snapshot.get().context.status).toBe('rendering');
      expect(video.snapshot.get().context.status).toBe('rendering');
    }

    expect(delayedAudio).toBeGreaterThan(50);
  }, 30_000);
});
