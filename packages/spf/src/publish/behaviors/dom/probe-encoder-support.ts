/**
 * **Probe WebCodecs encoder support for each captured track and pick the
 * active encodings.** Three independent probes — camera, screen, mic —
 * each running while its own `state.*Tracks` fact exists: runs
 * `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported` over
 * a candidate ladder derived from `config.{camera,screen,audio}` plus the
 * captured track settings, merges the result into `state.encoderSupport`
 * (partitioned by kind — see below), and resolves `state.activeEncodings`
 * through the `config.selectEncoderConfig` strategy seam (default: first
 * supported per kind), applying only that probe's own kind from the
 * strategy's result.
 *
 * Default ladder: H.264 constrained-baseline (`avc1.42E01F`, `avc`
 * bitstream format so the avcC extradata exists to publish out-of-band —
 * see `videoCandidates`) with a VP8 fallback, at the track
 * resolution/framerate; Opus at the track sample rate with a 48 kHz
 * fallback. A `config.{camera,screen,audio}.codec` prepends itself to the
 * ladder rather than replacing it — for audio the preferred codec probes
 * at every ladder sample rate before Opus does (codec preference
 * outranks rate preference), so `audio: { codec: 'mp4a.40.2' }` publishes
 * AAC where the browser can encode it and falls back to Opus where it
 * can't. The screen ladder defaults to a lower framerate than the
 * camera's (static degrade-screen-first tuning, per the multi-source
 * design record's "Encoder budget" decision — no dynamic policy in v1).
 *
 * Each probe is a single-positive-state reactor mirroring the acquire
 * behaviors: the probe runs in the positive state's `effects:` so a
 * tracks-identity change (re-acquire) re-probes through the cleanup, and
 * an in-flight probe that resolves after the tracks changed discards via
 * the per-run `stale` flag.
 *
 * `state.encoderSupport` / `state.activeEncodings` are multi-writer slots
 * partitioned by kind — the same pattern `publishError` already uses:
 * each probe is the sole writer of its own key and never touches the
 * others', so camera support resolving never clobbers screen's (or vice
 * versa) and either can come and go independently through a session. The
 * last kind leaving restores the absent state rather than an empty object
 * — see `withoutKind`.
 *
 * Co-writer of `state.publishError`, for one condition only: a kind whose
 * candidate ladder probed entirely unsupported. A `selectEncoderConfig`
 * omitting a kind is a policy veto, not a failure. Such a verdict stands
 * until the kind recovers or its source is released — including across
 * another writer taking the slot and later clearing it — see the
 * arbitration rule on `authoredErrors`.
 */
import { defineBehavior } from '../../../core/composition/create-composition';
import type { Reactor } from '../../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../../core/reactors/create-machine-reactor';
import { effect } from '../../../core/signals/effect';
import { peek, type ReadonlySignal, type Signal } from '../../../core/signals/primitives';
import type { CaptureTrackFacts, PublishErrorFacts } from './acquire-capture-source';

/** Supported encoder configs per captured track kind. */
export interface EncoderSupportFacts {
  camera?: VideoEncoderConfig[];
  screen?: VideoEncoderConfig[];
  audio?: AudioEncoderConfig[];
}

/** The encoder configs the encode pipeline should run with, per kind. */
export interface ActiveEncodingsFacts {
  camera?: VideoEncoderConfig;
  screen?: VideoEncoderConfig;
  audio?: AudioEncoderConfig;
}

/**
 * Strategy seam resolving probed support into the active encodings —
 * e.g. to prefer a codec, cap resolution, or veto a kind entirely. Called
 * with the full merged support snapshot; each probe applies only its own
 * kind from the result.
 */
export type SelectEncoderConfig = (support: EncoderSupportFacts) => ActiveEncodingsFacts;

export interface VideoEncodeTuning {
  width?: number;
  height?: number;
  frameRate?: number;
  bitrate?: number;
  codec?: string;
}

export interface AudioEncodeTuning {
  bitrate?: number;
  /**
   * Preferred WebCodecs audio codec string (e.g. `'mp4a.40.2'` for
   * AAC-LC). Prepended to the Opus default rather than replacing it, so
   * an unsupported preference degrades to Opus instead of failing the
   * kind.
   */
  codec?: string;
}

/** Per-kind encode tuning (mirrors `MoqPublishEngineConfig`). */
export interface ProbeEncoderSupportConfig {
  camera?: VideoEncodeTuning;
  screen?: VideoEncodeTuning;
  audio?: AudioEncodeTuning;
  selectEncoderConfig?: SelectEncoderConfig;
}

export interface ProbeEncoderSupportState {
  cameraTracks?: CaptureTrackFacts;
  screenTracks?: CaptureTrackFacts;
  micTracks?: CaptureTrackFacts;
  encoderSupport?: EncoderSupportFacts;
  activeEncodings?: ActiveEncodingsFacts;
  publishError?: PublishErrorFacts | undefined;
}

