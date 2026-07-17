import { describe, expect, it, vi } from 'vitest';
import type { JitterFrame } from '../../track-subscriber';
import { createVideoRendererActor, type VideoFrameSource } from '../video-renderer';

const WIDTH = 64;
const HEIGHT = 64;
const FRAME_DURATION_US = 33_333;

/** Encode a short VP8 sequence and return LOC-shaped jitter frames. */
async function encodeTestFrames(count: number): Promise<JitterFrame[]> {
  const frames: JitterFrame[] = [];
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      frames.push({
        groupId: 0,
        objectId: frames.length,
        timestampUs: chunk.timestamp,
        isKey: chunk.type === 'key',
        payload,
      });
    },
    error: (error) => {
      throw error;
    },
  });
  encoder.configure({ codec: 'vp8', width: WIDTH, height: HEIGHT, bitrate: 200_000 });

  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d')!;
  for (let i = 0; i < count; i++) {
    context.fillStyle = `rgb(${(i * 40) % 255}, 80, 160)`;
    context.fillRect(0, 0, WIDTH, HEIGHT);
    const frame = new VideoFrame(canvas, { timestamp: i * FRAME_DURATION_US });
    encoder.encode(frame, { keyFrame: i === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  return frames;
}

function arraySource(frames: JitterFrame[]): VideoFrameSource {
  const queue = [...frames];
  return {
    peek: () => queue[0],
    dequeue: () => queue.shift(),
  };
}

describe('createVideoRendererActor', () => {
  it('decodes pulled frames and presents them against the injected clock', async () => {
    const frames = await encodeTestFrames(5);
    expect(frames[0]!.isKey).toBe(true);

    const canvas = document.createElement('canvas');
    let clockUs = 0;
    const renderer = createVideoRendererActor({
      canvas,
      getClockTimeUs: () => clockUs,
    });

    renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });

    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesDecoded).toBeGreaterThanOrEqual(5), {
      timeout: 5000,
    });

    // Advance the clock past the second frame: it must present (and the
    // first frame is dropped-late or presented, never left behind).
    clockUs = FRAME_DURATION_US + 1;
    await vi.waitFor(() => {
      const { lastPresentedTimestampUs } = renderer.snapshot.get().context;
      expect(lastPresentedTimestampUs).toBe(FRAME_DURATION_US);
    });

    // The canvas took the video's dimensions and has pixels drawn.
    expect(canvas.width).toBe(WIDTH);
    const pixel = canvas.getContext('2d')!.getImageData(1, 1, 1, 1).data;
    expect(pixel[3]).toBe(255);

    renderer.destroy();
  });

  it('waits for a keyframe before decoding (mid-group join)', async () => {
    const frames = await encodeTestFrames(6);
    // Drop the keyframe: only deltas 1..2 then simulate the next group's
    // keyframe by re-encoding? Instead: deltas first, keyframe later.
    const deltasFirst = [...frames.slice(1, 3), frames[0]!];

    const canvas = document.createElement('canvas');
    const renderer = createVideoRendererActor({ canvas, getClockTimeUs: () => 0 });
    renderer.setTrack(arraySource(deltasFirst), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });

    // Only the keyframe (1 frame) decodes; the leading deltas are skipped.
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesDecoded).toBe(1), { timeout: 5000 });
    expect(renderer.snapshot.get().context.status).not.toBe('error');

    renderer.destroy();
  });

  it('clearing the track returns to idle', async () => {
    const canvas = document.createElement('canvas');
    const renderer = createVideoRendererActor({ canvas });
    renderer.setTrack(null, null);
    expect(renderer.snapshot.get().context.status).toBe('idle');
    renderer.destroy();
  });

  it('self-clock applies rate changes forward-only', async () => {
    const frames = await encodeTestFrames(30);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let playbackRate = 1;
    // No master clock: the renderer self-anchors to its first decoded frame.
    const renderer = createVideoRendererActor({ canvas, getPlaybackRate: () => playbackRate });
    const lastPresented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    try {
      renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(lastPresented()).toBe(0), { timeout: 5000 });

      // Run the self-clock ~500ms into the stream.
      now += 500;
      await vi.waitFor(() => expect(lastPresented()).toBeGreaterThanOrEqual(14 * FRAME_DURATION_US), {
        timeout: 5000,
      });
      const before = lastPresented()!;

      // Halving the rate must scale time from here on, not rescale the
      // whole elapsed interval (which would throw the clock ~250ms into
      // the past and freeze presentation).
      playbackRate = 0.5;
      now += 100; // 50ms of media time at the new rate → at least one more frame is due
      await vi.waitFor(() => expect(lastPresented()).toBeGreaterThan(before), { timeout: 5000 });
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });
});
