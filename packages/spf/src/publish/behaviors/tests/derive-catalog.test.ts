import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../core/signals/primitives';
import type { TrackPublisherActor, TrackPublisherMessage } from '../../actors/track-publisher';
import { type DeriveCatalogContext, type DeriveCatalogState, deriveCatalog } from '../derive-catalog';

const ENDPOINT = { url: 'https://relay.example.com/moq', namespace: ['live', 'abc123'] };

const VIDEO_CONFIG = { codec: 'vp8', width: 640, height: 480, framerate: 30, bitrate: 1_000_000 } as VideoEncoderConfig;
const AUDIO_CONFIG = { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 128_000 } as AudioEncoderConfig;

const disposals: (() => void)[] = [];

function makePublisherStub() {
  const sent: TrackPublisherMessage[] = [];
  const publisher = {
    send: (message: TrackPublisherMessage) => sent.push(message),
    destroy: () => undefined,
  } as unknown as TrackPublisherActor;
  return { publisher, sent };
}

function setupBehavior(buildCatalog?: (input: unknown) => string) {
  const state = {
    activeEncodings: signal<DeriveCatalogState['activeEncodings']>(undefined),
    endpoint: signal<DeriveCatalogState['endpoint']>(undefined),
  };
  const context = {
    catalogTrackPublisher: signal<DeriveCatalogContext['catalogTrackPublisher']>(undefined),
  };
  const reactor = deriveCatalog.setup({
    state,
    context,
    config: buildCatalog ? { buildCatalog: buildCatalog as never } : {},
  });
  disposals.push(() => reactor.destroy());
  return { state, context };
}

describe('deriveCatalog', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('sends the built catalog as a keyframe object when the inputs are ready', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ video: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    const message = sent[0]!;
    expect(message.type).toBe('frame');
    if (message.type !== 'frame') return;
    expect(message.keyframe).toBe(true);
    expect(message.properties).toEqual([]);

    const catalog = JSON.parse(new TextDecoder().decode(message.payload));
    expect(catalog.version).toBe('draft-01');
    expect(catalog.tracks).toEqual([
      {
        namespace: 'live/abc123',
        packaging: 'loc',
        isLive: true,
        name: 'video',
        role: 'video',
        codec: 'vp8',
        width: 640,
        height: 480,
        framerate: 30,
        bitrate: 1_000_000,
      },
      {
        namespace: 'live/abc123',
        packaging: 'loc',
        isLive: true,
        name: 'audio',
        role: 'audio',
        codec: 'opus',
        samplerate: 48_000,
        channelConfig: '2',
        bitrate: 128_000,
      },
    ]);
  });

  it('re-sends the catalog when the encodings change identity', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    state.activeEncodings.set({ video: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    const second = sent[1]!;
    if (second.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(second.payload));
    expect(catalog.tracks.map((track: { name: string }) => track.name)).toEqual(['video', 'audio']);
  });

  it('routes through the buildCatalog config seam', async () => {
    const buildCatalog = vi.fn().mockReturnValue('{"version":"draft-01","tracks":[]}');
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior(buildCatalog);

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(buildCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: ENDPOINT.namespace, audio: expect.objectContaining({ codec: 'opus' }) })
    );
    if (sent[0]!.type !== 'frame') return;
    expect(new TextDecoder().decode(sent[0]!.payload)).toBe('{"version":"draft-01","tracks":[]}');
  });
});
