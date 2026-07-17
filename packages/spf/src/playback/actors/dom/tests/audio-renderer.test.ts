import { describe, expect, it, vi } from 'vitest';
import type { JitterFrame } from '../../track-subscriber';
import { type AudioContextLike, type AudioFrameSource, createAudioRendererActor } from '../audio-renderer';

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = 960; // 20ms opus frames
const FRAME_DURATION_US = 20_000;

/** Encode a short opus sequence and return LOC-shaped jitter frames. */
async function encodeTestFrames(count: number): Promise<JitterFrame[]> {
  const frames: JitterFrame[] = [];
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      frames.push({
        groupId: 0,
        objectId: frames.length,
        timestampUs: frames.length * FRAME_DURATION_US,
        isKey: true,
        payload,
      });
    },
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 32_000 });

  for (let i = 0; i < count; i++) {
    const samples = new Float32Array(FRAME_SAMPLES);
    for (let s = 0; s < FRAME_SAMPLES; s++) samples[s] = Math.sin((2 * Math.PI * 440 * s) / SAMPLE_RATE) * 0.5;
    const data = new AudioData({
      format: 'f32',
      sampleRate: SAMPLE_RATE,
      numberOfFrames: FRAME_SAMPLES,
      numberOfChannels: 1,
      timestamp: i * FRAME_DURATION_US,
      data: samples,
    });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  return frames;
}

function arraySource(frames: JitterFrame[]): AudioFrameSource {
  const queue = [...frames];
  return {
    peek: () => queue[0],
    dequeue: () => queue.shift(),
  };
}

/**
 * `AudioContextLike` with a hand-cranked clock: scheduling is a no-op, so
 * tests can place `currentTime` anywhere and read the media clock back.
 */
function createFakeAudioContext(): AudioContextLike & { currentTime: number } {
  return {
    currentTime: 0,
    destination: {} as AudioNode,
    createBuffer: (_channels, length, sampleRate) =>
      ({ copyToChannel: () => {}, duration: length / sampleRate }) as unknown as AudioBuffer,
    createBufferSource: () =>
      ({
        buffer: null,
        playbackRate: { value: 1 },
        connect: () => {},
        start: () => {},
        stop: () => {},
        onended: null,
      }) as unknown as AudioBufferSourceNode,
  };
}

describe('createAudioRendererActor', () => {
  it('decodes and schedules audio, exposing the master clock', async () => {
    const frames = await encodeTestFrames(5);
    // OfflineAudioContext satisfies AudioContextLike; its clock stays at 0,
    // so the media clock holds at the anchor — deterministic for a test.
    const audioContext = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05 });

    expect(renderer.getClockTimeUs()).toBeUndefined();

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });

    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });
    const context = renderer.snapshot.get().context;
    expect(context.status).toBe('rendering');
    expect(context.scheduledUntilUs).toBeGreaterThan(0);

    // Clock anchored to the first scheduled frame's media time (0), and it
    // holds there while the offline context clock is not advancing.
    expect(renderer.getClockTimeUs()).toBe(0);

    renderer.destroy();
  });

  it('clearing the track resets to idle and drops the anchor', async () => {
    const frames = await encodeTestFrames(2);
    const audioContext = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const renderer = createAudioRendererActor({ audioContext });

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });

    renderer.setTrack(null, null);
    expect(renderer.snapshot.get().context.status).toBe('idle');
    expect(renderer.getClockTimeUs()).toBeUndefined();

    renderer.destroy();
  });

  it('applies rate changes forward-only: already-scheduled audio keeps its clock mapping', async () => {
    const frames = await encodeTestFrames(5);
    const audioContext = createFakeAudioContext();
    let playbackRate = 1;
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getPlaybackRate: () => playbackRate,
    });

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    // The decoder may split outputs, so wait on scheduled media time (the
    // last input chunk spans 80–100ms) rather than an output count.
    await vi.waitFor(
      () => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(4.5 * FRAME_DURATION_US),
      { timeout: 5000 }
    );

    // 30ms into playback (the timeline starts at the 50ms schedule margin).
    audioContext.currentTime = 0.08;
    const before = renderer.getClockTimeUs()!;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(5 * FRAME_DURATION_US);

    // A rate nudge must not rescale time already scheduled at the old
    // rate — the regression here was `clock = anchor + elapsed * newRate`,
    // which jumped by 5% of the total elapsed interval on every nudge.
    playbackRate = 1.5;
    expect(renderer.getClockTimeUs()).toBe(before);

    // The clock advances with the context clock through the scheduled
    // segments regardless of the current rate setting.
    audioContext.currentTime = 0.09;
    const later = renderer.getClockTimeUs()!;
    expect(later).toBeGreaterThan(before);
    expect(later).toBeLessThanOrEqual(before + 10_001);

    renderer.destroy();
  });

  it('holds on underrun and resumes from late-scheduled audio, not the ideal timeline', async () => {
    const frames = await encodeTestFrames(3);
    const audioContext = createFakeAudioContext();
    const queue = [...frames.slice(0, 2)];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05 });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(
      () => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(1.5 * FRAME_DURATION_US),
      { timeout: 5000 }
    );

    // Context clock runs past everything scheduled: the media clock holds
    // at the end of scheduled audio instead of drifting ahead.
    audioContext.currentTime = 0.5;
    const held = renderer.getClockTimeUs()!;
    audioContext.currentTime = 0.6;
    expect(renderer.getClockTimeUs()).toBe(held);
    expect(held).toBeGreaterThanOrEqual(FRAME_DURATION_US);
    expect(held).toBeLessThanOrEqual(2 * FRAME_DURATION_US);

    // The late frame schedules at the context clock; the media clock
    // resumes seamlessly from where it held — not from where the original
    // anchor says it "should" be (~550ms in).
    queue.push(frames[2]!);
    await vi.waitFor(
      () => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(2.5 * FRAME_DURATION_US),
      { timeout: 5000 }
    );
    audioContext.currentTime = 0.61;
    const resumed = renderer.getClockTimeUs()!;
    expect(resumed).toBeGreaterThanOrEqual(held);
    expect(resumed).toBeLessThan(held + FRAME_DURATION_US);

    renderer.destroy();
  });

  it('schedules only up to the horizon instead of draining a backlog in one tick', async () => {
    const frames = await encodeTestFrames(50); // 1s of audio, all buffered up-front
    const audioContext = createFakeAudioContext(); // context clock frozen at 0
    const queue = [...frames];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05 });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(
      () => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(7 * FRAME_DURATION_US),
      { timeout: 5000 }
    );
    // Let a few more ticks run: with the clock frozen, scheduling must
    // stop at the horizon (margin * 4 plus in-flight decodes), leaving
    // the rest of the backlog in the source's jitter buffer.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(renderer.snapshot.get().context.scheduledUntilUs).toBeLessThan(20 * FRAME_DURATION_US);
    expect(queue.length).toBeGreaterThan(30);

    renderer.destroy();
  });
});
