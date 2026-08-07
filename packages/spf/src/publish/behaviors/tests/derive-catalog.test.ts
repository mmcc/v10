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
    encoderSupport: signal<DeriveCatalogState['encoderSupport']>(undefined),
    cameraState: signal<DeriveCatalogState['cameraState']>('idle'),
    screenShareState: signal<DeriveCatalogState['screenShareState']>('idle'),
    micState: signal<DeriveCatalogState['micState']>('idle'),
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

/** Settle window for asserting that nothing further was sent. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function trackNames(message: TrackPublisherMessage): string[] {
  if (message.type !== 'frame') return [];
  const catalog = JSON.parse(new TextDecoder().decode(message.payload));
  return catalog.tracks.map((track: { name: string }) => track.name);
}

describe('deriveCatalog', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('sends the built catalog as a keyframe object when the inputs are ready', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
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

    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    const second = sent[1]!;
    if (second.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(second.payload));
    expect(catalog.tracks.map((track: { name: string }) => track.name)).toEqual(['video', 'audio']);
  });

  it('names the screen track and groups it with camera + audio via renderGroup, not altGroup', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const SCREEN_CONFIG = {
      codec: 'vp8',
      width: 1920,
      height: 1080,
      framerate: 15,
      bitrate: 1_500_000,
    } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, screen: SCREEN_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    if (sent[0]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(catalog.tracks.map((track: { name: string }) => track.name)).toEqual(['video', 'screen', 'audio']);
    for (const track of catalog.tracks) {
      expect(track.renderGroup).toBe(1);
      expect(track.altGroup).toBeUndefined();
    }
  });

  it('holds a kind in the catalog while its source re-acquires (device switch must not flap the catalog)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // A mic device switch: the acquire behavior releases the stream
    // (status back through 'acquiring'), the probe retracts the kind's
    // encoding, and the re-probe restores it once the new device resolves.
    // The MOQT audio track publisher survives the whole transient
    // (`setupTrackPublishers` latches it) — the catalog must not
    // advertise its removal to every subscriber in the meantime.
    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(sent).toHaveLength(1);

    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    state.micState.set('active');
    await settle();
    // Same content — deduplicated, nothing new on the wire.
    expect(sent).toHaveLength(1);
  });

  it('drops the held kind when the switch fails (capture status parks on a terminal state)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(sent).toHaveLength(1);

    // The replacement device was denied: the source is genuinely gone,
    // so the catalog must say so.
    state.micState.set('denied');
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(trackNames(sent[1]!)).toEqual(['video']);
  });

  it('drops a kind whose source was released for real (status idle, no hold)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    state.micState.set('idle');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(trackNames(sent[1]!)).toEqual(['video']);
  });

  it('republishes when a switch resolves to a different config (the live probe beats the held copy)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(sent).toHaveLength(1);

    // The new device probed to mono where the old one was stereo.
    const MONO = { ...AUDIO_CONFIG, numberOfChannels: 1 } as AudioEncoderConfig;
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: MONO });
    state.micState.set('active');
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    if (sent[1]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[1]!.payload));
    const audio = catalog.tracks.find((track: { name: string }) => track.name === 'audio');
    expect(audio.channelConfig).toBe('1');
  });

  it('drops a held kind once its re-probe completes with no supported config (live source, unencodable)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // Device switch: encoding and support retract together (the probe's
    // cleanup clears both) — the joint absence is the held transient.
    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(sent).toHaveLength(1);

    // The new device acquires, but its probe resolves to an empty ladder:
    // a completed verdict, not a transient. Capture status stays 'active'
    // — a live source does not make the track encodable.
    state.micState.set('active');
    state.encoderSupport.set({ audio: [] });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(trackNames(sent[1]!)).toEqual(['video']);
  });

  it('drops a held kind the selection strategy vetoed (support present, encoding withheld)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(sent).toHaveLength(1);

    // The re-probe found support, but `selectEncoderConfig` omitted the
    // kind — a policy veto: publishing without the track is the intended
    // outcome, so the catalog must not keep advertising it.
    state.micState.set('active');
    state.encoderSupport.set({ audio: [AUDIO_CONFIG] });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(trackNames(sent[1]!)).toEqual(['video']);
  });

  it('a replaced catalog publisher does not inherit held kinds from the departed session', async () => {
    const first = makePublisherStub();
    const second = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.micState.set('active');
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(first.publisher);
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(1);
    });

    // Mid-switch hold on the old publisher...
    state.micState.set('acquiring');
    state.activeEncodings.set({ camera: VIDEO_CONFIG });
    await settle();
    expect(first.sent).toHaveLength(1);

    // ...then the session rebuilds. The new cluster re-latches its
    // per-kind PUBLISHes from the current encodings, which do not include
    // audio — a catalog holding it would name a track the new session has
    // never published.
    context.catalogTrackPublisher.set(second.publisher);
    await vi.waitFor(() => {
      expect(second.sent).toHaveLength(1);
    });
    expect(trackNames(second.sent[0]!)).toEqual(['video']);
  });

  it('a rebuilt catalog publisher receives the current catalog even when its content is unchanged', async () => {
    const first = makePublisherStub();
    const second = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(first.publisher);
    await vi.waitFor(() => {
      expect(first.sent).toHaveLength(1);
    });

    // Session rebuild: same catalog content, but a brand-new track on the
    // wire — content dedupe must be per publisher, not global.
    context.catalogTrackPublisher.set(second.publisher);
    await vi.waitFor(() => {
      expect(second.sent).toHaveLength(1);
    });
    if (first.sent[0]!.type !== 'frame' || second.sent[0]!.type !== 'frame') return;
    expect(new TextDecoder().decode(second.sent[0]!.payload)).toBe(new TextDecoder().decode(first.sent[0]!.payload));
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
