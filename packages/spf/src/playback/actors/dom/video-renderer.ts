/**
 * VideoDecoder → canvas renderer actor.
 *
 * Pulls LOC frames from a frame source (the track-subscriber jitter
 * buffer), decodes ahead of the playout clock, and presents decoded
 * `VideoFrame`s against the **master clock** by timestamp with a
 * hold-early / drop-late policy. Presentation runs on
 * `requestAnimationFrame` (vsync-aligned) when available, falling back to
 * the decode interval; decode always runs on the interval so the jitter
 * buffer keeps draining while rAF is throttled (hidden tab). Not
 * `requestVideoFrameCallback`: rVFC only exists on `HTMLVideoElement`,
 * and there is none here.
 *
 * The clock is injected (`getClockTimeUs`): the audio renderer owns the
 * master clock when audio plays; without one the renderer self-clocks —
 * anchored on its first decoded frame or on `getTargetClockUs()` (the
 * delivery edge), advancing by wall time × `getPlaybackRate()`, and
 * **continuously slewed back onto the edge**. Either way the backlog
 * behind the anchor is decoded in order and dropped late, so joining at
 * the edge fast-forwards through it instead of skipping its keyframe.
 *
 * Track switches are keyframe-gated: `setTrack` swaps the frame source and
 * decoder config, and decode resumes only from the next keyframe-led
 * frame (make-before-break handoffs guarantee one is already buffered).
 */
import { createTransitionActor, type TransitionActor } from '../../../core/actors/create-transition-actor';
import type { JitterFrame } from '../track-subscriber';

// =============================================================================
// Types
// =============================================================================

/** Pull seam onto a jitter buffer — `TrackSubscriberActor` satisfies this. */
export interface VideoFrameSource {
  peek(): JitterFrame | undefined;
  dequeue(): JitterFrame | undefined;
}

export type VideoRendererStatus = 'idle' | 'waiting-keyframe' | 'rendering' | 'error';

export interface VideoRendererContext {
  status: VideoRendererStatus;
  framesDecoded: number;
  /** Frames discarded for arriving behind the clock (drop-late). */
  framesDropped: number;
  /**
   * Timestamp of the last frame presented **from the current track**, and
   * `undefined` before this renderer has presented one. Cleared by `setTrack`
   * — see the reducer — because it is read as a playout position and not as a
   * historical high-water mark.
   */
  lastPresentedTimestampUs?: number;
  error?: unknown;
}

export interface VideoRendererConfig {
  /** Frames decoded ahead of presentation. Default 8. */
  decodeAhead?: number;
  /** Presentation-loop cadence in ms. Default 8 (~120Hz sampling). */
  tickIntervalMs?: number;
  /**
   * Fraction of real time the self-clock may spend correcting itself onto
   * `getTargetClockUs()`. Default 0.05 → at most 50ms of correction per
   * second. Staying well below the playout rate is what keeps the clock
   * monotonically forward while it is being pulled backwards, so a supplied
   * value is clamped into `[0, 0.9]` and a non-finite one takes the default.
   */
  clockSlewRate?: number;
  /** Edge-tracking error tolerated before the self-clock slews. Default 50_000µs. */
  clockSlewToleranceUs?: number;
}

export interface CreateVideoRendererOptions extends VideoRendererConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Master playout clock in media microseconds; `undefined` → self-clock. */
  getClockTimeUs?: () => number | undefined;
  /** Playout rate for the self-clock (latency nudges). Default 1. */
  getPlaybackRate?: () => number;
  /**
   * **Where the self-clock should be right now**: the delivery edge, one
   * target latency back. Consulted on *every* clock read, not only at
   * join — the self-clock anchors on it, then slews back onto it (bounded
   * by `clockSlewRate`) for as long as it self-clocks. Frames behind the
   * anchor are still decoded in order from their keyframe and then dropped
   * late, so a backlog fast-forwards rather than replaying. Ignored while a
   * master clock is supplied: that clock carries the anchor itself.
   */
  getTargetClockUs?: () => number | undefined;
}

type RendererMessage =
  | { type: 'status'; status: VideoRendererStatus; error?: unknown }
  /** `status`, plus the end of the presented position — only `setTrack` sends it. */
  | { type: 'track'; status: VideoRendererStatus; error?: unknown }
  | { type: 'decoded' }
  | { type: 'presented'; timestampUs: number; dropped: number };

