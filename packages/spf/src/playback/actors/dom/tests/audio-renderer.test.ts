import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { JitterFrame } from '../../track-subscriber';
import {
  type AudioContextLike,
  type AudioFrameSource,
  type AudioPlayer,
  type AudioPlayerInput,
  type AudioPlayerInputOptions,
  createAudioRendererActor,
} from '../audio-renderer';

const FRAME_US = 20_000;
const JITTER_TARGET_US = 60_000;
const TICK_MS = 10;
const CONFIG: AudioDecoderConfig = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 };

/** An Opus TOC byte for one 20 ms CELT frame (config 19, code 0). */
const OPUS_20MS_TOC = 19 << 3;

function frameAt(timestampUs: number): JitterFrame {
  return { groupId: timestampUs, objectId: 0, timestampUs, isKey: true, payload: new Uint8Array([OPUS_20MS_TOC]) };
}

/** Frames every 20 ms over `[fromUs, untilUs)`. */
function framesBetween(fromUs: number, untilUs: number): JitterFrame[] {
  const frames: JitterFrame[] = [];

  for (let timestampUs = fromUs; timestampUs < untilUs; timestampUs += FRAME_US) frames.push(frameAt(timestampUs));

  return frames;
}

function queueSource(frames: JitterFrame[] = []): AudioFrameSource & { queue: JitterFrame[] } {
  const queue = [...frames];

  return { queue, peek: () => queue[0], dequeue: () => queue.shift() };
}

interface FakeInput extends AudioPlayerInput {
  options: AudioPlayerInputOptions;
  pushed: number[];
  cuts: number;
  removed: boolean;
  stats: { playing: boolean; bufferedUs: number; jitterTargetUs: number };
}

/** The core's surface with no audio behind it: pushes are recorded, and the test plays the worklet's reports. */
function createFakePlayer() {
  const inputs: FakeInput[] = [];
  const connected: AudioNode[] = [];
  let closed = false;
  const player: AudioPlayer = {
    output: { connect: (destination) => connected.push(destination) },
    addInput(options = {}) {
      const input: FakeInput = {
        options,
        pushed: [],
        cuts: 0,
        removed: false,
        playbackRate: options.playbackRate ?? 1,
        stats: { playing: true, bufferedUs: 0, jitterTargetUs: JITTER_TARGET_US },
        push(frame) {
          input.pushed.push(frame.timestampUs);
        },
        cut() {
          input.cuts++;
        },
        remove() {
          input.removed = true;
        },
      };

      inputs.push(input);
      return input;
    },
    close() {
      closed = true;
    },
  };

  return {
    player,
    inputs,
    connected,
    get closed() {
      return closed;
    },
    /** The worklet reporting that the audio at `timestampUs` is audible now. */
    report(timestampUs: number, atUs: number) {
      inputs[inputs.length - 1]!.options.clock!.reportAudio(timestampUs, atUs);
    },
  };
}

// SAFETY: the renderer only hands `destination` to `output.connect`, which the fake records by identity.
const destination = {} as AudioNode;

/** Context time follows the test's clock; `suspended` freezes it, as `AudioContext.suspend()` does. */
let contextUs = 0;
let suspended = false;

function fakeAudioContext(outputLatency?: number): AudioContextLike {
  return {
    get currentTime() {
      return contextUs / 1_000_000;
    },
    destination,
    outputLatency,
  };
}

