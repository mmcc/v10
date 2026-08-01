/**
 * AudioDecoder → Web Audio renderer actor. **Owns the master clock**: once
 * audio is scheduled, `getClockTimeUs()` maps the AudioContext's hardware
 * clock back to media time, and the video renderer (and `currentTime`
 * derivation) follow it.
 *
 * Decoded `AudioData` is copied into `AudioBuffer`s and scheduled
 * gaplessly with `AudioBufferSourceNode`s. Each scheduled buffer records a
 * clock segment (context-time span ↔ media time × rate), and the clock
 * reads the segment containing `currentTime` — so it reports what was
 * *actually* scheduled: late arrivals and rate nudges shift the timeline
 * forward from where they happen instead of rescaling elapsed time.
 * Rate nudges from the latency controller apply as `playbackRate` on the
 * scheduled sources (a ±5% nudge is a barely audible pitch shift).
 *
 * Where the schedule *starts* is `getJoinAnchorUs`: with one supplied the
 * clock anchors at the live edge and the buffered backlog is discarded,
 * instead of anchoring at the oldest replayed group and playing all of it.
 *
 * TODO(audio-worklet): replace source-node scheduling with an
 * AudioWorklet ring buffer for tighter jitter control and clean rate
 * adjustment; the actor surface (frame source in, master clock out) is
 * designed so that swap is internal.
 */
import { createTransitionActor, type TransitionActor } from '../../../core/actors/create-transition-actor';
import type { JitterFrame } from '../track-subscriber';

// =============================================================================
// Types
// =============================================================================

/** Pull seam onto a jitter buffer — `TrackSubscriberActor` satisfies this. */
export interface AudioFrameSource {
  peek(): JitterFrame | undefined;
  dequeue(): JitterFrame | undefined;
}

/**
 * Structural subset of `AudioContext`/`BaseAudioContext` the renderer
 * uses. Injected as an interface so unit tests can drive the clock
 * deterministically without a live audio device.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
  createBufferSource(): AudioBufferSourceNode;
}

export type AudioRendererStatus = 'idle' | 'rendering' | 'error';

export interface AudioRendererContext {
  status: AudioRendererStatus;
  framesScheduled: number;
  /** Media time of the newest scheduled audio, in microseconds. */
  scheduledUntilUs?: number;
  /**
   * **Times the schedule ran dry** — the context clock passed the end of
   * everything scheduled while a track was still attached. Counted per
   * rising edge, not per tick, so one starvation is one increment.
   *
   * The clock itself hides this: `getClockTimeUs` clamps to the segment
   * end and resumes seamlessly, which is right for presentation and
   * useless as a signal. This is the direct "the target latency is below
   * what the path can sustain" evidence the adaptive controller has no
   * other way to obtain — a shallow buffer looks identical to a
   * well-behaved one right up until it is empty.
   */
  underruns: number;
  error?: unknown;
}

export interface CreateAudioRendererOptions {
  audioContext: AudioContextLike;
  /** Playout rate (latency nudges). Default 1. */
  getPlaybackRate?: () => number;
  /** Scheduling safety margin in seconds ahead of `currentTime`. Default 0.05. */
  scheduleMargin?: number;
  /** Decode/schedule cadence in ms. Default 10. */
  tickIntervalMs?: number;
  /**
   * **Join at the live edge.** Media timestamp the schedule should start
   * at while it has no anchor — at join, and again after a catch-up skip.
   * Buffered audio older than it is discarded rather than played: audio
   * cannot be fast-forwarded the way video can without pitch artifacts.
   * `undefined` (the default, and whatever the caller returns before any
   * frame has arrived) anchors at the oldest buffered frame instead.
   */
  getJoinAnchorUs?: () => number | undefined;
}

type RendererMessage =
  | { type: 'status'; status: AudioRendererStatus; error?: unknown }
  | { type: 'scheduled'; untilUs: number }
  | { type: 'underrun' };

