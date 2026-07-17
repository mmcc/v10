import { describe, expect, it, vi } from 'vitest';
import type { JitterFrame } from '../../track-subscriber';
import { type AudioFrameSource, createAudioRendererActor } from '../audio-renderer';

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
});