describe('createAudioRendererActor', () => {
  let nowUs = 0;

  /** Move wall time, and context time with it unless the context is suspended. */
  const at = (us: number) => {
    if (!suspended) contextUs += us - nowUs;

    nowUs = us;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    at(0);
    contextUs = 0;
    suspended = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A renderer whose player is ready and whose first input exists. */
  async function setup(
    options: {
      getJoinAnchorUs?: () => number | undefined;
      getPlaybackRate?: () => number;
      outputLatency?: number;
    } = {}
  ) {
    const { outputLatency, ...rendererOptions } = options;
    const fake = createFakePlayer();
    const renderer = createAudioRendererActor({
      audioContext: fakeAudioContext(outputLatency),
      createAudioPlayer: () => Promise.resolve(fake.player),
      tickIntervalMs: TICK_MS,
      ...rendererOptions,
    });

    await vi.advanceTimersByTimeAsync(0);
    return { fake, renderer };
  }

  const tick = () => vi.advanceTimersByTime(TICK_MS);

  it('connects the player output to the context destination', async () => {
    const { fake, renderer } = await setup();

    expect(fake.connected).toEqual([destination]);
    expect(renderer.getClockTimeUs()).toBeUndefined();

    renderer.destroy();
    expect(fake.closed).toBe(true);
  });

  it('fills to the jitter target plus a frame, then meters by the clock', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 1_000_000));

    renderer.setTrack(source, CONFIG);
    tick();

    const input = fake.inputs[0]!;

    expect(input.options.decoderConfig).toEqual(CONFIG);
    expect(input.pushed).toEqual([0, 20_000, 40_000, 60_000]);
    expect(renderer.getClockTimeUs()).toBeUndefined();

    // Playing: the worklet should hold about its target ahead of what renders.
    fake.report(0, 0);
    at(30_000);
    tick();

    expect(input.pushed.at(-1)).toBe(80_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(30_000, 0);
    expect(renderer.snapshot.get().context.scheduledUntilUs).toBe(100_000);
  });

  it('joins at the edge, dropping buffered audio behind the anchor unheard', async () => {
    const { fake, renderer } = await setup({ getJoinAnchorUs: () => 200_000 });

    renderer.setTrack(queueSource(framesBetween(0, 1_000_000)), CONFIG);
    tick();

    expect(fake.inputs[0]!.pushed[0]).toBe(200_000);
  });

  it('holds the clock where the worklet ran dry, through the refill, until audio past it plays', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    at(100_000);
    tick();
    expect(renderer.getClockTimeUs()).toBeCloseTo(80_000, 0);

    // Audio comes back: the refill moves the pushed end, not the clock.
    fake.inputs[0]!.stats.playing = false;
    source.queue.push(...framesBetween(80_000, 400_000));
    at(300_000);
    tick();
    expect(fake.inputs[0]!.pushed.slice(4)).toEqual([80_000, 100_000, 120_000, 140_000]);
    expect(renderer.getClockTimeUs()).toBeCloseTo(80_000, 0);

    fake.report(80_000, 320_000);
    at(330_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(90_000, 0);
  });

  it('does not step back when the refill is reported ahead of being audible', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);
    at(100_000);
    tick();

    fake.inputs[0]!.stats.playing = false;
    source.queue.push(...framesBetween(80_000, 400_000));
    at(300_000);
    tick();

    // Rendered now, audible 100 ms from now: the anchor alone reads 80 ms behind the hold.
    fake.report(80_000, 400_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(80_000, 0);

    at(410_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(90_000, 0);
  });

  it('resumes from the audible position when audio returns before the device drained', async () => {
    const { fake, renderer } = await setup({ outputLatency: 0.05 });
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    // Rendering passed the last pushed sample; 50 ms of it is still in the device.
    at(30_000);
    tick();
    expect(renderer.getClockTimeUs()).toBeCloseTo(30_000, 0);

    fake.inputs[0]!.stats.playing = false;
    source.queue.push(...framesBetween(80_000, 400_000));
    at(40_000);
    tick();
    fake.report(80_000, 90_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(40_000, 0);
  });

  it('ends pushed audio where the last packet ends, not across a gap of lost packets', async () => {
    const { fake, renderer } = await setup();

    renderer.setTrack(queueSource([0, 20_000, 40_000, 100_000].map(frameAt)), CONFIG);
    tick();
    fake.report(0, 0);
    at(60_000);
    tick();

    expect(fake.inputs[0]!.pushed).toEqual([0, 20_000, 40_000, 100_000]);
    expect(renderer.snapshot.get().context.scheduledUntilUs).toBe(120_000);
  });

  it('keeps the hold through a late report of the audio before the underrun', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);
    at(100_000);
    tick();

    // The refill is pushed before the core has said it stopped; then the
    // tail's last report, still in flight, arrives.
    source.queue.push(...framesBetween(80_000, 400_000));
    tick();
    fake.report(77_333, 77_333);
    at(200_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(80_000, 0);
  });

  it('holds a placed re-join clock at the audio pushed while the fill is short', async () => {
    let anchorUs: number | undefined;
    const { fake, renderer } = await setup({ getJoinAnchorUs: () => anchorUs });
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    anchorUs = 4_900_000;
    source.queue.push(frameAt(5_000_000));
    tick();
    at(100_000);
    tick();
    expect(fake.inputs[0]!.pushed.at(-1)).toBe(5_000_000);

    // One packet cannot start the worklet; the clock stops at its end.
    at(2_100_000);
    tick();
    expect(renderer.getClockTimeUs()).toBeCloseTo(5_020_000, 0);

    // The refill plays, reported ahead of being audible: no step back.
    source.queue.push(...framesBetween(5_020_000, 5_200_000));
    tick();
    fake.report(5_000_000, 2_150_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(5_020_000, 0);
  });

  it('gives the core a report time source that stops while the context is suspended', async () => {
    const { fake, renderer } = await setup();

    renderer.setTrack(queueSource(framesBetween(0, 1_000_000)), CONFIG);
    tick();

    const clock = fake.inputs[0]!.options.clock!;

    at(40_000);
    expect(clock.localNow()).toBeCloseTo(40_000, 0);

    suspended = true;
    at(540_000);
    expect(clock.localNow()).toBeCloseTo(40_000, 0);

    // The first report after resume, timed on that source, lands where audio is.
    suspended = false;
    at(560_000);
    fake.report(60_000, clock.localNow());
    expect(renderer.getClockTimeUs()).toBeCloseTo(60_000, 0);
  });

  it('drops what the core holds at a timeline reset and ignores reports from before it', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    // A publisher re-anchor: the timeline steps back by far more than a gap.
    source.queue.push(...framesBetween(-5_000_000, -4_000_000));
    tick();

    const input = fake.inputs[0]!;

    expect(input.cuts).toBe(1);
    expect(input.pushed.at(4)).toBe(-5_000_000);
    expect(renderer.getClockTimeUs()).toBeUndefined();

    // Still in flight from the old timeline when the cut landed.
    fake.report(40_000, 0);
    expect(renderer.getClockTimeUs()).toBeUndefined();

    fake.report(-5_000_000, 0);
    expect(renderer.getClockTimeUs()).toBeCloseTo(-5_000_000, 0);
  });

  it('places a re-join whose whole buffer is past the anchor at its distance from it', async () => {
    let anchorUs: number | undefined;
    const { fake, renderer } = await setup({ getJoinAnchorUs: () => anchorUs });
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    // A catch-up skip landed on a group 100 ms past where the anchor falls.
    anchorUs = 4_900_000;
    source.queue.push(...framesBetween(5_000_000, 6_000_000));
    tick();

    const input = fake.inputs[0]!;

    expect(input.pushed).toHaveLength(4);
    expect(renderer.getClockTimeUs()).toBeCloseTo(4_900_000, 0);

    at(50_000);
    tick();
    expect(input.pushed.at(4)).toBe(5_000_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(4_950_000, 0);
  });

  it('freezes the clock and stops metering while the context is suspended', async () => {
    const { fake, renderer } = await setup();
    const source = queueSource(framesBetween(0, 1_000_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);
    at(30_000);
    tick();

    const pushed = fake.inputs[0]!.pushed.length;

    // Paused for two seconds: nothing plays, so nothing is due and nothing ran dry.
    suspended = true;
    at(2_030_000);
    tick();
    expect(renderer.getClockTimeUs()).toBeCloseTo(30_000, 0);
    expect(fake.inputs[0]!.pushed).toHaveLength(pushed);

    suspended = false;
    at(2_040_000);
    expect(renderer.getClockTimeUs()).toBeCloseTo(40_000, 0);
  });

  it('ignores reports from an input that a track change removed', async () => {
    const { fake, renderer } = await setup();

    renderer.setTrack(queueSource(framesBetween(0, 1_000_000)), CONFIG);
    tick();

    const stale = fake.inputs[0]!.options.clock!;

    renderer.setTrack(queueSource(framesBetween(0, 1_000_000)), CONFIG);
    tick();
    stale.reportAudio(40_000, 0);
    expect(renderer.getClockTimeUs()).toBeUndefined();

    fake.report(0, 0);
    expect(renderer.getClockTimeUs()).toBeCloseTo(0, 0);
  });

  it('counts every time the worklet runs dry, across track changes', async () => {
    const { fake, renderer } = await setup();

    renderer.setTrack(queueSource(framesBetween(0, 80_000)), CONFIG);
    tick();
    fake.report(0, 0);

    // A stall far longer than any jitter ceiling still counts, once.
    at(100_000);
    tick();
    at(3_000_000);
    tick();
    expect(renderer.snapshot.get().context.underruns).toBe(1);

    renderer.setTrack(queueSource(framesBetween(0, 80_000)), CONFIG);
    tick();
    fake.report(0, 3_000_000);
    at(3_100_000);
    tick();
    expect(renderer.snapshot.get().context.underruns).toBe(2);
  });

  it('counts a dry edge that a track change lands on before the next tick', async () => {
    const { fake, renderer } = await setup();

    renderer.setTrack(queueSource(framesBetween(0, 80_000)), CONFIG);
    tick();
    fake.report(0, 0);

    at(100_000);
    renderer.setTrack(queueSource(framesBetween(0, 80_000)), CONFIG);
    expect(renderer.snapshot.get().context.underruns).toBe(1);
  });

  it('refills a frozen re-join placement in one go when packets resume past a gap', async () => {
    let anchorUs: number | undefined;
    const { fake, renderer } = await setup({ getJoinAnchorUs: () => anchorUs });
    const source = queueSource(framesBetween(0, 80_000));

    renderer.setTrack(source, CONFIG);
    tick();
    fake.report(0, 0);

    anchorUs = 4_900_000;
    source.queue.push(frameAt(5_000_000));
    tick();
    at(200_000);
    tick();
    expect(renderer.getClockTimeUs()).toBeCloseTo(5_020_000, 0);

    // Packets resume 80 ms after the lone one ends: past the first fill's
    // horizon, so the refill measures from where they start.
    fake.inputs[0]!.stats.playing = false;
    source.queue.push(...framesBetween(5_100_000, 5_400_000));
    at(400_000);
    tick();
    expect(fake.inputs[0]!.pushed.slice(-4)).toEqual([5_100_000, 5_120_000, 5_140_000, 5_160_000]);
    expect(renderer.getClockTimeUs()).toBeCloseTo(5_020_000, 0);
  });

  it('applies the playout rate to the input and paces the clock with it', async () => {
    let rate = 1;
    const { fake, renderer } = await setup({ getPlaybackRate: () => rate });

    renderer.setTrack(queueSource(framesBetween(0, 2_000_000)), CONFIG);
    tick();
    fake.report(0, 0);

    for (let us = 10_000; us <= 100_000; us += 10_000) {
      at(us);
      tick();
    }

    expect(renderer.getClockTimeUs()).toBeCloseTo(100_000, 0);

    rate = 1.05;
    tick();
    expect(fake.inputs[0]!.playbackRate).toBe(1.05);

    // The time before the change keeps its pace; only what follows speeds up.
    for (let us = 110_000; us <= 200_000; us += 10_000) {
      at(us);
      tick();
    }

    expect(renderer.getClockTimeUs()).toBeCloseTo(205_000, 0);
  });

  it('clamps the playout rate to the range the core accepts, and starts a new input at it', async () => {
    let rate = 3;
    const { fake, renderer } = await setup({ getPlaybackRate: () => rate });

    renderer.setTrack(queueSource(framesBetween(0, 200_000)), CONFIG);
    tick();
    expect(fake.inputs[0]!.playbackRate).toBe(2);

    rate = 0;
    tick();
    expect(fake.inputs[0]!.playbackRate).toBe(0.5);

    renderer.setTrack(queueSource(framesBetween(0, 200_000)), CONFIG);
    tick();
    expect(fake.inputs[1]!.options.playbackRate).toBe(0.5);
    expect(renderer.snapshot.get().context.status).toBe('rendering');
  });

  it('caps the core jitter target at the target latency', async () => {
    const fake = createFakePlayer();
    const renderer = createAudioRendererActor({
      audioContext: fakeAudioContext(),
      createAudioPlayer: () => Promise.resolve(fake.player),
      getTargetLatencyUs: () => 250_000,
      tickIntervalMs: TICK_MS,
    });

    await vi.advanceTimersByTimeAsync(0);
    renderer.setTrack(queueSource(framesBetween(0, 80_000)), CONFIG);
    tick();

    expect(fake.inputs[0]!.options.clock!.targetLatencyUs).toBe(250_000);
  });

  it('defaults to the core on the context baseContext, and fails without one', async () => {
    // The core's first act is loading its worklet onto the context; failing
    // that with a marker shows the default reached the core on this context.
    const workletUnavailable = new Error('worklet unavailable');
    const addModule = vi.fn(() => Promise.reject(workletUnavailable));
    // SAFETY: the core touches only `audioWorklet` before the rejected load.
    const baseContext = { audioWorklet: { addModule } } as unknown as BaseAudioContext;
    const renderer = createAudioRendererActor({ audioContext: { ...fakeAudioContext(), baseContext } });

    await vi.advanceTimersByTimeAsync(0);
    expect(addModule).toHaveBeenCalledTimes(1);
    expect(renderer.snapshot.get().context.error).toBe(workletUnavailable);
    renderer.destroy();

    const bare = createAudioRendererActor({ audioContext: fakeAudioContext() });

    await vi.advanceTimersByTimeAsync(0);
    expect(bare.snapshot.get().context.status).toBe('error');
    bare.destroy();
  });

  it('fails a track with no decoder config, and a player that cannot be created', async () => {
    const { renderer } = await setup();

    renderer.setTrack(queueSource(), null);
    expect(renderer.snapshot.get().context.status).toBe('error');

    const failing = createAudioRendererActor({
      audioContext: fakeAudioContext(),
      createAudioPlayer: () => Promise.reject(new Error('no worklet')),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(failing.snapshot.get().context.status).toBe('error');
    failing.destroy();

    const unconnectable = createFakePlayer();

    unconnectable.player.output.connect = () => {
      throw new Error('cross-context connect');
    };

    const disconnected = createAudioRendererActor({
      audioContext: fakeAudioContext(),
      createAudioPlayer: () => Promise.resolve(unconnectable.player),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(disconnected.snapshot.get().context.status).toBe('error');
    expect(unconnectable.closed).toBe(true);
    disconnected.destroy();
  });
});
