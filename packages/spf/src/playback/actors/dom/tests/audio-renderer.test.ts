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

  // The clock deliberately hides an underrun — it clamps to the segment
  // end and resumes seamlessly, which is right for presentation and
  // useless as a signal. This counter is the only direct evidence that a
  // target latency is below what the path sustains.
  it('counts the rising edge of a schedule that ran dry', async () => {
    const frames = await encodeTestFrames(3);
    const audioContext = createFakeAudioContext();
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05, tickIntervalMs: 1 });

    // Nothing scheduled is not an underrun: at join there is no schedule
    // to starve.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(renderer.snapshot.get().context.underruns).toBe(0);

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(renderer.snapshot.get().context.underruns).toBe(0);

    // The source is exhausted; walk the hardware clock past everything
    // scheduled and the schedule is dry.
    audioContext.currentTime = 60;
    await vi.waitFor(() => expect(renderer.snapshot.get().context.underruns).toBe(1), { timeout: 5000 });

    // Still dry several ticks later — one starvation, one increment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renderer.snapshot.get().context.underruns).toBe(1);

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

  it('errors when a source is set without a decoder config', async () => {
    const audioContext = createFakeAudioContext();
    const renderer = createAudioRendererActor({ audioContext, tickIntervalMs: 5 });
    const queue: JitterFrame[] = [
      { groupId: 0, objectId: 0, timestampUs: 0, isKey: true, payload: new Uint8Array([1]) },
      { groupId: 0, objectId: 1, timestampUs: 20_000, isKey: true, payload: new Uint8Array([2]) },
    ];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };

    renderer.setTrack(source, null);

    expect(renderer.snapshot.get().context.status).toBe('error');
    expect(renderer.snapshot.get().context.error).toBeInstanceOf(Error);
    // The rejected source must not be drained (or retained) by the tick loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queue).toHaveLength(2);

    renderer.destroy();
  });

  it('stops draining the jitter buffer after a decoder error', async () => {
    const frames = await encodeTestFrames(10);
    const audioContext = createFakeAudioContext();
    const queue = [...frames];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createAudioRendererActor({ audioContext, tickIntervalMs: 5 });

    // A well-formed but undecodable config: the decoder rejects either at
    // configure or on first decode, and the pull loop must stop instead of
    // stripping the queue one frame per tick.
    renderer.setTrack(source, { codec: 'bogus-codec', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });

    await vi.waitFor(() => expect(renderer.snapshot.get().context.status).toBe('error'), { timeout: 5000 });
    const remaining = queue.length;
    expect(remaining).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(queue).toHaveLength(remaining);

    renderer.destroy();
  });

  it('decodes a live-edge join whose first frame is mid-group (isKey: false)', async () => {
    const frames = await encodeTestFrames(3);
    // A `largest-object` subscribe joins live, so the first delivered frame
    // is whatever object is newest right now — essentially never a LOC
    // group's object 0 (`isKey: true`). The regression: decode() gated the
    // WebCodecs chunk type on `isKey`, and WebCodecs rejects a 'delta'
    // chunk as the first one fed to a fresh decoder.
    frames[0] = { ...frames[0]!, groupId: 3, objectId: 7, isKey: false };
    const audioContext = new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE);
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05 });

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });

    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(renderer.snapshot.get().context.status).toBe('rendering');

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

  it('re-anchors instead of inserting silence on a large timestamp jump', async () => {
    const frames = await encodeTestFrames(3);
    // Latency catch-up: everything from the third frame on arrives from far
    // ahead of the scheduled timeline. The whole tail moves (the encoder's
    // flush can emit one more output than was fed) — a real skip relocates
    // the stream, it does not interleave two timelines.
    const JUMP_US = 5_000_000;
    for (let i = 2; i < frames.length; i++) {
      frames[i] = { ...frames[i]!, timestampUs: JUMP_US + (i - 2) * FRAME_DURATION_US };
    }
    const audioContext = createFakeAudioContext();
    const renderer = createAudioRendererActor({ audioContext, scheduleMargin: 0.05 });

    renderer.setTrack(arraySource(frames), { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(JUMP_US), {
      timeout: 5000,
    });

    // Without re-anchoring the jump maps to ~5s of scheduled silence, so
    // shortly into playback the clock would still sit in the pre-jump
    // timeline; the reset schedules the jumped audio right at the context
    // clock (+margin) and the media clock lands past the jump immediately.
    audioContext.currentTime = 0.06;
    expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(JUMP_US);

    renderer.destroy();
  });

  it('anchors at the live edge, discarding the replayed backlog unheard', async () => {
    // The relay replayed 1s of audio before the first tick runs.
    const frames = await encodeTestFrames(50);
    const NEWEST_US = 49 * FRAME_DURATION_US;
    const TARGET_S = 0.2;
    const ANCHOR_US = NEWEST_US - TARGET_S * 1_000_000;
    const audioContext = createFakeAudioContext();
    const queue = [...frames];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getJoinAnchorUs: () => ANCHOR_US,
    });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });

    // The 39 pre-anchor frames left the buffer without being decoded: none
    // remain, and nothing like that many were scheduled.
    expect(queue.every((frame) => frame.timestampUs >= ANCHOR_US)).toBe(true);
    expect(renderer.snapshot.get().context.framesScheduled).toBeLessThan(15);
    expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThan(ANCHOR_US);

    // The clock reads the anchor, not 0 — and the backlog did not become
    // ~800ms of scheduled silence in front of it, which would put the
    // clock back at the start of the timeline this far into playback.
    expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(ANCHOR_US);
    audioContext.currentTime = 0.06;
    expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(ANCHOR_US);

    renderer.destroy();
  });

  it('leaves a buffer shallower than the target alone', async () => {
    const frames = await encodeTestFrames(5);
    const audioContext = createFakeAudioContext();
    const queue = [...frames];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    // A live join with no replay: the edge is inside the target, so the
    // anchor sits behind the buffer head and must not move playout.
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getJoinAnchorUs: () => -400_000,
    });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });

    expect(renderer.getClockTimeUs()).toBe(0);

    renderer.destroy();
  });

  it('re-anchors at the live edge after a catch-up skip, not at the group start', async () => {
    const frames = await encodeTestFrames(30);
    const audioContext = createFakeAudioContext();
    // Two 300ms stretches either side of a catch-up skip: the controller
    // drops the buffer to the newest keyframe-led group, so the surviving
    // group still starts ~5s of media time behind its own newest frame.
    const SKIP_US = 5_000_000;
    const queue = frames.slice(0, 15);
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    let anchorUs: number | undefined;
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getJoinAnchorUs: () => anchorUs,
    });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(() => expect(renderer.snapshot.get().context.framesScheduled).toBeGreaterThan(0), {
      timeout: 5000,
    });
    expect(renderer.getClockTimeUs()).toBe(0);

    // The skip lands: the surviving group runs SKIP_US … SKIP_US + 300ms.
    const survivingGroup = frames
      .slice(15)
      .map((frame, i) => ({ ...frame, timestampUs: SKIP_US + i * FRAME_DURATION_US }));
    const newestUs = survivingGroup[survivingGroup.length - 1]!.timestampUs;
    anchorUs = newestUs - 100_000;
    queue.length = 0;
    queue.push(...survivingGroup);
    // Play out what was scheduled before the skip, so the schedule horizon
    // reopens and the renderer pulls the jumped-to timeline.
    audioContext.currentTime = 0.25;

    // Playout resumes within the target of the edge, rather than at the
    // group start SKIP_US — which is what the plain discontinuity
    // re-anchor would have done.
    await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(anchorUs!), { timeout: 5000 });
    expect(renderer.getClockTimeUs()).toBeLessThanOrEqual(newestUs + FRAME_DURATION_US);

    renderer.destroy();
  });

  // A publisher that replaces its capture source re-anchors that track's
  // timeline; landing *behind* the old one must be treated as the timeline
  // reset it is. Butt-joining it (the backward jump slips past a
  // forward-only check) keeps audio playing seamlessly while the master
  // clock silently steps backwards by the jump — and the slaved video
  // renderer then holds every frame it ever receives "early", frozen
  // exactly the step behind for the rest of the stream.
  it('re-anchors onto a timeline that stepped backwards instead of continuing the old one', async () => {
    const frames = await encodeTestFrames(6);
    const BASE_US = 10_000_000;
    const STEP_BACK_US = 5_000_000;
    const TARGET_US = 100_000;
    const old = frames.slice(0, 3).map((frame, i) => ({ ...frame, timestampUs: BASE_US + i * FRAME_DURATION_US }));
    const fresh = frames
      .slice(3)
      .map((frame, i) => ({ ...frame, timestampUs: BASE_US - STEP_BACK_US + i * FRAME_DURATION_US }));
    const audioContext = createFakeAudioContext();
    const queue = [...old];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    let edgeUs = old[old.length - 1]!.timestampUs;
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getJoinAnchorUs: () => edgeUs - TARGET_US,
    });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(
      () =>
        expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(BASE_US + FRAME_DURATION_US),
      { timeout: 5000 }
    );
    audioContext.currentTime = 0.06;
    expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(BASE_US);

    // The switched source's timeline arrives a whole step behind, delivered
    // continuously; the subscriber's edge has already reset onto it.
    queue.push(...fresh);
    edgeUs = fresh[fresh.length - 1]!.timestampUs;

    // The clock lands on the new timeline at the join anchor — with the fake
    // context clock frozen inside the old schedule, a butt-join would keep
    // reading the old timeline here instead.
    await vi.waitFor(
      () => {
        const clock = renderer.getClockTimeUs();
        expect(clock).toBeDefined();
        expect(clock!).toBeLessThan(BASE_US);
        expect(clock!).toBeGreaterThanOrEqual(edgeUs - TARGET_US);
      },
      { timeout: 5000 }
    );

    // …and playout proceeds through the anchor gap into the new audio.
    audioContext.currentTime = 0.2;
    await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(fresh[0]!.timestampUs), {
      timeout: 5000,
    });

    renderer.destroy();
  });

  // A discontinuity interrupts playout that already ran at depth, so the
  // re-join lands *at the join anchor* (the target latency) rather than at
  // arrival. Landing at arrival collapses playout to the live edge — the
  // reported "audio jumps to real-time" — which the latency controller then
  // spends tens of pitch-shifted seconds rebuilding at its ±5% nudge.
  it('lands a discontinuity re-join at the join anchor instead of racing to the arrival edge', async () => {
    const frames = await encodeTestFrames(6);
    const JUMP_US = 5_000_000;
    const TARGET_US = 200_000;
    const old = frames.slice(0, 3).map((frame, i) => ({ ...frame, timestampUs: i * FRAME_DURATION_US }));
    const fresh = frames.slice(3).map((frame, i) => ({ ...frame, timestampUs: JUMP_US + i * FRAME_DURATION_US }));
    const audioContext = createFakeAudioContext();
    const queue = [...old];
    const source: AudioFrameSource = { peek: () => queue[0], dequeue: () => queue.shift() };
    let edgeUs = old[old.length - 1]!.timestampUs;
    const renderer = createAudioRendererActor({
      audioContext,
      scheduleMargin: 0.05,
      getJoinAnchorUs: () => edgeUs - TARGET_US,
    });

    renderer.setTrack(source, { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    await vi.waitFor(
      () => expect(renderer.snapshot.get().context.scheduledUntilUs).toBeGreaterThanOrEqual(FRAME_DURATION_US),
      { timeout: 5000 }
    );

    queue.push(...fresh);
    edgeUs = fresh[fresh.length - 1]!.timestampUs;
    const anchorUs = edgeUs - TARGET_US;

    // The clock resumes at the anchor — target depth behind the jumped-to
    // edge — not at the buffer head the way an at-arrival landing would.
    await vi.waitFor(
      () => {
        const clock = renderer.getClockTimeUs();
        expect(clock).toBeDefined();
        expect(clock!).toBeGreaterThanOrEqual(anchorUs);
        expect(clock!).toBeLessThan(fresh[0]!.timestampUs);
      },
      { timeout: 5000 }
    );

    // Advancing the context clock through the anchor gap reaches the head.
    audioContext.currentTime = 0.3;
    await vi.waitFor(() => expect(renderer.getClockTimeUs()).toBeGreaterThanOrEqual(fresh[0]!.timestampUs), {
      timeout: 5000,
    });

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
