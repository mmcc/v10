/**
 * AudioWorklet renderer actor over the shared audio player core: `@mux/moq-media`'s `createAudioPlayer`, injected as
 * `createAudioPlayer`. Same surface as `createAudioRendererActor`, frames in from the subscriber's jitter buffer and
 * the **master clock** out, so the engine can run either behind one seam.
 *
 * The core decodes with WebCodecs, holds an adaptive jitter buffer in an `AudioWorklet`, and reports the audible
 * timestamp about every 20 ms. **Latency stays v10's.** The renderer meters frames into the core so the worklet holds
 * about its own jitter target, and the rest of the target latency stays in the subscriber's buffer, where `syncLatency`
 * measures and steers it. The core's adaptive target is left alone: under metering its growth only moves depth from one
 * buffer to the other.
 *
 * The clock the core reports into is the renderer's own, not the SDK's `PlayoutClock`, so `getClockTimeUs` keeps the
 * contract the video renderer and `trackPlayoutTime` rely on: `undefined` before any audio, and **held where the
 * worklet ran dry** rather than paced on by wall time — a wall-paced clock steps back when audio resumes, which holds
 * slaved video on its last frame for the whole step.
 *
 * TODO(mmcc/v10#66): apply `getPlaybackRate` once the core has a per-input rate (muxinc/relay-sdks#329). Until then
 * audio ignores the latency controller's nudges, which is why the engine only uses this renderer when a
 * `createAudioPlayer` is configured.
 */
import { createTransitionActor } from '../../../core/actors/create-transition-actor';
import { TIMELINE_DISCONTINUITY_US } from '../../../media/moq/timeline';
import type {
  AudioContextLike,
  AudioFrameSource,
  AudioRendererActor,
  AudioRendererContext,
  AudioRendererStatus,
} from './audio-renderer';

// =============================================================================
// Types
// =============================================================================

/**
 * The part of `@mux/moq-media`'s `PlayoutClock` an audio player input calls. The renderer implements it, so the input
 * reports into the renderer's clock.
 */
export interface AudioPlayerClock {
  /** Caps the input's jitter target: the core keeps it under this less the output delay and 40 ms. */
  readonly targetLatencyUs: number;
  /** The time source reports are measured on, in microseconds. */
  localNow(): number;
  /** The audio with this timestamp is audible at local time `atUs`. */
  reportAudio(timestampUs: number, atUs?: number): void;
  /** The input stopped. */
  stopAudio(): void;
}

/** The part of `@mux/moq-media`'s `AudioInputOptions` the renderer passes. */
export interface AudioPlayerInputOptions {
  clock?: AudioPlayerClock;
  decoderConfig?: AudioDecoderConfig;
  /** A decoder error. The core decodes again from the next frame, with a new decoder. */
  onError?(cause: unknown): void;
}

/** The part of `@mux/moq-media`'s `AudioInputStats` the renderer reads. Durations are microseconds. */
export interface AudioPlayerInputStats {
  /** Whether the worklet is playing, rather than filling to its target. */
  readonly playing: boolean;
  /** Decoded audio the worklet holds. */
  readonly bufferedUs: number;
  /** How much the worklet holds before it plays, at the start and after running dry. */
  readonly jitterTargetUs: number;
}

/** The part of `@mux/moq-media`'s `AudioPlayerInput` the renderer uses: one track. */
export interface AudioPlayerInput {
  /** Decode and hold a frame, in decode order. */
  push(frame: { timestampUs: number; payload: Uint8Array }): void;
  /** Without a range: drop everything held or still decoding. */
  cut(): void;
  readonly stats: AudioPlayerInputStats;
  remove(): void;
}

/** The part of `@mux/moq-media`'s `AudioPlayer` the renderer uses. */
export interface AudioPlayer {
  /** The mix of every input; the renderer connects it to its context's `destination`. */
  readonly output: { connect(destination: AudioNode): void };
  addInput(options?: AudioPlayerInputOptions): AudioPlayerInput;
  /** Remove every input and disconnect the output. */
  close(): void;
}

/**
 * Create the player on the renderer's context. `@mux/moq-media`'s `createAudioPlayer` qualifies once given a real
 * `AudioContext`, which a wrapping context exposes as `baseContext`:
 *
 * ```ts
 * createAudioPlayer: (context) => createAudioPlayer({ context: context.baseContext as AudioContext });
 * ```
 */
export type CreateAudioPlayer = (context: AudioContextLike) => Promise<AudioPlayer>;

