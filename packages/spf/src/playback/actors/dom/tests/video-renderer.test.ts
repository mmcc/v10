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

/**
 * Encode an H.264 sequence in `avc` bitstream format: parameter sets ship
 * out-of-band as `decoderConfig.description` metadata, which is attached
 * to keyframes as LOC Video Config instead of the catalog config.
 */
async function encodeAvcTestFrames(count: number): Promise<JitterFrame[]> {
  const frames: JitterFrame[] = [];
  let description: Uint8Array | undefined;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const configDescription = metadata?.decoderConfig?.description;
      if (configDescription !== undefined && description === undefined) {
        description = ArrayBuffer.isView(configDescription)
          ? new Uint8Array(configDescription.buffer, configDescription.byteOffset, configDescription.byteLength)
          : new Uint8Array(configDescription);
      }
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
  encoder.configure({
    codec: 'avc1.42001f',
    width: WIDTH,
    height: HEIGHT,
    bitrate: 200_000,
    avc: { format: 'avc' },
  });

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

  for (const frame of frames) {
    if (frame.isKey) frame.videoConfig = description;
  }
  return frames;
}

function arraySource(frames: JitterFrame[]): VideoFrameSource {
  const queue = [...frames];
  return {
    peek: () => queue[0],
    dequeue: () => queue.shift(),
  };
}

