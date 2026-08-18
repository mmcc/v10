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

function setupBehavior(buildCatalog?: (input: unknown) => string, dataTracks?: { name: string; role?: string }[]) {
  const state = {
    activeEncodings: signal<DeriveCatalogState['activeEncodings']>(undefined),
    endpoint: signal<DeriveCatalogState['endpoint']>(undefined),
    encoderSupport: signal<DeriveCatalogState['encoderSupport']>(undefined),
    encoderInitData: signal<DeriveCatalogState['encoderInitData']>(undefined),
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
    config: {
      ...(buildCatalog ? { buildCatalog: buildCatalog as never } : {}),
      ...(dataTracks ? { dataTracks } : {}),
    },
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

  it('publishes reported init data as initDataList + initRef (the channel non-property-reading consumers get)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const H264_CONFIG = { codec: 'avc1.42E01F', width: 1280, height: 720, bitrate: 2_500_000 } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: H264_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    // Before the first encoded output reports the avcC, an AVCC track is
    // an undecodable declaration — it must not be advertised yet.
    if (sent[0]!.type !== 'frame') return;
    const initial = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(initial.tracks).toEqual([]);
    expect(initial.initDataList).toBeUndefined();

    // The camera encoder reports its avcC on the first encoded output —
    // the track and its init data appear as one complete pair.
    const avcC = Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff]);
    state.encoderInitData.set({ camera: avcC });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    if (sent[1]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[1]!.payload));
    expect(catalog.tracks[0].name).toBe('video');
    expect(catalog.tracks[0].initRef).toBe('video-init');
    expect(catalog.initDataList).toEqual([{ id: 'video-init', type: 'inline', data: btoa('\x01\x42\xc0\x1e\xff') }]);
  });

  it('declares the profile/level the encoder emitted, not the one the config requested', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    // Requested constrained-baseline 3.1 (42E01F)…
    const H264_CONFIG = { codec: 'avc1.42E01F', width: 1280, height: 720 } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: H264_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // …but the encoder's avcC says baseline 3.0 (42C01E). The catalog's
    // codec string is a consumer's only pre-decode capability check, so
    // it must describe the stream on the wire.
    state.encoderInitData.set({ camera: Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff]) });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    if (sent[1]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[1]!.payload));
    expect(catalog.tracks[0].codec).toBe('avc1.42C01E');
  });

  it('declares avc3 for an annexb bitstream — avc1 would promise length prefixes the stream does not have', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const ANNEXB_CONFIG = {
      codec: 'avc1.42E01F',
      width: 1280,
      height: 720,
      avc: { format: 'annexb' },
    } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: ANNEXB_CONFIG });
    context.catalogTrackPublisher.set(publisher);

    // In-band parameter sets: decodable with no description, so the track
    // is advertised immediately — under the fourcc that says so.
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    if (sent[0]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(catalog.tracks[0].codec).toBe('avc3.42E01F');
    expect(catalog.tracks[0].initRef).toBeUndefined();
  });

  it('gates an avc3 AVCC-format track on its init data like avc1 — WebCodecs keeps parameter sets out-of-band', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    // Default (absent) avc format is 'avc': length-prefixed, parameter
    // sets only in the description — undecodable without it, whatever
    // fourcc was requested.
    const AVC3_CONFIG = { codec: 'avc3.42E01F', width: 1280, height: 720 } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: AVC3_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    if (sent[0]!.type !== 'frame') return;
    expect(JSON.parse(new TextDecoder().decode(sent[0]!.payload)).tracks).toEqual([]);

    // Once the avcC lands, the declared string is re-derived from it —
    // out-of-band parameter sets are the avc1 contract.
    state.encoderInitData.set({ camera: Uint8Array.from([0x01, 0x42, 0xc0, 0x1e, 0xff]) });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    if (sent[1]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[1]!.payload));
    expect(catalog.tracks[0].codec).toBe('avc1.42C01E');
    expect(catalog.tracks[0].initRef).toBe('video-init');
  });

  it('declares 48000 for an Opus track whatever the capture rate — the RFC 7845 decode rate, not the encoder input', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    // The probe prefers the capture device's rate when the encoder
    // supports it, so 44100 is a config that really ships.
    const CAPTURE_RATE_OPUS = { codec: 'opus', sampleRate: 44_100, numberOfChannels: 2 } as AudioEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: CAPTURE_RATE_OPUS });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    if (sent[0]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(catalog.tracks[0].samplerate).toBe(48_000);
  });

  it('declares the configured rate for a non-Opus audio track — only Opus mandates a fixed decode rate', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const AAC_CONFIG = { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2 } as AudioEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ audio: AAC_CONFIG });
    // AAC is init-data-gated; supply its AudioSpecificConfig so the track
    // is advertised.
    state.encoderInitData.set({ audio: Uint8Array.from([0x12, 0x10]) });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    if (sent[0]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    expect(catalog.tracks[0].samplerate).toBe(44_100);
  });

  it('advertises a self-describing codec immediately — the complete-pair gate is init-data-requiring only', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();

    state.endpoint.set(ENDPOINT);
    // VP8 + Opus decode with no out-of-band description; waiting for a
    // report that will never come would keep them out of the catalog
    // forever.
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(trackNames(sent[0]!)).toEqual(['video', 'audio']);
  });

  it('holds a kind’s init data through a device switch (initRef must not flap off and back on)', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const AAC_CONFIG = { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 2 } as AudioEncoderConfig;
    const audioSpecificConfig = Uint8Array.from([0x11, 0x90]);

    state.endpoint.set(ENDPOINT);
    state.micState.set('active');
    state.activeEncodings.set({ audio: AAC_CONFIG });
    state.encoderInitData.set({ audio: audioSpecificConfig });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // Device switch: the actor teardown clears the init-data fact and the
    // probe retracts the encoding — the whole advertised pair holds.
    state.micState.set('acquiring');
    state.activeEncodings.set(undefined);
    state.encoderInitData.set(undefined);
    await settle();
    expect(sent).toHaveLength(1);

    // The re-probe resolves to the SAME config (a fresh object, as the
    // probe produces) before the rebuilt actor's first output reports the
    // description again — the held init data bridges that window too.
    state.micState.set('active');
    state.activeEncodings.set({ audio: { ...AAC_CONFIG } });
    await settle();
    expect(sent).toHaveLength(1);

    // The rebuilt codec reports the same extradata: still nothing new.
    state.encoderInitData.set({ audio: Uint8Array.from(audioSpecificConfig) });
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('holds the previous complete pair across a config change until the new config’s init data lands', async () => {
    const { publisher, sent } = makePublisherStub();
    const { state, context } = setupBehavior();
    const H264_CONFIG = { codec: 'avc1.42E01F', width: 1280, height: 720 } as VideoEncoderConfig;

    state.endpoint.set(ENDPOINT);
    state.cameraState.set('active');
    state.activeEncodings.set({ camera: H264_CONFIG });
    state.encoderInitData.set({ camera: Uint8Array.from([0x01, 0x42, 0xc0, 0x1e]) });
    context.catalogTrackPublisher.set(publisher);
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });

    // A new config: the actor rebuilds (fact cleared) and the encoding
    // changes. The old avcC (wrong resolution's SPS) must not describe
    // the new config, and the new config must not be advertised without
    // init data — the previous complete pair stands, so nothing new goes
    // on the wire yet. (Dropping the track instead would end every
    // subscriber's subscription for a one-frame transient.)
    state.encoderInitData.set(undefined);
    state.activeEncodings.set({ camera: { ...H264_CONFIG, width: 640, height: 360 } });
    await settle();
    expect(sent).toHaveLength(1);

    // The new codec reports the new config's extradata — the pair
    // advances atomically: new dimensions and new initRef together.
    const nextAvcC = Uint8Array.from([0x01, 0x42, 0xc0, 0x0d]);
    state.encoderInitData.set({ camera: nextAvcC });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    if (sent[1]!.type !== 'frame') return;
    const next = JSON.parse(new TextDecoder().decode(sent[1]!.payload));
    expect(next.tracks[0].width).toBe(640);
    expect(next.tracks[0].initRef).toBe('video-init');
    expect(next.initDataList).toEqual([{ id: 'video-init', type: 'inline', data: btoa('\x01\x42\xc0\x0d') }]);
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

  it('advertises configured data tracks on every catalog, filtered like the serve registry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    disposals.push(() => warn.mockRestore());
    const { publisher, sent } = makePublisherStub();
    // `catalog` collides with a reserved name and must not be advertised;
    // `ticker` declares a media role, which must not reach the catalog
    // (it would advertise an undecodable renderable track).
    const { state, context } = setupBehavior(undefined, [
      { name: 'overlay', role: 'data' },
      { name: 'catalog' },
      { name: 'ticker', role: 'video' },
    ]);

    state.endpoint.set(ENDPOINT);
    state.activeEncodings.set({ camera: VIDEO_CONFIG, audio: AUDIO_CONFIG });
    context.catalogTrackPublisher.set(publisher);

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(trackNames(sent[0]!)).toEqual(['video', 'audio', 'overlay', 'ticker']);
    if (sent[0]!.type !== 'frame') return;
    const catalog = JSON.parse(new TextDecoder().decode(sent[0]!.payload));
    const overlay = catalog.tracks.find((track: { name: string }) => track.name === 'overlay');
    expect(overlay).toEqual({
      namespace: 'live/abc123',
      packaging: 'loc',
      isLive: true,
      name: 'overlay',
      role: 'data',
    });
    const ticker = catalog.tracks.find((track: { name: string }) => track.name === 'ticker');
    expect(ticker).not.toHaveProperty('role');
    // The drop warnings belong to the serve registry (`setupTrackPublishers`);
    // catalog derivation resolves the same configs silently.
    expect(warn).not.toHaveBeenCalled();

    // The data entry is static — an encodings change re-derives a catalog
    // that still carries it.
    state.activeEncodings.set({ audio: AUDIO_CONFIG });
    state.encoderSupport.set({ audio: [AUDIO_CONFIG] });
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(trackNames(sent[1]!)).toEqual(['audio', 'overlay', 'ticker']);
  });
});