export interface VideoRendererActor extends Pick<TransitionActor<VideoRendererContext, RendererMessage>, 'snapshot'> {
  /**
   * Point the renderer at a (new) frame source. Decode restarts at the
   * next keyframe with the given decoder config. `null` source stops
   * rendering (status `'idle'`).
   *
   * `lastPresentedTimestampUs` clears with it: it is the published playout
   * position, and the frame it named belonged to the departed track. The
   * cumulative counters do not.
   */
  setTrack(source: VideoFrameSource | null, config: VideoDecoderConfig | null): void;
  /**
   * Current playout clock in media microseconds — the injected master
   * clock when there is one, otherwise the self-clock; `undefined` before
   * either has a value. Reading it is side-effect-free from the caller's
   * point of view: the self-clock's slew is budgeted per unit of *real*
   * time, so extra reads split the same correction into smaller steps
   * rather than applying it more often.
   */
  getClockTimeUs(): number | undefined;
  destroy(): void;
}

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_DECODE_AHEAD = 8;
const DEFAULT_TICK_INTERVAL_MS = 8;
/**
 * Media-time jump beyond which buffered frames are a timeline reset
 * (latency catch-up skipped groups) rather than frames the self-clock
 * should wait out in real time.
 */
const DISCONTINUITY_THRESHOLD_US = 1_000_000;
const DEFAULT_CLOCK_SLEW_RATE = 0.05;
const DEFAULT_CLOCK_SLEW_TOLERANCE_US = 50_000;
/**
 * Upper bound on `clockSlewRate`. The slew subtracts up to `slewRate` of
 * real time from a clock advancing at `getPlaybackRate()` of it, so the
 * clock only stays monotonically forward while the rate is below the
 * slowest playout rate it will ever be read at. 0.9 leaves headroom under
 * the latency controller's `1 - rateNudge` (0.95 by default) — the one
 * property the bounded slew exists to guarantee.
 */
const MAX_CLOCK_SLEW_RATE = 0.9;

/**
 * Clamped rather than validated, and a broken value takes the default
 * rather than 0: this actor is handed a slew rate from a latency config
 * several layers up, and the failures are the class nothing reports. At or
 * above 1 the correction outruns playback and the clock stalls or walks
 * backwards; negative inverts the correction's sign, so the clock is driven
 * *away* from the edge and re-anchored there on every read, diverging
 * without bound; `NaN` poisons the anchor permanently. A slower correction
 * is a worse clock, but a stalled, diverging or frozen one is not a clock.
 */
function resolveClockSlewRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate)) return DEFAULT_CLOCK_SLEW_RATE;
  return Math.min(Math.max(rate, 0), MAX_CLOCK_SLEW_RATE);
}