function fabricatedFrames(count: number): JitterFrame[] {
  return Array.from({ length: count }, (_, i) => ({
    groupId: 0,
    objectId: i,
    timestampUs: i * 1_000,
    isKey: i === 0,
    payload: new Uint8Array([i]),
  }));
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

  it('applies per-keyframe LOC video config as the decoder description', async () => {
    const frames = await encodeAvcTestFrames(5);
    expect(frames[0]!.videoConfig).toBeDefined();

    const canvas = document.createElement('canvas');
    let clockUs = 0;
    const renderer = createVideoRendererActor({ canvas, getClockTimeUs: () => clockUs });

    // The catalog config carries no description — the avc-format bitstream
    // is only decodable with the parameter sets the keyframe ships.
    renderer.setTrack(arraySource(frames), { codec: 'avc1.42001f', codedWidth: WIDTH, codedHeight: HEIGHT });

    // H.264 decoders may hold the final frame until flushed, so expect one
    // less than the input count.
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesDecoded).toBeGreaterThanOrEqual(4), {
      timeout: 5000,
    });
    expect(renderer.snapshot.get().context.status).not.toBe('error');

    clockUs = FRAME_DURATION_US + 1;
    await vi.waitFor(() => {
      expect(renderer.snapshot.get().context.lastPresentedTimestampUs).toBe(FRAME_DURATION_US);
    });

    renderer.destroy();
  });

  it('clearing the track returns to idle', async () => {
    const canvas = document.createElement('canvas');
    const renderer = createVideoRendererActor({ canvas });
    renderer.setTrack(null, null);
    expect(renderer.snapshot.get().context.status).toBe('idle');
    renderer.destroy();
  });

  it('errors when a source is set without a decoder config', async () => {
    const canvas = document.createElement('canvas');
    const renderer = createVideoRendererActor({ canvas, tickIntervalMs: 5 });
    const queue = fabricatedFrames(3);
    const source: VideoFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };

    renderer.setTrack(source, null);

    expect(renderer.snapshot.get().context.status).toBe('error');
    expect(renderer.snapshot.get().context.error).toBeInstanceOf(Error);
    // The rejected source must not be drained (or retained) by the tick loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue).toHaveLength(3);

    renderer.destroy();
  });

  it('stops draining the jitter buffer after a decoder error', async () => {
    const canvas = document.createElement('canvas');
    const queue = fabricatedFrames(6);
    const source: VideoFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createVideoRendererActor({ canvas, tickIntervalMs: 5, getClockTimeUs: () => 0 });

    // A well-formed but undecodable config: the decoder rejects either at
    // configure or on first decode, and the pull loop must stop instead of
    // stripping the queue one frame per tick.
    renderer.setTrack(source, { codec: 'bogus-codec', codedWidth: WIDTH, codedHeight: HEIGHT });

    await vi.waitFor(() => expect(renderer.snapshot.get().context.status).toBe('error'), { timeout: 5000 });
    const remaining = queue.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queue).toHaveLength(remaining);

    renderer.destroy();
  });

  it('self-clock re-anchors across a large timestamp discontinuity', async () => {
    const frames = await encodeTestFrames(6);
    // Latency catch-up: the stream jumps far ahead mid-buffer.
    const JUMP_US = 5_000_000;
    const jumped = frames.map((frame, i) =>
      i < 3 ? frame : { ...frame, timestampUs: JUMP_US + (i - 3) * FRAME_DURATION_US }
    );

    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const renderer = createVideoRendererActor({ canvas });
    const lastPresented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    try {
      renderer.setTrack(arraySource(jumped), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(lastPresented()).toBe(0), { timeout: 5000 });

      // Play through the pre-jump frames…
      now += 100;
      await vi.waitFor(() => expect(lastPresented()).toBeGreaterThanOrEqual(2 * FRAME_DURATION_US), {
        timeout: 5000,
      });

      // …then presentation must jump to the post-discontinuity frames
      // instead of freezing for ~5s of wall time.
      now += 50;
      await vi.waitFor(() => expect(lastPresented()).toBeGreaterThanOrEqual(JUMP_US), { timeout: 5000 });
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('self-clock anchors at the delivery edge, decoding the backlog it does not present', async () => {
    // 1s of replayed video buffered before the renderer starts.
    const frames = await encodeTestFrames(30);
    const NEWEST_US = frames[frames.length - 1]!.timestampUs;
    const ANCHOR_US = NEWEST_US - 200_000;

    const canvas = document.createElement('canvas');
    const now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    // Record what reaches the decoder, in the order it is fed.
    const queue = [...frames];
    const fedUs: number[] = [];
    const source: VideoFrameSource = {
      peek: () => queue[0],
      dequeue: () => {
        const frame = queue.shift();
        if (frame) fedUs.push(frame.timestampUs);
        return frame;
      },
    };
    const renderer = createVideoRendererActor({ canvas, getTargetClockUs: () => ANCHOR_US });
    const presented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    try {
      renderer.setTrack(source, { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });

      // Presentation starts within a frame of the edge — never at frame 0,
      // and without waiting out the ~1s backlog in real time (wall time is
      // frozen, so a first-frame anchor could never get here).
      await vi.waitFor(() => expect(presented()).toBeGreaterThan(ANCHOR_US - 2 * FRAME_DURATION_US), { timeout: 5000 });
      await vi.waitFor(() => expect(queue).toHaveLength(0), { timeout: 5000 });

      // Decode continuity: every frame was fed, in order, starting from
      // the keyframe — the backlog is decoded and dropped, not skipped.
      expect(fedUs).toEqual(frames.map((frame) => frame.timestampUs));
      expect(renderer.snapshot.get().context.framesDropped).toBeGreaterThan(0);
      expect(renderer.snapshot.get().context.status).not.toBe('error');
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('presents at the edge against a master clock that already anchored there', async () => {
    // The production shape: audio owns the clock and anchored it at the
    // live edge, so video's existing drop-late does the fast-forward.
    const frames = await encodeTestFrames(30);
    const ANCHOR_US = frames[frames.length - 1]!.timestampUs - 200_000;

    const canvas = document.createElement('canvas');
    const queue = [...frames];
    const fedUs: number[] = [];
    const source: VideoFrameSource = {
      peek: () => queue[0],
      dequeue: () => {
        const frame = queue.shift();
        if (frame) fedUs.push(frame.timestampUs);
        return frame;
      },
    };
    const renderer = createVideoRendererActor({ canvas, getClockTimeUs: () => ANCHOR_US });
    const presented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    renderer.setTrack(source, { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
    await vi.waitFor(() => expect(presented()).toBeGreaterThan(ANCHOR_US - 2 * FRAME_DURATION_US), { timeout: 5000 });
    await vi.waitFor(() => expect(queue).toHaveLength(0), { timeout: 5000 });

    expect(fedUs).toEqual(frames.map((frame) => frame.timestampUs));
    expect(renderer.snapshot.get().context.framesDropped).toBeGreaterThan(0);

    renderer.destroy();
  });

  it('self-clock re-anchors at the delivery edge across a catch-up discontinuity', async () => {
    const frames = await encodeTestFrames(6);
    // The catch-up skip kept a keyframe-led group starting at JUMP_US and
    // running two frames further on — the group start is not the edge.
    const JUMP_US = 5_000_000;
    const survivingGroup = frames
      .slice(3)
      .map((frame, i) => ({ ...frame, timestampUs: JUMP_US + i * FRAME_DURATION_US }));
    const EDGE_US = JUMP_US + FRAME_DURATION_US;

    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    // The buffer's live edge, one frame back — as the behavior computes it
    // from the subscriber's newest buffered timestamp.
    let newestBufferedUs = 2 * FRAME_DURATION_US;
    const queue = frames.slice(0, 3);
    const source: VideoFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createVideoRendererActor({
      canvas,
      getTargetClockUs: () => newestBufferedUs - FRAME_DURATION_US,
    });
    const presented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    try {
      renderer.setTrack(source, { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(presented()).toBe(FRAME_DURATION_US), { timeout: 5000 });

      // The skip lands: everything before the surviving group is gone.
      queue.push(...survivingGroup);
      newestBufferedUs = JUMP_US + 2 * FRAME_DURATION_US;
      // Let the clock run past the last pre-jump frame so the jump reaches it.
      now += 50;

      // Re-anchoring at the jumped-to frame would resume at the group
      // start; the edge anchor resumes a frame short of its newest.
      await vi.waitFor(() => expect(presented()).toBe(EDGE_US), { timeout: 5000 });
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  // The join-burst race: a relay's group replay arrives as a burst, so an
  // anchor placed on the first read is placed against an edge that had not
  // finished arriving. Under the old anchor-once self-clock that mistake
  // was permanent; edge tracking walks it off.
  it('self-clock slews onto the edge after a short initial anchor', async () => {
    const frames = await encodeTestFrames(30);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    // A live edge advancing in real time. The burst is still arriving when
    // the clock anchors, so the edge it sees then is 400ms short of the
    // truth — and every later reading is 400ms ahead of the clock.
    let shortfallUs = 0;
    const renderer = createVideoRendererActor({ canvas, getTargetClockUs: () => now * 1000 + shortfallUs });

    try {
      renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBe(0), { timeout: 5000 });

      // The rest of the burst lands. The error is inside the >1s hard-reset
      // path, so only the slew can reclaim it.
      shortfallUs = 400_000;
      // 4s of real time at the default 5% → 200ms of correction, on top of
      // the 4s the clock advances on its own.
      now += 4_000;

      // Sampling repeatedly must not multiply the correction: the budget is
      // per unit of real time, not per read.
      for (let i = 0; i < 20; i++) renderer.getClockTimeUs();
      expect(renderer.getClockTimeUs()).toBeCloseTo(4_200_000, -4);

      // …and it keeps closing, rather than settling at a fixed offset.
      now += 4_000;
      expect(renderer.getClockTimeUs()).toBeCloseTo(8_400_000, -4);
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('bounds the slew, leaving jumps to the discontinuity path', async () => {
    const frames = await encodeTestFrames(30);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let targetUs = 0;
    // 10%/s, tolerate 10ms.
    const renderer = createVideoRendererActor({
      canvas,
      getTargetClockUs: () => targetUs,
      clockSlewRate: 0.1,
      clockSlewToleranceUs: 10_000,
    });

    try {
      renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBe(0), { timeout: 5000 });

      // A 900ms error — under the 1s reset threshold, so the slew owns it.
      targetUs = 900_000;
      now += 100;
      // 100ms elapsed × 0.1 → 10ms of correction, plus the 100ms the clock
      // ran. Not a jump to the target.
      expect(renderer.getClockTimeUs()).toBeCloseTo(110_000, -4);

      now += 100;
      expect(renderer.getClockTimeUs()).toBeCloseTo(220_000, -4);

      // Errors inside the tolerance band are left alone — the edge advances
      // in frame-sized steps and chasing them would be chasing noise. An
      // edge 5ms ahead of where the clock is about to be leaves it there.
      targetUs = 325_000;
      now += 100;
      expect(renderer.getClockTimeUs()).toBe(320_000);
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('self-clock reclaims the latency a short pause added', async () => {
    const frames = await encodeTestFrames(30);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let playbackRate = 1;
    // A live edge that keeps advancing in real time while playout holds.
    const startWallMs = 0;
    const renderer = createVideoRendererActor({
      canvas,
      getPlaybackRate: () => playbackRate,
      getTargetClockUs: () => (now - startWallMs) * 1000,
    });

    try {
      renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBe(0), { timeout: 5000 });

      // Pause for 500ms of wall time: the clock holds, the edge does not.
      playbackRate = 0;
      renderer.getClockTimeUs();
      now += 500;
      expect(renderer.getClockTimeUs()).toBe(0);

      // On resume the clock is 500ms behind the edge — under the old
      // anchor-once clock that offset was permanent. The slew now reclaims
      // it at 50ms/s, so ~10s of real time closes it.
      playbackRate = 1;
      for (let i = 0; i < 200; i++) {
        now += 100;
        renderer.getClockTimeUs();
      }
      const edgeUs = (now - startWallMs) * 1000;
      expect(edgeUs - renderer.getClockTimeUs()!).toBeLessThanOrEqual(50_000);
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('self-clock never runs backwards while slewing back onto the edge', async () => {
    const frames = await encodeTestFrames(30);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    // A stalled publisher: the edge stops moving while playout continues,
    // so the error goes negative and the slew pulls the clock back.
    const renderer = createVideoRendererActor({ canvas, getTargetClockUs: () => 0 });

    try {
      renderer.setTrack(arraySource(frames), { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBe(0), { timeout: 5000 });

      let previous = renderer.getClockTimeUs()!;
      for (let i = 0; i < 20; i++) {
        now += 100;
        const clock = renderer.getClockTimeUs()!;
        // Bounded by a *fraction* of elapsed real time, so the correction
        // can only slow the clock down, never reverse it.
        expect(clock).toBeGreaterThan(previous);
        expect(clock - previous).toBeLessThan(100_000);
        previous = clock;
      }
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
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

  it('self-clock freezes on pause even when the decoded queue is empty', async () => {
    const frames = await encodeTestFrames(3);
    const canvas = document.createElement('canvas');
    let now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let playbackRate = 1;
    const renderer = createVideoRendererActor({ canvas, getPlaybackRate: () => playbackRate });
    const lastPresented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    // Source the test tops up mid-run, so the decoded queue can drain to
    // empty before the pause lands.
    const queue: JitterFrame[] = [frames[0]!];
    const source: VideoFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };

    try {
      renderer.setTrack(source, { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(lastPresented()).toBe(0), { timeout: 5000 });

      // Pause with nothing decoded: the rate change must fold into the
      // anchor on the next presentation tick, not when a frame arrives.
      playbackRate = 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      now += 5_000; // 5s of wall time passes mid-pause

      // Frames arriving during the pause hold — a stale anchor would put
      // the clock ~5s ahead and present them immediately.
      queue.push(frames[1]!, frames[2]!);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lastPresented()).toBe(0);

      // Resume: the clock continues from the hold point, so the next frame
      // is due only after its own duration elapses.
      playbackRate = 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      now += 50;
      await vi.waitFor(() => expect(lastPresented()).toBe(FRAME_DURATION_US), { timeout: 5000 });
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });

  it('self-clock does not re-anchor across a discontinuity while paused', async () => {
    const frames = await encodeTestFrames(4);
    // The live edge keeps moving during a pause: frames arriving mid-pause
    // land far ahead of the held clock.
    const JUMP_US = 5_000_000;
    const jumped = frames.map((frame, i) =>
      i < 1 ? frame : { ...frame, timestampUs: JUMP_US + (i - 1) * FRAME_DURATION_US }
    );

    const canvas = document.createElement('canvas');
    const now = 0;
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    let playbackRate = 1;
    const renderer = createVideoRendererActor({ canvas, getPlaybackRate: () => playbackRate });
    const lastPresented = () => renderer.snapshot.get().context.lastPresentedTimestampUs;

    const queue: JitterFrame[] = [jumped[0]!];
    const source: VideoFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };

    try {
      renderer.setTrack(source, { codec: 'vp8', codedWidth: WIDTH, codedHeight: HEIGHT });
      await vi.waitFor(() => expect(lastPresented()).toBe(0), { timeout: 5000 });

      playbackRate = 0;
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Far-ahead frames arriving mid-pause must not trigger the
      // discontinuity re-anchor — that would present them while paused.
      queue.push(jumped[1]!, jumped[2]!, jumped[3]!);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(lastPresented()).toBe(0);

      // On resume the discontinuity re-anchor kicks in and presentation
      // jumps to the live edge instead of freezing for ~5s of wall time.
      playbackRate = 1;
      await vi.waitFor(() => expect(lastPresented()).toBeGreaterThanOrEqual(JUMP_US), { timeout: 5000 });
    } finally {
      nowSpy.mockRestore();
      renderer.destroy();
    }
  });
});