const DEFAULT_VIDEO_CODEC = 'avc1.42E01F';
const FALLBACK_VIDEO_CODEC = 'vp8';
const DEFAULT_VIDEO_BITRATE = 2_500_000;
const DEFAULT_SCREEN_FRAME_RATE = 15;
const DEFAULT_SCREEN_BITRATE = 1_500_000;
const DEFAULT_AUDIO_CODEC = 'opus';
const OPUS_SAMPLE_RATE = 48_000;
const DEFAULT_AUDIO_BITRATE = 128_000;

export const defaultSelectEncoderConfig: SelectEncoderConfig = (support) => {
  const active: ActiveEncodingsFacts = {};
  if (support.camera?.[0]) active.camera = support.camera[0];
  if (support.screen?.[0]) active.screen = support.screen[0];
  if (support.audio?.[0]) active.audio = support.audio[0];
  return active;
};

function videoCandidates(track: CaptureTrackFacts, tuning: VideoEncodeTuning | undefined): VideoEncoderConfig[] {
  const codecs = [...new Set([...(tuning?.codec ? [tuning.codec] : []), DEFAULT_VIDEO_CODEC, FALLBACK_VIDEO_CODEC])];
  return codecs.map((codec) => ({
    codec,
    width: tuning?.width ?? track.width ?? 1280,
    height: tuning?.height ?? track.height ?? 720,
    framerate: tuning?.frameRate ?? track.frameRate ?? 30,
    bitrate: tuning?.bitrate ?? DEFAULT_VIDEO_BITRATE,
    latencyMode: 'realtime',
    // `avc` (length-prefixed AVCC) is what the `avc1` codec string
    // declares (ISO/IEC 14496-15) — a length-prefix reader parsing
    // Annex-B start codes as NAL lengths crashes on the SPS bytes — and
    // it is the format under which WebCodecs reports the avcC as
    // `decoderConfig.description`, which the MSF catalog publishes as
    // `initDataList` (`derive-catalog.ts`). The catalog is the carriage
    // that reaches every consumer: the alternative per-keyframe LOC
    // Config property is an odd-id MOQ object property relays drop
    // without forwarding (relay.mux.dev, verified on the wire
    // 2026-08-01), which is what sank the earlier LOC-property-only
    // `avc` carriage and forced a detour through in-band `annexb`.
    ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}),
  }));
}

function screenCandidates(track: CaptureTrackFacts, tuning: VideoEncodeTuning | undefined): VideoEncoderConfig[] {
  return videoCandidates(track, {
    ...tuning,
    // Coalesced, not spread-ordered: a caller spreading a partial config
    // passes `frameRate: undefined` as a present key, which would drop the
    // screen defaults and silently re-inherit the camera-level ones.
    frameRate: tuning?.frameRate ?? DEFAULT_SCREEN_FRAME_RATE,
    bitrate: tuning?.bitrate ?? DEFAULT_SCREEN_BITRATE,
  });
}

function audioCandidates(track: CaptureTrackFacts, audio: AudioEncodeTuning | undefined): AudioEncoderConfig[] {
  const codecs = [...new Set([...(audio?.codec ? [audio.codec] : []), DEFAULT_AUDIO_CODEC])];
  const sampleRates = [...new Set([track.sampleRate ?? OPUS_SAMPLE_RATE, OPUS_SAMPLE_RATE])];
  // Codec-major: the preferred codec exhausts its sample rates before the
  // default gets a turn — the preference exists for egress compatibility,
  // which a rate tweak can't buy back.
  return codecs.flatMap((codec) =>
    sampleRates.map((sampleRate) => ({
      codec,
      sampleRate,
      numberOfChannels: track.channelCount ?? 1,
      bitrate: audio?.bitrate ?? DEFAULT_AUDIO_BITRATE,
    }))
  );
}

/**
 * Drop one kind from a per-kind facts object, collapsing an emptied result
 * back to `undefined`. `{}` is truthy and downstream gates on presence, not
 * on content: `deriveCatalog` would sit in 'publishing-catalog' and publish
 * a track-less catalog once the last source was released, instead of
 * dropping to idle.
 */