export function createVideoRendererActor(options: CreateVideoRendererOptions): VideoRendererActor {
  const decodeAhead = options.decodeAhead ?? DEFAULT_DECODE_AHEAD;
  const slewRate = resolveClockSlewRate(options.clockSlewRate);
  const slewToleranceUs = options.clockSlewToleranceUs ?? DEFAULT_CLOCK_SLEW_TOLERANCE_US;
  const context2d = options.canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;

  const inner = createTransitionActor<VideoRendererContext, RendererMessage>(
    { status: 'idle', framesDecoded: 0, framesDropped: 0 },
    (context, message) => {
      switch (message.type) {
        case 'status':
          return { ...context, status: message.status, error: message.error };
        case 'track':
          // **A track change ends the presented position.** Everything else
          // `setTrack` resets is internal — the decoder, the decoded queue,
          // the keyframe gate, the self-clock anchor — and this is the one
          // piece of the same state that is published, so leaving it standing
          // publishes the departed track's last frame as this renderer's
          // position for as long as the replacement takes to present one.
          //
          // That is not a short window on the path that matters. With no audio
          // scheduled, `trackPlayoutTime` publishes this field as the engine's
          // `currentTime` and names video as the playout clock owner, and
          // `syncLatency` measures the controlled track's delivery edge
          // against that position: a rejoin (a pause outliving its hold
          // window, an autoplay unlock) re-subscribes at the next group start,
          // so nothing presents until a whole group has arrived, while the
          // frozen position charges every millisecond of the suspension to the
          // track that is filling. The reading crosses `catchUpThreshold` and
          // skips the group the replacement has only just buffered.
          //
          // Cleared rather than epoched because absence is already the
          // vocabulary the readers speak: `getClockTimeUs()` goes undefined
          // across the same reset (the self-clock anchor is dropped with the
          // decoded queue), and `trackPlayoutTime` reads an absent position as
          // "no owner", which is what stands the controller down. The
          // *engine's* `currentTime` still holds its last value — that is
          // decided there, where the media-element facade and the handoff
          // promotion gate also read it.
          //
          // `framesDecoded` and `framesDropped` are deliberately kept. They
          // are cumulative quality cost for the session, which is how
          // `trackPlayoutHealth` publishes them and how `adaptLatencyTarget`
          // reads them; a per-track reset would make dropped frames go
          // backwards and read as an improvement.
          return { ...context, status: message.status, error: message.error, lastPresentedTimestampUs: undefined };
        case 'decoded':
          return { ...context, framesDecoded: context.framesDecoded + 1 };
        case 'presented':
          return {
            ...context,
            status: 'rendering',
            lastPresentedTimestampUs: message.timestampUs,
            framesDropped: context.framesDropped + message.dropped,
          };
      }
    }
  );

  let source: VideoFrameSource | null = null;
  let decoderConfig: VideoDecoderConfig | null = null;
  let decoder: VideoDecoder | null = null;
  let awaitingKeyframe = true;
  let destroyed = false;
  /** Last per-keyframe LOC Video Config applied as the decoder `description`. */
  let appliedDescription: Uint8Array | null = null;

  /** Decoded frames awaiting presentation, in timestamp order. */
  const decoded: VideoFrame[] = [];

  // Self-clock anchor (used only without a master clock). Rate is folded
  // into the anchor whenever it changes so nudges apply forward-only, and
  // every edge-tracking slew re-anchors at the corrected value.
  let selfAnchor: { timestampUs: number; wallMs: number; rate: number } | null = null;
  /**
   * Wall time of the last edge-tracking evaluation. Separate from
   * `selfAnchor.wallMs` (which only moves when the anchor is rewritten) so
   * the slew budget accrues over the interval actually elapsed since the
   * last correction *opportunity* — otherwise a long stretch inside the
   * tolerance band banks budget and the next correction lands as a jump.
   */
  let lastSlewWallMs: number | null = null;

  const closeDecoder = (): void => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    for (const frame of decoded) frame.close();
    decoded.length = 0;
  };

  const handleDecoded = (frame: VideoFrame): void => {
    if (destroyed) {
      frame.close();
      return;
    }
    // Outputs arrive in presentation order for LOC (no B-frame reorder in
    // the containers this targets); insert defensively anyway.
    let index = decoded.length;
    while (index > 0 && decoded[index - 1]!.timestamp > frame.timestamp) index--;
    decoded.splice(index, 0, frame);
    inner.send({ type: 'decoded' });
  };

  const ensureDecoder = (): VideoDecoder | null => {
    if (decoder || !decoderConfig) return decoder;
    decoder = new VideoDecoder({
      output: handleDecoded,
      error: (error) => inner.send({ type: 'status', status: 'error', error }),
    });
    decoder.configure(decoderConfig);
    return decoder;
  };

  const sameDescriptionBytes = (bytes: Uint8Array): boolean => {
    if (appliedDescription === null || appliedDescription.byteLength !== bytes.byteLength) return false;
    for (let i = 0; i < bytes.byteLength; i++) {
      if (appliedDescription[i] !== bytes[i]) return false;
    }
    return true;
  };

  const pullAndDecode = (): void => {
    // After a decoder error there is nothing productive to pull into —
    // draining would silently strip the jitter buffer at tick rate.
    if (!source || inner.snapshot.get().context.status === 'error') return;
    while (true) {
      const queued = (decoder?.decodeQueueSize ?? 0) + decoded.length;
      if (queued >= decodeAhead) return;
      const next = source.peek();
      if (!next) return;

      if (awaitingKeyframe && !next.isKey) {
        source.dequeue();
        continue;
      }

      // LOC tracks may ship parameter sets per keyframe (Video Config
      // property) instead of via catalog initData — apply them as the
      // decoder `description` before this keyframe decodes. Publishers
      // typically repeat the config on every keyframe, so byte-compare
      // against the last applied bytes to avoid reconfigure churn.
      if (next.isKey && next.videoConfig && decoderConfig && !sameDescriptionBytes(next.videoConfig)) {
        closeDecoder();
        decoderConfig = { ...decoderConfig, description: next.videoConfig };
        appliedDescription = next.videoConfig;
      }

      const active = ensureDecoder();
      // An errored decoder is closed but still referenced — stop pulling
      // instead of feeding it doomed decode calls.
      if (!active || active.state === 'closed') return;
      // Decode before dequeue: if decode throws, the frame stays buffered
      // for a later decoder instead of being silently dropped.
      active.decode(
        new EncodedVideoChunk({
          type: next.isKey ? 'key' : 'delta',
          timestamp: next.timestampUs,
          data: next.payload,
        })
      );
      source.dequeue();
      awaitingKeyframe = false;
    }
  };

  /**
   * Where the self-clock should start from `fallbackUs`: the target clock
   * when it sits ahead (the delivery edge is further on than this frame),
   * the frame itself otherwise. Never moves the clock backwards — a buffer
   * shallower than the target latency is already at the edge.
   */
  const anchorTimestampUs = (fallbackUs: number): number => {
    const targetUs = options.getTargetClockUs?.();
    return targetUs !== undefined && targetUs > fallbackUs ? targetUs : fallbackUs;
  };

  const selfClockAt = (wallMs: number): number =>
    selfAnchor!.timestampUs + (wallMs - selfAnchor!.wallMs) * 1000 * selfAnchor!.rate;

  /**
   * **Track the delivery edge.** A self-clock anchored once and extrapolated
   * from `performance.now()` forever cannot stay right: publisher clock and
   * consumer clock drift, an anchor placed mid join-burst is placed against
   * an edge that had not finished arriving, and every hold (pause, rate 0)
   * ratchets the offset up permanently. So the clock re-reads
   * `getTargetClockUs()` — the live edge, one target latency back — on every
   * read and steers back onto it.
   *
   * The correction is a slew, not a jump: at most `slewRate` × the real time
   * elapsed since the last evaluation, and only outside a
   * `slewToleranceUs` band (the edge advances in frame-sized steps, so a
   * tighter band would chase quantization noise). That bound is what makes
   * this safe rather than merely correct — with `slewRate` < 1 the clock
   * stays monotonically forward even while being pulled backwards, and a
   * mis-placed join anchor self-corrects invisibly instead of being held
   * for the life of the stream.
   *
   * **Versus the latency controller's rate nudge** (`syncLatency`, ±5%,
   * which reaches this clock through `getPlaybackRate`): both are negative
   * feedback on the *same* error — the controller measures edge-to-playout
   * against the same resolved target this reads — so they always pull the
   * same direction and cannot fight. They divide by scale: the slew works
   * continuously and owns fine error, including inside the controller's
   * deadband where nothing has engaged the controller; the controller owns
   * error coarse enough to leave the deadband, and holds its correction
   * back down to its own reclaim band rather than to the deadband edge —
   * so both are active over part of the deadband, in the same direction.
   * They compound to at most `slewRate + rateNudge` of real time, still
   * bounded and still sub-perceptual on a video-only self-clock. Error
   * beyond `DISCONTINUITY_THRESHOLD_US` is neither's job — that is a
   * timeline reset and takes the hard re-anchor below.
   */
  const slewTowardEdge = (clock: number, nowMs: number, rate: number): number => {
    const elapsedMs = lastSlewWallMs === null ? 0 : Math.max(0, nowMs - lastSlewWallMs);
    lastSlewWallMs = nowMs;
    // Rate 0 is a hold (pause): correcting onto a still-advancing edge
    // would walk the clock forward through the pause.
    if (rate === 0 || elapsedMs === 0) return clock;
    const targetUs = options.getTargetClockUs?.();
    if (targetUs === undefined) return clock;
    const errorUs = targetUs - clock;
    if (Math.abs(errorUs) <= slewToleranceUs) return clock;
    const budgetUs = elapsedMs * 1000 * slewRate;
    const corrected = clock + Math.sign(errorUs) * Math.min(Math.abs(errorUs), budgetUs);
    selfAnchor = { timestampUs: corrected, wallMs: nowMs, rate };
    return corrected;
  };

  const clockTimeUs = (): number | undefined => {
    const master = options.getClockTimeUs?.();
    if (master !== undefined) {
      // Bank no slew budget while the master clock owns presentation: if it
      // later goes away (audio ends mid-stream), the first self-clock
      // evaluation would otherwise cash in the whole master-clock interval
      // as one correction.
      lastSlewWallMs = null;
      return master;
    }
    const rate = options.getPlaybackRate?.() ?? 1;
    const now = performance.now();
    if (!selfAnchor) {
      const first = decoded[0];
      if (!first) return undefined;
      selfAnchor = { timestampUs: anchorTimestampUs(first.timestamp), wallMs: now, rate };
      lastSlewWallMs = now;
    } else if (rate !== selfAnchor.rate) {
      // Re-anchor at the current clock value: the new rate scales time
      // from now on, not the whole interval since the original anchor.
      selfAnchor = { timestampUs: selfClockAt(now), wallMs: now, rate };
    }
    const clock = slewTowardEdge(selfClockAt(now), now, rate);
    // A frame far ahead of the clock is a timeline reset (latency catch-up
    // skipped groups) — waiting the jump out in real time would freeze
    // presentation, and it is far past what the bounded slew above can
    // reclaim. Re-anchor at the jumped-to frame instead.
    // While paused (rate 0) the clock holds — a re-anchor onto newly
    // arriving live frames would present them mid-pause.
    const next = decoded[0];
    if (rate !== 0 && next && next.timestamp - clock > DISCONTINUITY_THRESHOLD_US) {
      // The catch-up skip that produced the jump landed on a group start,
      // still up to one GOP behind the live edge — re-place the anchor.
      const timestampUs = anchorTimestampUs(next.timestamp);
      selfAnchor = { timestampUs, wallMs: now, rate };
      return timestampUs;
    }
    return clock;
  };

  const present = (): void => {
    // Read the clock even with nothing to present: rate changes fold into
    // the self-clock anchor inside `clockTimeUs`, and a pause (rate → 0)
    // that lands while the decoded queue is empty must freeze the anchor
    // now — not when the next frame decodes, after the clock has silently
    // advanced through the pause.
    const clock = clockTimeUs();
    if (clock === undefined || decoded.length === 0) return;

    // Everything at/behind the clock is due: present the newest due frame,
    // drop the rest (drop-late). Frames ahead of the clock hold.
    let dueCount = 0;
    while (dueCount < decoded.length && decoded[dueCount]!.timestamp <= clock) dueCount++;
    if (dueCount === 0) return;

    const frame = decoded[dueCount - 1]!;
    const dropped = decoded.splice(0, dueCount);
    dropped.pop();
    for (const stale of dropped) stale.close();

    if (context2d) {
      const width = frame.displayWidth || frame.codedWidth;
      const height = frame.displayHeight || frame.codedHeight;
      if (options.canvas.width !== width) options.canvas.width = width;
      if (options.canvas.height !== height) options.canvas.height = height;
      context2d.drawImage(frame, 0, 0, width, height);
    }
    const timestampUs = frame.timestamp;
    frame.close();
    inner.send({ type: 'presented', timestampUs, dropped: dropped.length });
  };

  const supportsRaf = typeof requestAnimationFrame === 'function';
  let rafHandle: number | undefined;

  const tick = (): void => {
    if (destroyed) return;
    try {
      pullAndDecode();
      if (!supportsRaf) present();
    } catch (error) {
      inner.send({ type: 'status', status: 'error', error });
    }
  };
  const timer = setInterval(tick, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

  if (supportsRaf) {
    const presentFrame = (): void => {
      if (destroyed) return;
      try {
        present();
      } catch (error) {
        inner.send({ type: 'status', status: 'error', error });
      }
      rafHandle = requestAnimationFrame(presentFrame);
    };
    rafHandle = requestAnimationFrame(presentFrame);
  }

  return {
    get snapshot() {
      return inner.snapshot;
    },

    getClockTimeUs(): number | undefined {
      return clockTimeUs();
    },

    setTrack(nextSource, nextConfig): void {
      // A source without a decodable config can never leave
      // 'waiting-keyframe' — it would retry every tick while the
      // subscriber's jitter buffer grows unbounded. Fail fast instead.
      const missingConfig = nextSource !== null && nextConfig === null;
      source = missingConfig ? null : nextSource;
      decoderConfig = nextConfig;
      awaitingKeyframe = true;
      selfAnchor = null;
      lastSlewWallMs = null;
      appliedDescription = null;
      closeDecoder();
      // `'track'` rather than `'status'`: it also ends the published playout
      // position, which belonged to the track being replaced.
      if (missingConfig) {
        inner.send({
          type: 'track',
          status: 'error',
          error: new Error('video renderer track has no decoder config'),
        });
        return;
      }
      inner.send({ type: 'track', status: source ? 'waiting-keyframe' : 'idle' });
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      if (rafHandle !== undefined) cancelAnimationFrame(rafHandle);
      closeDecoder();
      inner.destroy();
    },
  };
}