export interface AudioRendererActor extends Pick<TransitionActor<AudioRendererContext, RendererMessage>, 'snapshot'> {
  /** Point the renderer at a (new) frame source + decoder config. */
  setTrack(source: AudioFrameSource | null, config: AudioDecoderConfig | null): void;
  /**
   * Master playout clock: current media time in microseconds, or
   * `undefined` before any audio has been scheduled.
   */
  getClockTimeUs(): number | undefined;
  destroy(): void;
}

// =============================================================================
// Implementation
// =============================================================================

const DEFAULT_SCHEDULE_MARGIN_S = 0.05;
const DEFAULT_TICK_INTERVAL_MS = 10;
/**
 * Max chunks in flight inside the decoder. The schedule horizon only
 * moves when decoder *outputs* arrive (async), so without this bound a
 * single tick would dequeue an entire backlog — scheduling seconds of
 * audio at once and sawtoothing the jitter-buffer depth the latency
 * controller measures.
 */
const MAX_PENDING_DECODES = 4;
/**
 * Media-time jump beyond which incoming audio is a timeline reset (latency
 * catch-up skipped groups) rather than a gap in the same timeline. Small
 * gaps map to scheduled silence; a reset re-anchors the schedule so the
 * jump is not converted into an equal stretch of silence.
 */
const DISCONTINUITY_THRESHOLD_US = 1_000_000;

