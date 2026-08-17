/**
 * **Publish the MSF catalog for the tracks being published.** While a
 * catalog track publisher exists and `state.activeEncodings` +
 * `state.endpoint` describe what is being published, builds the catalog
 * JSON through `config.buildCatalog` (default `buildMsfCatalog`) and sends
 * it as object 0 of a new group on the catalog publisher — re-deriving
 * whenever the inputs change identity, so subscribers always have a
 * current, independently parseable catalog at every group boundary.
 *
 * **The advertisement is latched across a source switch, mirroring
 * `setupTrackPublishers`.** A device switch re-acquires through a
 * cleanup-first release, so the kind's probe verdict — and with it
 * `activeEncodings[kind]` — vanishes for the length of the re-probe,
 * while the kind's MOQT track publisher deliberately survives
 * (`setupTrackPublishers` latches it: ending the track mid-session would
 * PUBLISH_DONE it for every subscriber). A catalog derived from the
 * encodings alone re-published without the track and then re-added it,
 * and subscribers obey catalogs: every mic switch tore down the viewer's
 * audio subscription and re-joined it at the live edge, where the audio
 * master clock re-anchored at ~zero latency and dragged the whole
 * presentation with it. So a kind whose encoding is absent stays
 * advertised with its last-known config while its capture status says
 * the source is live or coming back (`'active'` / `'acquiring'`) *and*
 * the kind has no completed probe verdict (`encoderSupport[kind]` — the
 * probe clears it alongside the encoding on a re-probe, and re-commits it
 * even when the ladder proves empty or the selection strategy vetoes the
 * kind, either of which is an answer rather than a transient). It leaves
 * the catalog when the source truly leaves (`'idle'`, `'denied'`,
 * `'ended'`, or no status at all), when a completed probe selected
 * nothing, or when the catalog publisher itself is replaced — a rebuilt
 * session re-latches its per-kind PUBLISHes from the current encodings,
 * so a held kind would name a track the new session never published. A
 * switch that resolves to a different config (a mono mic replacing a
 * stereo one) still republishes, because a present encoding always beats
 * the held copy.
 * The follow-up that trade creates — a viewer keeping its subscription
 * across a config change on the same track name — is recorded in the
 * multi-source design record.
 *
 * Sends are deduplicated by content, per publisher: the latch makes
 * several input changes re-derive byte-identical catalogs (each
 * capture-status hop, a re-probe resolving to the same config), and each
 * send opens a new group every subscriber must parse. Keyed on the
 * publisher so a rebuilt session's fresh catalog track always receives
 * the current catalog, however recently the previous track carried the
 * same bytes.
 *
 * DOM-free pure dispatcher per the setup-actor convention: it reads the
 * publisher slot `setupTrackPublishers` owns and sends frames — it never
 * creates actors. The WebCodecs encoder configs feed the catalog directly:
 * their `codec` fields are already WebCodecs registry strings, which is
 * exactly what MSF §5.2.18 mandates for LOC tracks.
 *
 * **Decoder init data rides the catalog, not only LOC.** Each kind's
 * `state.encoderInitData` (the `decoderConfig.description` its live
 * encoder reported — `setupEncoderActors`) is emitted as the catalog's
 * `initDataList` + per-track `initRef`. The catalog is the one channel
 * every consumer can read: the per-keyframe LOC Config property is an
 * odd-id MOQ object property that relays and property-blind consumers
 * drop, and an MoQ→HLS origin needs the extradata *before* any media
 * object to build an init segment. The description arrives on the kind's
 * first encoded output — after its encoder actor (whose teardown clears
 * the fact) rebuilds — so it is latched beside the encoding: held through
 * an actor rebuild while the kind's config is unchanged (a device switch
 * must not flap `initRef` off and back on), dropped the moment the config
 * changes (old extradata describes the old config) or the kind leaves the
 * catalog. A config whose bitstream is undecodable without that init
 * data (see `requiresInitData`) is only ever advertised as a complete
 * pair: before the kind's first description report it stays out of the
 * catalog — an `avc1` track without `initRef` is an undecodable
 * declaration a consumer may configure from once and never re-evaluate —
 * and across a config change the previous complete pair holds for the
 * one-frame window until the new description lands, because dropping the
 * track instead would end every subscriber's subscription.
 *
 * Writes no state; state/context reader only.
 */
