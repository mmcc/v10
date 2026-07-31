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
 * master clock when audio plays; without one the renderer self-anchors to
 * its first decoded frame — or to `getJoinAnchorUs()`, the live edge —
 * and advances by wall time × `getPlaybackRate()`. Either way the backlog
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
  lastPresentedTimestampUs?: number;
  error?: unknown;
}

export interface VideoRendererConfig {
  /** Frames decoded ahead of presentation. Default 8. */
  decodeAhead?: number;
  /** Presentation-loop cadence in ms. Default 8 (~120Hz sampling). */
  tickIntervalMs?: number;
}

export interface CreateVideoRendererOptions extends VideoRendererConfig {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Master playout clock in media microseconds; `undefined` → self-clock. */
  getClockTimeUs?: () => number | undefined;
  /** Playout rate for the self-clock (latency nudges). Default 1. */
  getPlaybackRate?: () => number;
  /**
   * **Join at the live edge.** Media timestamp the *self-clock* should
   * anchor at instead of the frame it would otherwise anchor on — at join,
   * and again across a catch-up discontinuity. Frames behind it are still
   * decoded in order from their keyframe and then dropped late, so the
   * backlog fast-forwards rather than replaying. Ignored while a master
   * clock is supplied: that clock already carries the anchor.
   */
  getJoinAnchorUs?: () => number | undefined;
}

type RendererMessage =
  | { type: 'status'; status: VideoRendererStatus; error?: unknown }
  | { type: 'decoded' }
  | { type: 'presented'; timestampUs: number; dropped: number };

export interface VideoRendererActor extends Pick<TransitionActor<VideoRendererContext, RendererMessage>, 'snapshot'> {
  /**
   * Point the renderer at a (new) frame source. Decode restarts at the
   * next keyframe with the given decoder config. `null` source stops
   * rendering (status `'idle'`).
   */
  setTrack(source: VideoFrameSource | null, config: VideoDecoderConfig | null): void;
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

export function createVideoRendererActor(options: CreateVideoRendererOptions): VideoRendererActor {
  const decodeAhead = options.decodeAhead ?? DEFAULT_DECODE_AHEAD;
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
  // into the anchor whenever it changes so nudges apply forward-only.
  let selfAnchor: { timestampUs: number; wallMs: number; rate: number } | null = null;

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
   * Where the self-clock should start from `fallbackUs`: the join anchor
   * when it sits ahead (the live edge is further on than this frame), the
   * frame itself otherwise. Never moves the clock backwards — a buffer
   * shallower than the target latency is already at the edge.
   */
  const anchorTimestampUs = (fallbackUs: number): number => {
    const joinUs = options.getJoinAnchorUs?.();
    return joinUs !== undefined && joinUs > fallbackUs ? joinUs : fallbackUs;
  };

  const clockTimeUs = (): number | undefined => {
    const master = options.getClockTimeUs?.();
    if (master !== undefined) return master;
    const rate = options.getPlaybackRate?.() ?? 1;
    if (!selfAnchor) {
      const first = decoded[0];
      if (!first) return undefined;
      selfAnchor = { timestampUs: anchorTimestampUs(first.timestamp), wallMs: performance.now(), rate };
    } else if (rate !== selfAnchor.rate) {
      // Re-anchor at the current clock value: the new rate scales time
      // from now on, not the whole interval since the original anchor.
      const now = performance.now();
      selfAnchor = {
        timestampUs: selfAnchor.timestampUs + (now - selfAnchor.wallMs) * 1000 * selfAnchor.rate,
        wallMs: now,
        rate,
      };
    }
    const clock = selfAnchor.timestampUs + (performance.now() - selfAnchor.wallMs) * 1000 * selfAnchor.rate;
    // A frame far ahead of the clock is a timeline reset (latency catch-up
    // skipped groups) — waiting the jump out in real time would freeze
    // presentation. Re-anchor at the jumped-to frame instead.
    // While paused (rate 0) the clock holds — a re-anchor onto newly
    // arriving live frames would present them mid-pause.
    const next = decoded[0];
    if (rate !== 0 && next && next.timestamp - clock > DISCONTINUITY_THRESHOLD_US) {
      // The catch-up skip that produced the jump landed on a group start,
      // still up to one GOP behind the live edge — re-place the anchor.
      const timestampUs = anchorTimestampUs(next.timestamp);
      selfAnchor = { timestampUs, wallMs: performance.now(), rate };
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

    setTrack(nextSource, nextConfig): void {
      // A source without a decodable config can never leave
      // 'waiting-keyframe' — it would retry every tick while the
      // subscriber's jitter buffer grows unbounded. Fail fast instead.
      const missingConfig = nextSource !== null && nextConfig === null;
      source = missingConfig ? null : nextSource;
      decoderConfig = nextConfig;
      awaitingKeyframe = true;
      selfAnchor = null;
      appliedDescription = null;
      closeDecoder();
      if (missingConfig) {
        inner.send({
          type: 'status',
          status: 'error',
          error: new Error('video renderer track has no decoder config'),
        });
        return;
      }
      inner.send({ type: 'status', status: source ? 'waiting-keyframe' : 'idle' });
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