export interface CreateWorkletAudioRendererOptions {
  /** Where the player's output connects (`destination`), and the output latencies the clock is placed behind. */
  audioContext: AudioContextLike;
  createAudioPlayer: CreateAudioPlayer;
  /**
   * **Join at the live edge**, as `createAudioRendererActor`'s option of the same name: buffered audio older than this
   * is discarded before the first frame of a (re)start reaches the core.
   */
  getJoinAnchorUs?: () => number | undefined;
  /**
   * The target latency in microseconds, read on every clock report. It caps the core's jitter target, so the worklet
   * never holds more than the latency the controller is aiming at. Default 2 s, where the core's own 400 ms ceiling
   * applies instead.
   */
  getTargetLatencyUs?: () => number | undefined;
  /** Metering cadence in ms. Default 10. */
  tickIntervalMs?: number;
}

type RendererMessage =
  | { type: 'status'; status: AudioRendererStatus; error?: unknown }
  | { type: 'decoder-error'; error: unknown }
  | { type: 'scheduled'; untilUs: number }
  | { type: 'underrun' };

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_TICK_INTERVAL_MS = 10;
const DEFAULT_TARGET_LATENCY_US = 2_000_000;
/** The frame duration assumed before a frame has shown one: Opus's usual 20 ms. */
const DEFAULT_FRAME_DURATION_US = 20_000;
/** Reports and pushed spans may disagree by sample rounding and resampling offsets. */
const REPORT_TOLERANCE_US = 5_000;
/**
 * How long a fill may sit short of playback before one more frame is pushed. The fill pushes exactly the jitter target
 * plus a frame, so audio the core drops on arrival (behind what it already decoded) could otherwise leave it waiting
 * forever.
 */
const FILL_STALL_US = 100_000;
/** See `audio-renderer`'s threshold of the same name: a jump this large, either way, is a new timeline. */
const DISCONTINUITY_THRESHOLD_US = TIMELINE_DISCONTINUITY_US;

/**
 * How long an Opus packet plays, from its TOC byte (RFC 6716 §3.1); `undefined` when it cannot be read. The same rule
 * as `@mux/moq-media`'s `opusPacketDurationUs`.
 */
function opusPacketDurationUs(packet: Uint8Array): number | undefined {
  const toc = packet[0];
  if (toc === undefined) return undefined;

  const config = toc >> 3;
  // SILK: 10, 20, 40, 60 ms; hybrid: 10, 20 ms; CELT: 2.5, 5, 10, 20 ms.
  const frameUs =
    config < 12
      ? [10_000, 20_000, 40_000, 60_000][config % 4]!
      : config < 16
        ? [10_000, 20_000][config % 2]!
        : [2_500, 5_000, 10_000, 20_000][config % 4]!;
  const code = toc & 3;
  if (code === 0) return frameUs;

  if (code !== 3) return 2 * frameUs;

  const count = packet[1];

  return count === undefined ? undefined : (count & 0x3f) * frameUs;
}