import { defineBehavior } from '../../core/composition/create-composition';
import type { Reactor } from '../../core/reactors/create-machine-reactor';
import { createMachineReactor } from '../../core/reactors/create-machine-reactor';
import type { ReadonlySignal } from '../../core/signals/primitives';
import type { BuildMsfCatalog, MsfCatalogInput } from '../../media/moq/build-catalog';
import { buildMsfCatalog } from '../../media/moq/build-catalog';
import type { TrackPublisherActor } from '../actors/track-publisher';
import type { PublishEndpoint } from '../session/publish-session';
import type { ActiveEncodingsFacts } from './setup-track-publishers';
import { AUDIO_TRACK_NAME, SCREEN_TRACK_NAME, VIDEO_TRACK_NAME } from './setup-track-publishers';

/**
 * Structural mirror of `behaviors/dom/acquire-capture-source.ts`'s
 * `CaptureStatus` (DOM-bound behavior, so not importable here) — keep
 * identical.
 */
export type CaptureSourceStatus = 'idle' | 'acquiring' | 'active' | 'denied' | 'ended';

/**
 * Structural mirror of `behaviors/dom/probe-encoder-support.ts`'s
 * `EncoderSupportFacts` (same non-importable DOM boundary as
 * `ActiveEncodingsFacts` above) — keep identical.
 */
export interface EncoderSupportByKind {
  camera?: VideoEncoderConfig[];
  screen?: VideoEncoderConfig[];
  audio?: AudioEncoderConfig[];
}

/**
 * Structural mirror of `behaviors/dom/setup-encoder-actors.ts`'s
 * `EncoderInitDataFacts` (same non-importable DOM boundary as the mirrors
 * above) — keep identical.
 */
export interface EncoderInitDataByKind {
  camera?: Uint8Array;
  screen?: Uint8Array;
  audio?: Uint8Array;
}

export interface DeriveCatalogState {
  activeEncodings?: ActiveEncodingsFacts;
  endpoint?: PublishEndpoint | undefined;
  encoderSupport?: EncoderSupportByKind;
  encoderInitData?: EncoderInitDataByKind;
  cameraState?: CaptureSourceStatus;
  screenShareState?: CaptureSourceStatus;
  micState?: CaptureSourceStatus;
}

export interface DeriveCatalogContext {
  catalogTrackPublisher?: TrackPublisherActor | undefined;
}

export interface DeriveCatalogConfig {
  /** Catalog-JSON builder seam; default `buildMsfCatalog`. */
  buildCatalog?: BuildMsfCatalog;
}

type DeriveCatalogFsmState = 'idle' | 'publishing-catalog';

const textEncoder = new TextEncoder();

/**
 * Whether the kind's source is live or mid-switch — the states in which a
 * missing encoding is a re-probe transient rather than a removal.
 */
function sourceHolds(status: CaptureSourceStatus | undefined): boolean {
  return status === 'active' || status === 'acquiring';
}

/**
 * Whether the config's bitstream can only be decoded with out-of-band
 * init data. `avc1` in its default `avc` (AVCC) bitstream format needs
 * the avcC `description` (`annexb` keeps parameter sets in-band); AAC
 * (`mp4a.*`) needs its AudioSpecificConfig. VP8/VP9/AV1 and Opus are
 * self-describing. Covers the codecs the config seam can produce today —
 * extend alongside the probe ladder.
 */
function requiresInitData(config: VideoEncoderConfig | AudioEncoderConfig): boolean {
  if (config.codec.startsWith('avc1')) return (config as VideoEncoderConfig).avc?.format !== 'annexb';
  return config.codec.startsWith('mp4a');
}

