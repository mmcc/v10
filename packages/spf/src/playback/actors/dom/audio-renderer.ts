/**
 * AudioDecoder → Web Audio renderer actor. **Owns the master clock**: once
 * audio is scheduled, `getClockTimeUs()` maps the AudioContext's hardware
 * clock back to media time, and the video renderer (and `currentTime`
 * derivation) follow it.
 *
 * Decoded `AudioData` is copied into `AudioBuffer`s and scheduled
 * gaplessly with `AudioBufferSourceNode`s against a media-time ↔
 * context-time anchor. Rate nudges from the latency controller apply as
 * `playbackRate` on the scheduled sources (a ±5% nudge is a barely
 * audible pitch shift).
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
}

type RendererMessage =
  | { type: 'status'; status: AudioRendererStatus; error?: unknown }
  | { type: 'scheduled'; untilUs: number };

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

export function createAudioRendererActor(options: CreateAudioRendererOptions): AudioRendererActor {
  const { audioContext } = options;
  const scheduleMargin = options.scheduleMargin ?? DEFAULT_SCHEDULE_MARGIN_S;

  const inner = createTransitionActor<AudioRendererContext, RendererMessage>(
    { status: 'idle', framesScheduled: 0 },
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
      }
    }
  );

  let source: AudioFrameSource | null = null;
  let decoderConfig: AudioDecoderConfig | null = null;
  let decoder: AudioDecoder | null = null;
  let destroyed = false;

  /**
   * Media-time ↔ context-time anchor, established by the first scheduled
   * frame. `contextTime = anchor.contextTime + (mediaUs - anchor.mediaUs) / 1e6 / rate`.
   */
  let anchor: { mediaUs: number; contextTime: number } | null = null;
  /** Context time up to which audio is already scheduled (gapless append). */
  let scheduledUntilContextTime = 0;
  const activeSources = new Set<AudioBufferSourceNode>();

  const rate = (): number => options.getPlaybackRate?.() ?? 1;

  const stopAll = (): void => {
    for (const node of activeSources) {
      try {
        node.stop();
      } catch {
        // never started or already stopped
      }
    }
    activeSources.clear();
    anchor = null;
    scheduledUntilContextTime = 0;
  };

  const closeDecoder = (): void => {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    stopAll();
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

      if (!anchor) {
        anchor = { mediaUs: data.timestamp, contextTime: audioContext.currentTime + scheduleMargin };
        scheduledUntilContextTime = anchor.contextTime;
      }
      const idealStart = anchor.contextTime + (data.timestamp - anchor.mediaUs) / 1_000_000 / rate();
      // Gapless: never start behind already-scheduled audio; small early
      // arrivals butt-join, late ones re-anchor forward.
      const startAt = Math.max(idealStart, scheduledUntilContextTime, audioContext.currentTime);

      const node = audioContext.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = rate();
      node.connect(audioContext.destination);
      node.onended = () => activeSources.delete(node);
      node.start(startAt);
      activeSources.add(node);

      const durationS = data.numberOfFrames / data.sampleRate / rate();
      scheduledUntilContextTime = startAt + durationS;
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
    if (destroyed || !source) return;
    try {
      // Keep the schedule topped up to the margin horizon; every audio
      // frame is independently decodable, so no keyframe gating.
      while (scheduledUntilContextTime - audioContext.currentTime < scheduleMargin * 4) {
        const next = source.peek();
        if (!next) return;
        const active = ensureDecoder();
        if (!active) return;
        source.dequeue();
        active.decode(
          new EncodedAudioChunk({
            type: next.isKey ? 'key' : 'delta',
            timestamp: next.timestampUs,
            data: next.payload,
          })
        );
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
      source = nextSource;
      decoderConfig = nextConfig;
      closeDecoder();
      inner.send({ type: 'status', status: nextSource ? 'rendering' : 'idle' });
    },

    getClockTimeUs(): number | undefined {
      if (!anchor) return undefined;
      const elapsed = audioContext.currentTime - anchor.contextTime;
      // Before the first sample actually plays, the clock holds at the anchor.
      return anchor.mediaUs + Math.max(0, elapsed) * 1_000_000 * rate();
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
