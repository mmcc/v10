/**
 * **Publish the MSF catalog for the active encodings.** While a catalog
 * track publisher exists and `state.activeEncodings` + `state.endpoint`
 * describe what is being published, builds the catalog JSON through
 * `config.buildCatalog` (default `buildMsfCatalog`) and sends it as
 * object 0 of a new group on the catalog publisher — re-sending whenever
 * the inputs change identity, so subscribers always have a current,
 * independently parseable catalog at every group boundary.
 *
 * DOM-free pure dispatcher per the setup-actor convention: it reads the
 * publisher slot `setupTrackPublishers` owns and sends frames — it never
 * creates actors. The WebCodecs encoder configs feed the catalog directly:
 * their `codec` fields are already WebCodecs registry strings, which is
 * exactly what MSF §5.2.18 mandates for LOC tracks.
 *
 * Writes no state; context reader only.
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
import { AUDIO_TRACK_NAME, VIDEO_TRACK_NAME } from './setup-track-publishers';

export interface DeriveCatalogState {
  activeEncodings?: ActiveEncodingsFacts;
  endpoint?: PublishEndpoint | undefined;
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

/** Project the active encoder configs onto the catalog builder's input. */
export function catalogInputFor(endpoint: PublishEndpoint, encodings: ActiveEncodingsFacts): MsfCatalogInput {
  const input: MsfCatalogInput = { namespace: endpoint.namespace };
  if (encodings.video) {
    input.video = {
      name: VIDEO_TRACK_NAME,
      codec: encodings.video.codec,
      width: encodings.video.width,
      height: encodings.video.height,
      framerate: encodings.video.framerate,
      bitrate: encodings.video.bitrate,
    };
  }
  if (encodings.audio) {
    input.audio = {
      name: AUDIO_TRACK_NAME,
      codec: encodings.audio.codec,
      samplerate: encodings.audio.sampleRate,
      channelConfig: String(encodings.audio.numberOfChannels),
      bitrate: encodings.audio.bitrate,
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
  };
  context: {
    catalogTrackPublisher: ReadonlySignal<DeriveCatalogContext['catalogTrackPublisher']>;
  };
  config?: DeriveCatalogConfig;
}): Reactor<DeriveCatalogFsmState | 'destroying' | 'destroyed'> {
  return createMachineReactor<DeriveCatalogFsmState>({
    initial: 'idle',
    monitor: () =>
      context.catalogTrackPublisher.get() && state.activeEncodings.get() && state.endpoint.get()
        ? 'publishing-catalog'
        : 'idle',
    states: {
      idle: {},

      'publishing-catalog': {
        // effects (not entry) so an encodings/endpoint/publisher identity
        // change re-sends a current catalog.
        effects: () => {
          const publisher = context.catalogTrackPublisher.get()!;
          const encodings = state.activeEncodings.get()!;
          const endpoint = state.endpoint.get()!;

          const text = (config.buildCatalog ?? buildMsfCatalog)(catalogInputFor(endpoint, encodings));
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
  stateKeys: ['activeEncodings', 'endpoint'],
  contextKeys: ['catalogTrackPublisher'],
  setup: deriveCatalogSetup,
});