/** Project the active encoder configs onto the catalog builder's input. */
export function catalogInputFor(
  endpoint: PublishEndpoint,
  encodings: ActiveEncodingsFacts,
  initData: EncoderInitDataByKind = {}
): MsfCatalogInput {
  const input: MsfCatalogInput = { namespace: endpoint.namespace };
  if (encodings.camera) {
    input.video = {
      name: VIDEO_TRACK_NAME,
      codec: encodings.camera.codec,
      width: encodings.camera.width,
      height: encodings.camera.height,
      framerate: encodings.camera.framerate,
      bitrate: encodings.camera.bitrate,
      initData: initData.camera,
    };
  }
  if (encodings.screen) {
    input.screen = {
      name: SCREEN_TRACK_NAME,
      codec: encodings.screen.codec,
      width: encodings.screen.width,
      height: encodings.screen.height,
      framerate: encodings.screen.framerate,
      bitrate: encodings.screen.bitrate,
      initData: initData.screen,
    };
  }
  if (encodings.audio) {
    input.audio = {
      name: AUDIO_TRACK_NAME,
      codec: encodings.audio.codec,
      samplerate: encodings.audio.sampleRate,
      channelConfig: String(encodings.audio.numberOfChannels),
      bitrate: encodings.audio.bitrate,
      initData: initData.audio,
    };
  }
  return input;
}