export function createWorkletAudioRendererActor(options: CreateWorkletAudioRendererOptions): AudioRendererActor {
  const { audioContext } = options;

  const inner = createTransitionActor<AudioRendererContext, RendererMessage>(
    { status: 'idle', framesScheduled: 0, underruns: 0 },
    (context, message) => {
      switch (message.type) {
        case 'status':
          return { ...context, status: message.status, error: message.error };
        case 'decoder-error':
          return { ...context, error: message.error };
        case 'scheduled':
          return {
            ...context,
            status: 'rendering',
            framesScheduled: context.framesScheduled + 1,
            scheduledUntilUs: message.untilUs,
          };
        case 'underrun':
          return { ...context, underruns: context.underruns + 1 };
      }
    }
  );

  let destroyed = false;
  let player: AudioPlayer | undefined;
  let input: AudioPlayerInput | undefined;
  let source: AudioFrameSource | null = null;
  let decoderConfig: AudioDecoderConfig | null = null;

  /** The schedule has no anchor yet; see `audio-renderer`'s flag of the same name. */
  let needsJoinAnchor = true;
  /** The pending anchor follows a mid-stream discontinuity; see `audio-renderer`'s flag of the same name. */
  let rejoinAnchorArmed = false;

  // What this timeline has pushed into the core. Reset with the timeline.
  let firstPushedUs: number | undefined;
  let lastPushedUs: number | undefined;
  /** Known once a packet's duration or two frames' spacing has shown it. */
  let frameDurationUs: number | undefined;
  /** Where the newest pushed frame ends: the furthest the clock can read. */
  let pushedEndUs: number | undefined;
  /** First timestamp pushed in the current fill, and the context time of the latest push. */
  let fillStartUs: number | undefined;
  let lastPushAtUs = 0;

  /**
   * The clock: timeline position `mediaUs` is audible at context time `contextUs`, advancing with the context clock
   * from there. Set by every core report, or **placed** at a re-join anchor before the core plays anything (see
   * `dropToJoinAnchor`).
   *
   * Context time, not `performance.now()`, because it is what stops when the adapter suspends the context on pause: a
   * wall-paced clock would run on through the pause, read the frozen worklet as dry and refill it, and step back on the
   * first report after resume. The core times its reports on the same source (`localNow`), so its render clock's
   * calibration does not carry a pause into the first reports after it either.
   */
  let anchor: { mediaUs: number; contextUs: number; placed: boolean; frozen?: boolean } | undefined;
  /** Bumped per input, so a report from a removed input cannot anchor its replacement. */
  let inputGeneration = 0;
  /**
   * Where the worklet ran dry. The clock holds there until a report of audio past it arrives: frames pushed to refill
   * the worklet move `pushedEndUs` before they play, and must not drag the clock forward with them.
   */
  let dryLimitUs: number | undefined;
  /**
   * The position the clock held at through the latest underrun, kept as a floor after it ends. The first report of the
   * refill is dated ahead by the output latency — the sample is not audible yet — so its anchor extrapolates to before
   * the hold, and the clock would otherwise step back by that much.
   */
  let holdFloorUs: number | undefined;
  /**
   * The core has reported itself stopped since the dry point was set. Until it has, a report near the dry point is the
   * tail of the audio before it, still in flight, and must not end the hold.
   */
  let stoppedSinceDry = false;

  const outputLatencyUs = (): number =>
    ((audioContext.baseLatency ?? 0) + (audioContext.outputLatency ?? 0)) * 1_000_000;

  const contextNowUs = (): number => audioContext.currentTime * 1_000_000;

  /** The audible position extrapolated from the anchor, ignoring every limit. */
  const extrapolatedUs = (): number | undefined =>
    anchor && (anchor.frozen ? anchor.mediaUs : anchor.mediaUs + (contextNowUs() - anchor.contextUs));

  /** The clock one input reports into; it goes deaf once that input is replaced. */
  const createClock = (): AudioPlayerClock => {
    const generation = ++inputGeneration;

    return {
      get targetLatencyUs() {
        return options.getTargetLatencyUs?.() ?? DEFAULT_TARGET_LATENCY_US;
      },
      localNow: contextNowUs,
      reportAudio(timestampUs, atUs) {
        if (generation !== inputGeneration) return;

        reportAudio(timestampUs, atUs);
      },
      // The renderer resets the clock itself wherever a track or timeline ends.
      stopAudio() {},
    };
  };

  const raiseHoldFloor = (heldUs: number): void => {
    holdFloorUs = Math.max(holdFloorUs ?? heldUs, heldUs);
  };

  /**
   * A placed clock runs from the anchor until the core plays, but never past the audio pushed: a fill that stays short
   * of the jitter target cannot start the worklet, and the clock would otherwise run on through audio not there.
   */
  const placedPositionUs = (): number | undefined => {
    const positionUs = extrapolatedUs();

    return positionUs === undefined || pushedEndUs === undefined ? positionUs : Math.min(positionUs, pushedEndUs);
  };

  /** `timestampUs` is audible at context time `atUs` (default now). */
  const reportAudio = (timestampUs: number, atUs: number | undefined): void => {
    // Only audio pushed on this timeline: a report already in flight when
    // the timeline restarted describes audio the cut dropped.
    if (
      firstPushedUs === undefined ||
      pushedEndUs === undefined ||
      timestampUs < firstPushedUs - REPORT_TOLERANCE_US ||
      timestampUs > pushedEndUs + REPORT_TOLERANCE_US
    ) {
      return;
    }

    // The refill's first report ends the hold. Its floor is what the clock
    // reads at that moment — the audible position, which can still be short
    // of the dry point while the device plays out what it had queued.
    if (
      dryLimitUs !== undefined &&
      ((stoppedSinceDry && timestampUs >= dryLimitUs - REPORT_TOLERANCE_US) ||
        timestampUs > dryLimitUs + REPORT_TOLERANCE_US)
    ) {
      raiseHoldFloor(Math.min(extrapolatedUs() ?? dryLimitUs, dryLimitUs));
      dryLimitUs = undefined;
    }

    // Likewise the first report after a placed re-join, which is dated ahead
    // of the placed clock by the output latency.
    if (anchor?.placed) raiseHoldFloor(placedPositionUs()!);

    anchor = { mediaUs: timestampUs, contextUs: atUs ?? contextNowUs(), placed: false };
  };

  /** Forget everything pushed on the current timeline, and the clock placed on it. */
  const resetTimeline = (): void => {
    firstPushedUs = undefined;
    lastPushedUs = undefined;
    frameDurationUs = undefined;
    pushedEndUs = undefined;
    fillStartUs = undefined;
    anchor = undefined;
    dryLimitUs = undefined;
    holdFloorUs = undefined;
    stoppedSinceDry = false;
  };

  const removeInput = (): void => {
    if (!input) return;

    inputGeneration++;
    input.remove();
    input = undefined;
  };

  /**
   * Discard buffered audio older than the join anchor before the first push of a (re)start, so playout starts at the
   * live edge rather than at the oldest group the relay replayed. Mirrors `audio-renderer`'s function of the same name,
   * including landing a re-join anchor by **placement** when the whole buffer is already past it: the clock is placed
   * at the anchor and runs from there, and metering by timeline holds the head back until it is due, so playout resumes
   * at the target depth rather than at the live edge.
   */
  const dropToJoinAnchor = (): void => {
    const anchorUs = options.getJoinAnchorUs?.();
    if (anchorUs === undefined || !source) return;

    let dropped = 0;

    for (let next = source.peek(); next && next.timestampUs < anchorUs; next = source.peek()) {
      source.dequeue();
      dropped++;
    }

    if (dropped > 0) {
      needsJoinAnchor = false;
      rejoinAnchorArmed = false;
      return;
    }

    // A fresh join stays armed: a relay's group replay arrives as a burst,
    // oldest first, so the buffer's live edge may still be moving.
    if (!rejoinAnchorArmed || !source.peek()) return;

    anchor = { mediaUs: anchorUs, contextUs: contextNowUs(), placed: true };
    rejoinAnchorArmed = false;
    needsJoinAnchor = false;
  };

  /**
   * Whether `timestampUs` should reach the core now. Filling — before the first report, or after running dry — pushes
   * the jitter target plus a frame, which is what the worklet waits for before playing. Playing pushes what will be
   * rendered within the jitter target, so the worklet holds about that much and the rest waits in the subscriber.
   */
  const isDue = (timestampUs: number, stats: AudioPlayerInputStats): boolean => {
    const positionUs = anchor?.placed ? placedPositionUs() : extrapolatedUs();

    // A frozen placement is a fill too: its clock waits for the worklet to
    // start, so only the fill rules (including the stall rescue) can move it.
    if (positionUs === undefined || dryLimitUs !== undefined || anchor?.frozen) {
      if (
        fillStartUs === undefined ||
        timestampUs < fillStartUs + stats.jitterTargetUs + (frameDurationUs ?? DEFAULT_FRAME_DURATION_US)
      ) {
        return true;
      }

      return contextNowUs() - lastPushAtUs > FILL_STALL_US && stats.bufferedUs < stats.jitterTargetUs;
    }

    return timestampUs < positionUs + outputLatencyUs() + stats.jitterTargetUs;
  };

  const push = (active: AudioPlayerInput, timestampUs: number, payload: Uint8Array): void => {
    active.push({ timestampUs, payload });

    // Opus says how long each packet is. Otherwise the shortest step between
    // pushed frames is the frame length: a step over lost packets is longer,
    // and must not extend the audio past where it really ends.
    const opusUs = decoderConfig?.codec === 'opus' ? opusPacketDurationUs(payload) : undefined;
    const stepUs = lastPushedUs === undefined ? undefined : timestampUs - lastPushedUs;

    if (opusUs !== undefined) frameDurationUs = opusUs;
    else if (stepUs !== undefined && stepUs > 0) frameDurationUs = Math.min(frameDurationUs ?? stepUs, stepUs);

    firstPushedUs ??= timestampUs;
    fillStartUs ??= timestampUs;
    lastPushedUs = timestampUs;
    lastPushAtUs = contextNowUs();
    pushedEndUs = timestampUs + (frameDurationUs ?? DEFAULT_FRAME_DURATION_US);
    inner.send({ type: 'scheduled', untilUs: pushedEndUs });
  };

  /**
   * The worklet runs dry once rendering passes everything pushed: metering pushes every frame as soon as it is due, so
   * nothing was left to push. Each such edge is an underrun, as `audio-renderer` counts them. The core's own counter
   * skips dry spells longer than its jitter ceiling, which `adaptLatencyTarget` still needs as failure evidence.
   */
  const detectDry = (): void => {
    const positionUs = extrapolatedUs();

    if (
      !anchor ||
      anchor.placed ||
      dryLimitUs !== undefined ||
      pushedEndUs === undefined ||
      positionUs === undefined ||
      positionUs + outputLatencyUs() < pushedEndUs
    ) {
      return;
    }

    dryLimitUs = pushedEndUs;
    stoppedSinceDry = false;
    fillStartUs = undefined;
    inner.send({ type: 'underrun' });
  };

  const tick = (): void => {
    if (destroyed || !player || !source || !decoderConfig) return;

    try {
      const active = (input ??= player.addInput({
        clock: createClock(),
        decoderConfig,
        onError: (error) => inner.send({ type: 'decoder-error', error }),
      }));
      const { stats } = active;

      detectDry();

      const positionUs = extrapolatedUs();

      if (dryLimitUs !== undefined && !stats.playing) stoppedSinceDry = true;

      // A placed clock that reaches the end of the audio pushed stops there
      // until the core plays, so refill frames cannot drag it forward.
      if (anchor?.placed && !anchor.frozen && pushedEndUs !== undefined && positionUs! >= pushedEndUs) {
        anchor = { mediaUs: pushedEndUs, contextUs: contextNowUs(), placed: true, frozen: true };
      }

      for (;;) {
        if (needsJoinAnchor && lastPushedUs === undefined) dropToJoinAnchor();

        const next = source.peek();
        if (!next) return;

        // A timeline reset, either way: drop what the core holds and re-place
        // the anchor on the jumped-to timeline (see `audio-renderer`).
        if (lastPushedUs !== undefined && Math.abs(next.timestampUs - lastPushedUs) > DISCONTINUITY_THRESHOLD_US) {
          active.cut();
          resetTimeline();
          needsJoinAnchor = true;
          rejoinAnchorArmed = true;
          continue;
        }

        if (!isDue(next.timestampUs, stats)) return;

        push(active, next.timestampUs, next.payload);
        source.dequeue();
      }
    } catch (error) {
      inner.send({ type: 'status', status: 'error', error });
    }
  };
  const timer = setInterval(tick, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

  options.createAudioPlayer(audioContext).then(
    (created) => {
      if (destroyed) {
        created.close();
        return;
      }

      try {
        created.output.connect(audioContext.destination);
        player = created;
      } catch (error) {
        created.close();
        inner.send({ type: 'status', status: 'error', error });
      }
    },
    (error) => {
      if (!destroyed) inner.send({ type: 'status', status: 'error', error });
    }
  );

  return {
    get snapshot() {
      return inner.snapshot;
    },

    setTrack(nextSource, nextConfig): void {
      // See `audio-renderer`: a source with no config could never play.
      const missingConfig = nextSource !== null && nextConfig === null;

      source = missingConfig ? null : nextSource;
      decoderConfig = nextConfig;
      needsJoinAnchor = true;
      rejoinAnchorArmed = false;
      // An edge since the last tick still counts: the reset below forgets it.
      detectDry();
      removeInput();
      resetTimeline();

      if (missingConfig) {
        inner.send({
          type: 'status',
          status: 'error',
          error: new Error('audio renderer track has no decoder config'),
        });
        return;
      }

      inner.send({ type: 'status', status: source ? 'rendering' : 'idle' });
    },

    getClockTimeUs(): number | undefined {
      const positionUs = extrapolatedUs();
      if (positionUs === undefined) return undefined;

      if (anchor?.placed) return placedPositionUs();

      // Never past the audio pushed, and once the worklet ran dry never past
      // where it did: the clock holds through an underrun and resumes when
      // audio does, as the source-node renderer's clamped segments did.
      const limitUs = dryLimitUs ?? pushedEndUs;
      const clampedUs = limitUs === undefined ? positionUs : Math.min(positionUs, limitUs);

      if (holdFloorUs === undefined) return clampedUs;

      if (clampedUs < holdFloorUs) return holdFloorUs;

      holdFloorUs = undefined;
      return clampedUs;
    },

    destroy(): void {
      if (destroyed) return;

      destroyed = true;
      clearInterval(timer);
      removeInput();
      player?.close();
      player = undefined;
      inner.destroy();
    },
  };
}
