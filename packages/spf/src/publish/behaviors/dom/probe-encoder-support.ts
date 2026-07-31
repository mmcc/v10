/**
 * **Probe WebCodecs encoder support for the captured tracks and pick the
 * active encodings.** While `state.captureTracks` facts exist, runs
 * `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported`
 * over a candidate ladder derived from `config.video` / `config.audio`
 * plus the captured track settings, publishes the supported configs as
 * `state.encoderSupport`, and resolves them into `state.activeEncodings`
 * through the `config.selectEncoderConfig` strategy seam (default: first
 * supported per kind).
 *
 * Default ladder: H.264 constrained-baseline (`avc1.42E01F`, `avc`
 * bitstream format so the avcC extradata rides LOC keyframes) with a VP8
 * fallback, at the track resolution/framerate; Opus at the track sample
 * rate with a 48 kHz fallback. A `config.video.codec` prepends itself to
 * the ladder rather than replacing it.
 *
 * Single-positive-state reactor mirroring `acquireCaptureSource`: the
 * probe runs in the positive state's `effects:` so a captureTracks
 * identity change (re-acquire) re-probes through the cleanup, and an
 * in-flight probe that resolves after the tracks changed discards via the
 * per-run `stale` flag.
 *
 * Sole writer of `state.encoderSupport` + `state.activeEncodings`;
 * co-writer of `state.publishError` (nothing-encodable failures only).
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import type { ReadonlySignal, Signal } from '../../../core/signals/primitives';
import type { CaptureTrackFacts, CaptureTracksFacts, PublishErrorFacts } from './acquire-capture-source';

/** Supported encoder configs per captured track kind. */
export interface EncoderSupportFacts {
  video?: VideoEncoderConfig[];
  audio?: AudioEncoderConfig[];
}

/** The encoder configs the encode pipeline should run with. */
export interface ActiveEncodingsFacts {
  video?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}

/**
 * Strategy seam resolving probed support into the active encodings —
 * e.g. to prefer a codec, cap resolution, or veto a kind entirely.
 */
export type SelectEncoderConfig = (support: EncoderSupportFacts) => ActiveEncodingsFacts;

/** Single-rendition encode tuning (mirrors `MoqPublishEngineConfig`). */
export interface ProbeEncoderSupportConfig {
  video?: { width?: number; height?: number; frameRate?: number; bitrate?: number; codec?: string };
  audio?: { bitrate?: number };
  selectEncoderConfig?: SelectEncoderConfig;
}

export interface ProbeEncoderSupportState {
  captureTracks?: CaptureTracksFacts;
  encoderSupport?: EncoderSupportFacts;
  activeEncodings?: ActiveEncodingsFacts;
  publishError?: PublishErrorFacts | undefined;
}

const DEFAULT_VIDEO_CODEC = 'avc1.42E01F';
const FALLBACK_VIDEO_CODEC = 'vp8';
const DEFAULT_VIDEO_BITRATE = 2_500_000;
const DEFAULT_AUDIO_CODEC = 'opus';
const OPUS_SAMPLE_RATE = 48_000;
const DEFAULT_AUDIO_BITRATE = 128_000;

export const defaultSelectEncoderConfig: SelectEncoderConfig = (support) => {
  const active: ActiveEncodingsFacts = {};
  if (support.video?.[0]) active.video = support.video[0];
  if (support.audio?.[0]) active.audio = support.audio[0];
  return active;
};

function videoCandidates(track: CaptureTrackFacts, video: ProbeEncoderSupportConfig['video']): VideoEncoderConfig[] {
  const codecs = [...new Set([...(video?.codec ? [video.codec] : []), DEFAULT_VIDEO_CODEC, FALLBACK_VIDEO_CODEC])];
  return codecs.map((codec) => ({
    codec,
    width: video?.width ?? track.width ?? 1280,
    height: video?.height ?? track.height ?? 720,
    framerate: video?.frameRate ?? track.frameRate ?? 30,
    bitrate: video?.bitrate ?? DEFAULT_VIDEO_BITRATE,
    latencyMode: 'realtime',
    // `avc` format keeps parameter sets in `decoderConfig.description`
    // (LOC Config carriage) instead of in-band Annex B.
    ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
  }));
}