function deriveCatalogSetup({
  state,
  context,
  config = {},
}: {
  state: {
    activeEncodings: ReadonlySignal<DeriveCatalogState['activeEncodings']>;
    endpoint: ReadonlySignal<DeriveCatalogState['endpoint']>;
    encoderSupport: ReadonlySignal<DeriveCatalogState['encoderSupport']>;
    encoderInitData: ReadonlySignal<DeriveCatalogState['encoderInitData']>;
    cameraState: ReadonlySignal<DeriveCatalogState['cameraState']>;
    screenShareState: ReadonlySignal<DeriveCatalogState['screenShareState']>;
    micState: ReadonlySignal<DeriveCatalogState['micState']>;
  };
  context: {
    catalogTrackPublisher: ReadonlySignal<DeriveCatalogContext['catalogTrackPublisher']>;
  };
  config?: DeriveCatalogConfig;
}): Reactor<DeriveCatalogFsmState | 'destroying' | 'destroyed'> {
  // The latch memory: the encoding each kind was last advertised with.
  // Setup-scoped rather than effect-scoped so it survives the reactor
  // passing through 'idle' (a sole-source device switch collapses
  // `activeEncodings` to undefined for the length of the re-probe).
  const advertised: ActiveEncodingsFacts = {};

  // The init data each kind was last advertised with — latched beside the
  // encoding (see the module doc), so a rebuild transient never flaps the
  // catalog's `initRef` off and back on. Contains only kinds currently in
  // (or held in) the catalog; resolve() prunes it with `advertised`.
  const advertisedInitData: EncoderInitDataByKind = {};

  /**
   * The publisher the latch memory describes. A new catalog publisher
   * means a rebuilt session whose publisher cluster re-latches its
   * per-kind PUBLISHes from the *current* encodings — a kind held from
   * the old session would name a track the new session has never
   * published. The memory resets with it.
   */
  let lastPublisher: TrackPublisherActor | undefined;

  /** Last catalog put on the wire, and the publisher it was sent to. */
  let lastSent: { publisher: TrackPublisherActor; text: string } | undefined;

  return createMachineReactor<DeriveCatalogFsmState>({
    initial: 'idle',
    monitor: () =>
      context.catalogTrackPublisher.get() && state.activeEncodings.get() && state.endpoint.get()
        ? 'publishing-catalog'
        : 'idle',
    states: {
      idle: {},

      'publishing-catalog': {
        // effects (not entry) so an encodings/status/endpoint/publisher
        // identity change re-derives a current catalog.
        effects: () => {
          const publisher = context.catalogTrackPublisher.get()!;
          const encodings = state.activeEncodings.get()!;
          const endpoint = state.endpoint.get()!;
          // Statuses and support are read unconditionally so the effect's
          // tracked dependency set stays stable — a signal only consulted
          // once its kind's encoding is missing would not re-fire this
          // effect when a failed switch parks on 'denied' (or a re-probe
          // resolves empty) with the encodings unchanged. The redundant
          // re-runs each hop costs are absorbed by the content dedupe
          // below.
          const support = state.encoderSupport.get();
          const initData = state.encoderInitData.get();
          const statuses = {
            camera: state.cameraState.get(),
            screen: state.screenShareState.get(),
            audio: state.micState.get(),
          };

          if (publisher !== lastPublisher) {
            lastPublisher = publisher;
            delete advertised.camera;
            delete advertised.screen;
            delete advertised.audio;
            delete advertisedInitData.camera;
            delete advertisedInitData.screen;
            delete advertisedInitData.audio;
          }

          const resolve = <Kind extends keyof ActiveEncodingsFacts>(kind: Kind): ActiveEncodingsFacts[Kind] => {
            const current = encodings[kind];
            if (current !== undefined) {
              // The kind's description arrives on its first encoded output
              // — after the actor whose teardown cleared the fact rebuilt —
              // so an absent fact under an unchanged config is that
              // transient: hold the advertised copy. Under a *changed*
              // config the old extradata is invalid; drop it and wait for
              // the new codec's report. (Content-compared: a re-probe
              // resolving to the same config produces a fresh object.)
              const fresh = initData?.[kind];
              const held =
                fresh ??
                (JSON.stringify(advertised[kind]) === JSON.stringify(current) ? advertisedInitData[kind] : undefined);
              // Complete-pair gate (see the module doc): a config that is
              // undecodable without init data never advances the advertised
              // pair until its description exists — the previous complete
              // advertisement (or none, before the first report) stands.
              if (held === undefined && requiresInitData(current)) return advertised[kind];
              if (held === undefined) delete advertisedInitData[kind];
              else advertisedInitData[kind] = held;
              advertised[kind] = current;
              return current;
            }
            // Hold only while the kind has no completed probe verdict: the
            // probe clears its kind's support alongside the encoding when a
            // switch re-probes, so their joint absence is the transient. A
            // verdict that is present while the encoding is not is a
            // completed answer — an empty ladder, or a `selectEncoderConfig`
            // veto — and the source being live does not make the track
            // encodable, so it leaves the catalog.
            // The held kind's `advertisedInitData` entry stays untouched on
            // this path — the hold covers the pair.
            if (sourceHolds(statuses[kind]) && support?.[kind] === undefined) return advertised[kind];
            delete advertised[kind];
            delete advertisedInitData[kind];
            return undefined;
          };
          const resolved: ActiveEncodingsFacts = {};
          const camera = resolve('camera');
          const screen = resolve('screen');
          const audio = resolve('audio');
          if (camera) resolved.camera = camera;
          if (screen) resolved.screen = screen;
          if (audio) resolved.audio = audio;

          const text = (config.buildCatalog ?? buildMsfCatalog)(
            catalogInputFor(endpoint, resolved, advertisedInitData)
          );
          if (lastSent && lastSent.publisher === publisher && lastSent.text === text) return;
          lastSent = { publisher, text };
          // The catalog publisher runs groupPerFrame: each send is object 0
          // of a fresh group — every update is a random-access point.
          publisher.send({
            type: 'frame',
            payload: textEncoder.encode(text),
            properties: [],
            keyframe: true,
            timestampUs: 0,
          });
        },
      },
    },
  });
}

export const deriveCatalog = defineBehavior({
  stateKeys: [
    'activeEncodings',
    'endpoint',
    'encoderSupport',
    'encoderInitData',
    'cameraState',
    'screenShareState',
    'micState',
  ],
  contextKeys: ['catalogTrackPublisher'],
  setup: deriveCatalogSetup,
});