function withoutKind<Facts extends EncoderSupportFacts | ActiveEncodingsFacts>(
  facts: Facts | undefined,
  kind: keyof EncoderSupportFacts
): Facts | undefined {
  const remaining = Object.entries(facts ?? {}).filter(([key]) => key !== kind);
  return remaining.length === 0 ? undefined : (Object.fromEntries(remaining) as Facts);
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

type ProbeFsmState = 'no-tracks' | 'tracks-present';

function probeEncoderSupportSetup({
  state,
  config = {},
}: {
  state: {
    cameraTracks: ReadonlySignal<ProbeEncoderSupportState['cameraTracks']>;
    screenTracks: ReadonlySignal<ProbeEncoderSupportState['screenTracks']>;
    micTracks: ReadonlySignal<ProbeEncoderSupportState['micTracks']>;
    encoderSupport: Signal<ProbeEncoderSupportState['encoderSupport']>;
    activeEncodings: Signal<ProbeEncoderSupportState['activeEncodings']>;
    publishError: Signal<ProbeEncoderSupportState['publishError']>;
  };
  config?: ProbeEncoderSupportConfig;
}): () => void {
  const select = config.selectEncoderConfig ?? defaultSelectEncoderConfig;

  /**
   * The encode verdicts THIS behavior instance wrote, per kind, in authoring
   * order. `publishError` is one slot with several writers, so the
   * arbitration rule is:
   *
   * - **Any writer may take the slot** — last write wins, including over
   *   ours. Membership here is what we believe, not what is displayed.
   * - **We retract only the object we put there** (identity-compared), so a
   *   capture or transport failure written after ours survives our recovery;
   *   the slot passes to our next outstanding kind, if any.
   * - **We retake the slot whenever it falls empty** while a kind is still
   *   un-encodable (`reassertOutstandingError`). Other writers retract their
   *   own errors on their own schedule — a fresh acquisition clears a stale
   *   capture failure — and an unsupported encoder ladder is not fixed by
   *   that; without this the UI would show nothing for a broken source.
   */
  const authoredErrors = new Map<keyof EncoderSupportFacts, PublishErrorFacts>();

  /** The outstanding verdict with the strongest claim to the slot: the first authored. */
  const outstandingError = (): PublishErrorFacts | undefined => [...authoredErrors.values()][0];

  /** Retract this kind's encode error — its source is gone, or it encodes now. */
  function retractError(kind: keyof EncoderSupportFacts): void {
    const authored = authoredErrors.get(kind);
    if (authored === undefined) return;
    authoredErrors.delete(kind);
    if (peek(state.publishError) !== authored) return;
    // Hand the slot straight to the next outstanding kind (the effect below
    // would too, a microtask later — this keeps the UI from flickering
    // through 'no error' on the way).
    state.publishError.set(outstandingError());
  }

  // Terminates: the sole write is a non-`undefined` value, so the re-run it
  // triggers takes the early return.
  const reassertOutstandingError = effect(() => {
    if (state.publishError.get() !== undefined) return;
    const outstanding = outstandingError();
    if (outstanding !== undefined) state.publishError.set(outstanding);
  });

  function runProbe<Track extends CaptureTrackFacts, EncConfig extends VideoEncoderConfig | AudioEncoderConfig>(
    kind: keyof EncoderSupportFacts,
    tracks: ReadonlySignal<Track | undefined>,
    candidatesFor: (track: Track) => EncConfig[],
    probeSupport: (candidates: EncConfig[]) => Promise<EncConfig[]>
  ): Reactor<ProbeFsmState | 'destroying' | 'destroyed'> {
    return createMachineReactor<ProbeFsmState>({
      initial: 'no-tracks',
      monitor: () => (tracks.get() ? 'tracks-present' : 'no-tracks'),
      states: {
        'no-tracks': {},
        'tracks-present': {
          effects: () => {
            const track = tracks.get()!;
            let stale = false;

            const probe = async () => {
              const supported = await probeSupport(candidatesFor(track));
              if (stale) return;
              const merged = { ...peek(state.encoderSupport), [kind]: supported } as EncoderSupportFacts;
              state.encoderSupport.set(merged);
              const resolvedKindValue = select(merged)[kind];
              state.activeEncodings.set(
                resolvedKindValue === undefined
                  ? withoutKind(peek(state.activeEncodings), kind)
                  : ({ ...peek(state.activeEncodings), [kind]: resolvedKindValue } as ActiveEncodingsFacts)
              );
              // Only an empty ladder is a failure. A strategy that omits a
              // kind it could have picked is a policy veto — publishing
              // without that track is the intended outcome, not an error.
              if (supported.length === 0) {
                const error: PublishErrorFacts = {
                  code: 'encode',
                  message: `No supported encoder configuration for the ${kind} track.`,
                };
                authoredErrors.set(kind, error);
                state.publishError.set(error);
              } else {
                retractError(kind);
              }
            };
            void probe();

            return () => {
              stale = true;
              state.encoderSupport.set(withoutKind(peek(state.encoderSupport), kind));
              state.activeEncodings.set(withoutKind(peek(state.activeEncodings), kind));
              // The source is released (or about to be re-probed): a verdict
              // about a track that no longer exists must not outlive it.
              retractError(kind);
            };
          },
        },
      },
    });
  }

  const cameraProbe = runProbe(
    'camera',
    state.cameraTracks,
    (track) => videoCandidates(track, config.camera),
    probeVideoSupport
  );
  const screenProbe = runProbe(
    'screen',
    state.screenTracks,
    (track) => screenCandidates(track, config.screen),
    probeVideoSupport
  );
  const audioProbe = runProbe(
    'audio',
    state.micTracks,
    (track) => audioCandidates(track, config.audio),
    probeAudioSupport
  );

  return () => {
    // Stop reasserting before the probes retract, so teardown leaves the
    // slot as the last real writer left it.
    reassertOutstandingError();
    cameraProbe.destroy();
    screenProbe.destroy();
    audioProbe.destroy();
  };
}

export const probeEncoderSupport = defineBehavior({
  stateKeys: ['cameraTracks', 'screenTracks', 'micTracks', 'encoderSupport', 'activeEncodings', 'publishError'],
  contextKeys: [],
  setup: probeEncoderSupportSetup,
});