function audioCandidates(track: CaptureTrackFacts, audio: ProbeEncoderSupportConfig['audio']): AudioEncoderConfig[] {
  const sampleRates = [...new Set([track.sampleRate ?? OPUS_SAMPLE_RATE, OPUS_SAMPLE_RATE])];
  return sampleRates.map((sampleRate) => ({
    codec: DEFAULT_AUDIO_CODEC,
    sampleRate,
    numberOfChannels: track.channelCount ?? 1,
    bitrate: audio?.bitrate ?? DEFAULT_AUDIO_BITRATE,
  }));
}

async function probeVideoSupport(candidates: VideoEncoderConfig[]): Promise<VideoEncoderConfig[]> {
  if (typeof VideoEncoder === 'undefined') return [];
  const supported: VideoEncoderConfig[] = [];
  for (const candidate of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported(candidate)).supported) supported.push(candidate);
    } catch {
      // Malformed candidate (bad codec string) — not supported.
    }
  }
  return supported;
}

async function probeAudioSupport(candidates: AudioEncoderConfig[]): Promise<AudioEncoderConfig[]> {
  if (typeof AudioEncoder === 'undefined') return [];
  const supported: AudioEncoderConfig[] = [];
  for (const candidate of candidates) {
    try {
      if ((await AudioEncoder.isConfigSupported(candidate)).supported) supported.push(candidate);
    } catch {
      // Malformed candidate — not supported.
    }
  }
  return supported;
}

type ProbeEncoderSupportFsmState = 'no-tracks' | 'tracks-present';

function probeEncoderSupportSetup({
  state,
  config = {},
}: {
  state: {
    captureTracks: ReadonlySignal<ProbeEncoderSupportState['captureTracks']>;
    encoderSupport: Signal<ProbeEncoderSupportState['encoderSupport']>;
    activeEncodings: Signal<ProbeEncoderSupportState['activeEncodings']>;
    publishError: Signal<ProbeEncoderSupportState['publishError']>;
  };
  config?: ProbeEncoderSupportConfig;
}): Reactor<ProbeEncoderSupportFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<ProbeEncoderSupportFsmState>({
    initial: 'no-tracks',
    monitor: () => (state.captureTracks.get() ? 'tracks-present' : 'no-tracks'),
    states: {
      'no-tracks': {},

      'tracks-present': {
        // effects (not entry) so a captureTracks identity change
        // (re-acquired stream, new settings) re-probes through the cleanup.
        effects: () => {
          // Tracked: the facts object's identity drives re-probing.
          const tracks = state.captureTracks.get()!;
          let stale = false;

          const probe = async () => {
            const support: EncoderSupportFacts = {};
            if (tracks.video) support.video = await probeVideoSupport(videoCandidates(tracks.video, config.video));
            if (tracks.audio) support.audio = await probeAudioSupport(audioCandidates(tracks.audio, config.audio));
            if (stale) return;
            state.encoderSupport.set(support);
            const active = (config.selectEncoderConfig ?? defaultSelectEncoderConfig)(support);
            state.activeEncodings.set(active);
            if (!active.video && !active.audio) {
              state.publishError.set({
                code: 'encode',
                message: 'No supported encoder configuration for the captured tracks.',
              });
            }
          };
          void probe();

          return () => {
            stale = true;
            state.encoderSupport.set(undefined);
            state.activeEncodings.set(undefined);
          };
        },
      },
    },
  });
}

export const probeEncoderSupport = defineBehavior({
  stateKeys: ['captureTracks', 'encoderSupport', 'activeEncodings', 'publishError'],
  contextKeys: [],
  setup: probeEncoderSupportSetup,
});