export function createAudioRendererActor(options: CreateAudioRendererOptions): AudioRendererActor {
  const { audioContext } = options;
  const scheduleMargin = options.scheduleMargin ?? DEFAULT_SCHEDULE_MARGIN_S;

  const inner = createTransitionActor<AudioRendererContext, RendererMessage>(
    { status: 'idle', framesScheduled: 0, underruns: 0 },
    (context, message) => {
      switch (message.type) {
        case 'status':
          return { ...context, status: message.status, error: message.error };
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

  let source: AudioFrameSource | null = null;
  let decoderConfig: AudioDecoderConfig | null = null;
  let decoder: AudioDecoder | null = null;
  let destroyed = false;
  /** Timestamp of the last chunk fed to the decoder, for discontinuity detection. */
  let lastEnqueuedUs: number | undefined;
  /** The schedule has no anchor yet: the next one should be placed at the live edge. */
  let needsJoinAnchor = true;

  /**
   * One scheduled buffer's context-time span mapped to media time. The
   * media time at context time `t` inside the span is
   * `mediaUs + (t - startCtx) * 1e6 * rate`.
   */
  interface ClockSegment {
    startCtx: number;
    endCtx: number;
    mediaUs: number;
    rate: number;
  }

  /**
   * The scheduled timeline, in start order. Bounded by the schedule
   * horizon (`scheduleMargin * 4` of audio ≈ a dozen 20ms buffers) plus
   * whatever `pruneSegments` hasn't collected yet.
   */
  const segments: ClockSegment[] = [];
  const activeSources = new Set<AudioBufferSourceNode>();

  const rate = (): number => options.getPlaybackRate?.() ?? 1;

  const segmentEndMediaUs = (segment: ClockSegment): number =>
    segment.mediaUs + (segment.endCtx - segment.startCtx) * 1_000_000 * segment.rate;

  /** True while the context clock is past everything scheduled (see `underruns`). */
  let starved = false;

  /**
   * Count the rising edge of a schedule that has run dry. An empty
   * schedule is not an underrun — at join, and after every re-anchor that
   * clears it, there was no schedule to starve.
   */
  const detectUnderrun = (): void => {
    const last = segments[segments.length - 1];
    if (!last) {
      starved = false;
      return;
    }
    const dry = last.endCtx <= audioContext.currentTime;
    if (dry && !starved) inner.send({ type: 'underrun' });
    starved = dry;
  };

  /** Drop segments that finished playing; keep the current/newest one so the clock can hold on underrun. */
  const pruneSegments = (): void => {
    const now = audioContext.currentTime;
    while (segments.length > 1 && now >= segments[1]!.startCtx) segments.shift();
  };

  const stopAll = (): void => {
    for (const node of activeSources) {
      try {
        node.stop();
      } catch {
        // never started or already stopped
      }
    }
    activeSources.clear();
    segments.length = 0;
  };

  const closeDecoder = (): void => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    // A fresh decoder starts a fresh input timeline: the next chunk fed is
    // not a jump within the old one, so it must not re-trigger the
    // discontinuity restart that closed this decoder.
    lastEnqueuedUs = undefined;
    stopAll();
  };

  /**
   * Discard buffered audio older than the join anchor, so the schedule
   * starts at the live edge rather than at the oldest group the relay
   * replayed. Video decode-forwards its backlog; audio cannot (pitch), so
   * the backlog is dropped unheard.
   *
   * Anything already scheduled belongs to the pre-anchor timeline, so a
   * landed drop closes the decoder — the jumped-to audio then anchors
   * fresh instead of being butt-joined after a matching stretch of
   * scheduled silence, which would keep exactly the latency the drop shed.
   */
  const dropToJoinAnchor = (): void => {
    const anchorUs = options.getJoinAnchorUs?.();
    if (anchorUs === undefined || !source) return;
    let dropped = 0;
    for (let next = source.peek(); next && next.timestampUs < anchorUs; next = source.peek()) {
      source.dequeue();
      dropped++;
    }
    // Nothing behind the edge (yet): a relay's group replay arrives as a
    // burst, so stay armed — the buffer's live edge may still be moving.
    if (dropped === 0) return;
    needsJoinAnchor = false;
    closeDecoder();
  };

  const scheduleAudioData = (data: AudioData): void => {
    try {
      if (destroyed || data.numberOfFrames === 0) return;
      const buffer = audioContext.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
      for (let channel = 0; channel < data.numberOfChannels; channel++) {
        const channelData = new Float32Array(data.numberOfFrames);
        data.copyTo(channelData, { planeIndex: channel, format: 'f32-planar' });
        buffer.copyToChannel(channelData, channel);
      }

      const currentRate = rate();
      // A forward jump past the discontinuity threshold means the source
      // skipped ahead (latency catch-up): scheduling it as silence would
      // keep the latency it was meant to shed — and re-trigger the
      // catch-up loop forever. Drop the stale schedule and anchor fresh.
      const previous = segments[segments.length - 1];
      if (previous && data.timestamp - segmentEndMediaUs(previous) > DISCONTINUITY_THRESHOLD_US) {
        stopAll();
      }

      const last = segments[segments.length - 1];
      // Continue the scheduled timeline: media-contiguous data butt-joins
      // the previous buffer; a media gap inserts a matching stretch of
      // context-time silence. Late arrivals (and the first buffer) start
      // no earlier than the context clock — the timeline shifts forward
      // from there rather than trying to make up lost time.
      const idealStart = last
        ? last.endCtx + Math.max(0, data.timestamp - segmentEndMediaUs(last)) / 1_000_000 / currentRate
        : audioContext.currentTime + scheduleMargin;
      const startAt = Math.max(idealStart, audioContext.currentTime);

      const node = audioContext.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = currentRate;
      node.connect(audioContext.destination);
      node.onended = () => activeSources.delete(node);
      node.start(startAt);
      activeSources.add(node);

      const durationS = data.numberOfFrames / data.sampleRate / currentRate;
      segments.push({ startCtx: startAt, endCtx: startAt + durationS, mediaUs: data.timestamp, rate: currentRate });
      inner.send({ type: 'scheduled', untilUs: data.timestamp + data.duration });
    } finally {
      data.close();
    }
  };

  const ensureDecoder = (): AudioDecoder | null => {
    if (decoder || !decoderConfig) return decoder;
    decoder = new AudioDecoder({
      output: scheduleAudioData,
      error: (error) => inner.send({ type: 'status', status: 'error', error }),
    });
    decoder.configure(decoderConfig);
    return decoder;
  };

  const tick = (): void => {
    // After a decoder error there is nothing productive to pull into —
    // draining would silently strip the jitter buffer at tick rate.
    if (destroyed || !source || inner.snapshot.get().context.status === 'error') return;
    try {
      pruneSegments();
      detectUnderrun();
      // Keep the schedule topped up to the margin horizon; every audio
      // frame is independently decodable, so no keyframe gating.
      while (
        (decoder?.decodeQueueSize ?? 0) < MAX_PENDING_DECODES &&
        (segments[segments.length - 1]?.endCtx ?? 0) - audioContext.currentTime < scheduleMargin * 4
      ) {
        // Only while the schedule has no anchor to disturb: in steady state
        // the latency controller owns depth corrections (rate nudges inside
        // its deadband), and dropping audio here would preempt them.
        if (needsJoinAnchor && segments.length === 0) dropToJoinAnchor();
        const next = source.peek();
        if (!next) return;
        // FFmpeg-backed audio decoders rebase output timestamps by frame
        // accumulation from the first input, hiding an input-side jump
        // from the scheduler. Restart the decoder at the discontinuity so
        // outputs re-base to the jumped-to timeline (every audio frame is
        // independently decodable, so a restart is glitch-free).
        if (lastEnqueuedUs !== undefined && next.timestampUs - lastEnqueuedUs > DISCONTINUITY_THRESHOLD_US) {
          closeDecoder();
          // The catch-up skip that produced the jump landed on a group
          // start, still up to one GOP behind the live edge — re-place the
          // anchor before feeding the jumped-to timeline.
          needsJoinAnchor = true;
          continue;
        }
        const active = ensureDecoder();
        // An errored decoder is closed but still referenced — stop pulling
        // instead of feeding it doomed decode calls.
        if (!active || active.state === 'closed') return;
        // Decode before dequeue: if decode throws, the frame stays
        // buffered for a later decoder instead of being silently dropped.
        active.decode(
          new EncodedAudioChunk({
            // Every audio sample is independently decodable — `isKey` is a
            // LOC group-boundary marker (meaningful for video's GOP
            // gating), not a decodability signal here. A live-edge
            // (largest-object) join almost never lands on group object 0,
            // and WebCodecs requires the first post-configure chunk to be
            // 'key', so gating on `next.isKey` would reject it.
            type: 'key',
            timestamp: next.timestampUs,
            data: next.payload,
          })
        );
        source.dequeue();
        lastEnqueuedUs = next.timestampUs;
      }
    } catch (error) {
      inner.send({ type: 'status', status: 'error', error });
    }
  };
  const timer = setInterval(tick, options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);

  return {
    get snapshot() {
      return inner.snapshot;
    },

    setTrack(nextSource, nextConfig): void {
      // A source without a decodable config can never schedule audio — it
      // would spin every tick while the subscriber's jitter buffer grows
      // unbounded. Fail fast instead.
      const missingConfig = nextSource !== null && nextConfig === null;
      source = missingConfig ? null : nextSource;
      decoderConfig = nextConfig;
      needsJoinAnchor = true;
      closeDecoder();
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
      pruneSegments();
      const segment = segments[0];
      if (!segment) return undefined;
      // Clamp into the segment: before the first sample plays the clock
      // holds at its start; past the last scheduled sample (underrun) it
      // holds at the end and resumes seamlessly when audio is scheduled.
      const elapsed = Math.min(
        Math.max(0, audioContext.currentTime - segment.startCtx),
        segment.endCtx - segment.startCtx
      );
      return segment.mediaUs + elapsed * 1_000_000 * segment.rate;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      clearInterval(timer);
      closeDecoder();
      inner.destroy();
    },
  };
}
