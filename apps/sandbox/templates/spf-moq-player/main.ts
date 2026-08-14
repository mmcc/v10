import '@app/styles.css';
// MoQ Player sandbox
// http://localhost:5173/spf-moq-player/
//
// `<simple-moq-video>` inside the real `<live-video-player>` shell + skin, so
// the MoQ engine drives actual Video.js controls. Defaults to the in-page
// loopback publisher (`./loopback-relay.ts`) because no public relay serves
// MSF catalogs yet.
//
// Supported query params (unrecognized values fall back to the defaults):
//   relay=<moqt url>     Point at a real relay instead of the loopback. The
//                        '#' needs percent-encoding as %23, or it is read as
//                        the page fragment (which this page puts back).
//   ns=<path>            Compose the source instead of hand-writing it: the
//                        slash-separated broadcast path a relay token is
//                        issued for (e.g. mattypoo/room/42), whose catalog
//                        track is played. relay= then holds just the relay
//                        origin — moqt://, https://, or a bare host
//                        (default moqt://relay.mux.dev).
//   token=<jwt>          Relay auth token. Rides the source's c4m fragment
//                        param, which the engine forwards as the ?jwt=
//                        connect-URL param the relay fleet expects.
//   latency=<seconds>    Initial target latency
//   skin=default|minimal
//   preload=none|metadata|auto
//   muted=true           Start muted
//   autoplay=true        Start playback immediately — video renders right
//                        away; audio joins on the first user gesture
import { SKINS } from '@app/constants';
import { loadVideoSkinTag } from '@app/shared/html/skins';
import { PRELOAD_VALUES, type PreloadValue } from '@app/shared/sandbox-listener';
import type { Skin } from '@app/types';
import '@videojs/html/live-video/player';
import { SimpleMoqVideoElement } from '@videojs/html/media/simple-moq-video';
import { effect, snapshot, untrack } from '@videojs/spf';
import {
  encodeNamespaceName,
  isMoqSourceUrl,
  isResolvedPresentation,
  type MoqSource,
  parseMoqSource,
} from '@videojs/spf/moq';
import { createLoopbackRelay, type LoopbackRelay, unsupportedLoopbackCodecs } from './loopback-relay';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const mount = document.getElementById('player-mount') as HTMLDivElement;
const unsupported = document.getElementById('unsupported') as HTMLDivElement;
const modeBadge = document.getElementById('mode-badge') as HTMLSpanElement;
const relayInput = document.getElementById('relay-input') as HTMLInputElement;
const applyRelayButton = document.getElementById('apply-relay') as HTMLButtonElement;
const useLoopbackButton = document.getElementById('use-loopback') as HTMLButtonElement;
const hostInput = document.getElementById('host-input') as HTMLInputElement;
const pathInput = document.getElementById('path-input') as HTMLInputElement;
const tokenInput = document.getElementById('token-input') as HTMLInputElement;
const composeLoadButton = document.getElementById('compose-load') as HTMLButtonElement;
const trackAutoButton = document.getElementById('track-auto') as HTMLButtonElement;
const trackButtons = document.getElementById('track-buttons') as HTMLSpanElement;
const latencyInput = document.getElementById('latency-input') as HTMLInputElement;
const preloadSelect = document.getElementById('preload-select') as HTMLSelectElement;
const skinSelect = document.getElementById('skin-select') as HTMLSelectElement;
const logsDiv = document.getElementById('logs') as HTMLDivElement;
const capabilitiesBody = document.getElementById('capabilities') as HTMLTableSectionElement;

const PANELS = {
  session: document.getElementById('panel-session') as HTMLDListElement,
  selection: document.getElementById('panel-selection') as HTMLDListElement,
  playout: document.getElementById('panel-playout') as HTMLDListElement,
  renderers: document.getElementById('panel-renderers') as HTMLDListElement,
  publisher: document.getElementById('panel-publisher') as HTMLDListElement,
};

/** The synthesized media events the wrapper's signal→event bridge emits. */
const BRIDGED_EVENTS = [
  'loadstart',
  'emptied',
  'loadedmetadata',
  'durationchange',
  'streamtypechange',
  'targetlivewindowchange',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'seeked',
  'volumechange',
] as const;

// ── State ────────────────────────────────────────────────────────────────────
type Mode = 'loopback' | 'relay';

interface PageState {
  mode: Mode;
  relaySrc: string;
  skin: Skin;
  preload: PreloadValue;
  targetLatency: number;
  muted: boolean;
  autoplay: boolean;
}

const params = new URLSearchParams(window.location.search);

/** Query params are user input: an unrecognized value falls back, never through. */
function oneOf<Value extends string>(raw: string | null, allowed: readonly Value[], fallback: Value): Value {
  return allowed.includes(raw as Value) ? (raw as Value) : fallback;
}

function positiveSeconds(raw: string | null, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A pasted `?relay=moqt://host/path#msf:ns--catalog` loses everything from the
 * `#` onward to the page's own fragment, so an MSF fragment sitting there
 * belongs to the relay URL — put it back rather than fail on a truncated source.
 */
function readRelayParam(): string {
  const relay = params.get('relay') ?? '';
  if (!relay || relay.includes('#')) return relay;
  const hash = window.location.hash;
  return hash.startsWith('#msf:') ? `${relay}${hash}` : relay;
}

/**
 * Whether the engine will accept this source, reported on the page instead of
 * only as a dev warning from inside the engine. Delegates to the engine's own
 * `parseMoqSource` so the page cannot drift from what the pipeline accepts —
 * a hand-rolled approximation would pass URLs the parser then rejects
 * (`#msf:` present but no `--` delimiter, bad escapes, `connection=bogus`, …),
 * which is exactly the empty-player case this guard exists to avoid.
 */
function relayProblem(url: string): string | undefined {
  if (!isMoqSourceUrl(url)) return 'must start with moqt://';
  if (!url.includes('#msf:')) {
    return "is missing its '#msf:<namespace>--<track>' fragment (percent-encode the '#' as %23 in ?relay=)";
  }
  let source: MoqSource;
  try {
    source = parseMoqSource(url);
  } catch (error) {
    return `is not a valid MSF source — ${error instanceof Error ? error.message : String(error)}`;
  }
  // Relay mode mounts the plain element, whose only transport is WebTransport.
  // `createMoqSessionActor` refuses a native-QUIC mandate without a
  // QUIC-capable factory, so accepting one here would mount a dead player.
  if (source.connection === 'quic') {
    return 'mandates a native QUIC connection (connection=q), which a browser cannot provide';
  }
  return undefined;
}

/** Default relay origin for composed sources — matches the publisher sandbox. */
const DEFAULT_RELAY_ORIGIN = 'moqt://relay.mux.dev';

/**
 * Build an MSF catalog URL from the parts a relay token is issued for: a
 * relay origin, a slash-separated broadcast path (the same shape as the
 * publisher sandbox's `?ns=`), and an optional JWT. The token rides the
 * `c4m` fragment parameter, which the engine composes onto the connect URL
 * as `?jwt=` — the only auth carriage the relay fleet accepts (draft-19
 * AUTHORIZATION_TOKEN structures hard-close the session).
 */
function composeMsfSource(origin: string, path: string, token: string): string {
  let base = origin.trim() || DEFAULT_RELAY_ORIGIN;
  // Relay endpoints are usually written down as https:// URLs or bare
  // hosts; the moqt form is derivable from either, so accept all three.
  base = base.replace(/^https:\/\//, 'moqt://');
  if (!base.includes('://')) base = `moqt://${base}`;
  if (base.includes('#')) {
    throw new Error('the relay origin already has a fragment — pass a bare origin and put the path in the path field');
  }
  const parsed = new URL(base);
  if (parsed.protocol !== 'moqt:') throw new Error(`not a relay origin this engine can dial: ${origin.trim()}`);
  // moqt: is not a URL special scheme, so an origin without a path keeps an
  // empty pathname instead of gaining '/' — normalize before appending.
  if (parsed.pathname === '') parsed.pathname = '/';
  const namespace = path.split('/').filter(Boolean);
  if (namespace.length === 0) throw new Error('the broadcast path is empty');
  const tokenPart = token ? `&c4m=${encodeURIComponent(token)}` : '';
  return `${parsed}#msf:${encodeNamespaceName(namespace, 'catalog')}${tokenPart}`;
}

/**
 * Attach a `?token=` page param to a full `?relay=` URL that carries no auth
 * of its own. Explicit auth already on the URL — a `c4m` fragment param or a
 * `jwt` connect param — wins over the page param.
 */
function withC4mToken(url: string, token: string): string {
  if (!url.includes('#') || /[#&]c4m=/.test(url)) return url;
  if (/[?&]jwt=/.test(url.slice(0, url.indexOf('#')))) return url;
  return `${url}&c4m=${encodeURIComponent(token)}`;
}

const relayParam = readRelayParam();
const nsParam = params.get('ns') ?? '';
const tokenParam = params.get('token') ?? '';

let initialRelaySrc = relayParam;
let composeProblem: string | undefined;
if (nsParam) {
  try {
    initialRelaySrc = composeMsfSource(relayParam, nsParam, tokenParam);
  } catch (error) {
    composeProblem = error instanceof Error ? error.message : String(error);
    initialRelaySrc = '';
  }
} else if (relayParam && tokenParam) {
  initialRelaySrc = withC4mToken(relayParam, tokenParam);
}

const relayParamProblem = initialRelaySrc ? relayProblem(initialRelaySrc) : undefined;

const state: PageState = {
  mode: initialRelaySrc && !relayParamProblem ? 'relay' : 'loopback',
  relaySrc: relayParamProblem ? '' : initialRelaySrc,
  skin: oneOf(params.get('skin'), SKINS, 'default'),
  preload: oneOf(params.get('preload'), PRELOAD_VALUES, 'auto'),
  targetLatency: positiveSeconds(params.get('latency'), 0.5),
  muted: params.get('muted') === 'true',
  autoplay: params.get('autoplay') === 'true',
};

relayInput.value = state.relaySrc;
hostInput.value = nsParam ? relayParam : '';
pathInput.value = nsParam;
tokenInput.value = tokenParam;
latencyInput.value = String(state.targetLatency);
preloadSelect.value = state.preload;
skinSelect.value = state.skin;

// ── Logging ──────────────────────────────────────────────────────────────────
function log(message: string, kind: 'info' | 'event' | 'error' = 'info'): void {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  logsDiv.append(line);
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

// ── Loopback wiring ──────────────────────────────────────────────────────────
// One relay per mount. The element is constructed by the browser with no
// arguments, so the subclass reads whichever relay the current mount created.
let activeRelay: LoopbackRelay | undefined;

// Not `static tagName` — the base class pins that to its own literal type.
const LOOPBACK_TAG = 'loopback-moq-video';

class LoopbackMoqVideoElement extends SimpleMoqVideoElement {
  constructor() {
    super({
      engineConfig: {
        createMoqTransport: (connectUrl: string, protocols: string[]) => {
          if (!activeRelay) throw new Error('loopback relay is not running');
          return activeRelay.createMoqTransport(connectUrl, protocols);
        },
      },
    });
  }
}

customElements.define(LOOPBACK_TAG, LoopbackMoqVideoElement);

// ── Capability probe ─────────────────────────────────────────────────────────
// Mirrors `@videojs/core`'s `isMedia*Capable` predicates (internal to core):
// each store feature attaches only when the media exposes its properties, so
// this is the readout of which controls can do anything at all. The real
// predicates also reject core's empty sentinels; nothing here defines those
// properties at all, so presence is enough.
interface CapabilityProbe {
  capability: string;
  ui: string;
  probe: (media: Record<string, unknown>) => boolean;
}

const defined = (value: unknown) => value !== undefined;

const CAPABILITIES: CapabilityProbe[] = [
  {
    capability: 'pause',
    ui: 'Play/pause button, tap gesture, Space & k hotkeys',
    probe: (m) => defined(m.paused) && defined(m.ended) && typeof m.pause === 'function',
  },
  {
    capability: 'source',
    ui: 'Load lifecycle, poster teardown',
    probe: (m) => defined(m.src) && defined(m.currentSrc) && defined(m.readyState) && typeof m.load === 'function',
  },
  {
    capability: 'seek',
    ui: 'Time display, seeking',
    probe: (m) => defined(m.currentTime) && defined(m.duration) && defined(m.seeking),
  },
  {
    capability: 'volume',
    ui: 'Mute button, volume slider, m & arrow hotkeys',
    probe: (m) => defined(m.volume) && defined(m.muted),
  },
  { capability: 'stream-type', ui: 'Live vs on-demand chrome', probe: (m) => defined(m.streamType) },
  {
    capability: 'live',
    ui: 'LIVE badge, live-edge button',
    probe: (m) => defined(m.liveEdgeStart) && defined(m.targetLiveWindow),
  },
  {
    capability: 'video-dimensions',
    ui: 'Quality readout',
    probe: (m) => defined(m.videoWidth) && defined(m.videoHeight),
  },
  { capability: 'error', ui: 'Error dialog', probe: (m) => defined(m.error) },
  {
    capability: 'buffer',
    ui: 'Progress-bar buffered range, buffering indicator',
    probe: (m) => defined(m.buffered) && defined(m.seekable),
  },
  { capability: 'playback-rate', ui: 'Playback-speed menu', probe: (m) => defined(m.playbackRate) },
  { capability: 'text-tracks', ui: 'Captions button + menu', probe: (m) => defined(m.textTracks) },
  { capability: 'video-renditions', ui: 'Quality menu', probe: (m) => defined(m.videoRenditions) },
  { capability: 'audio-tracks', ui: 'Audio-track menu', probe: (m) => defined(m.audioTracks) },
  {
    capability: 'remote-playback',
    ui: 'Cast & AirPlay buttons',
    probe: (m) => typeof m.remote === 'object' && m.remote !== null,
  },
];

function renderCapabilities(media: SimpleMoqVideoElement): void {
  const probeTarget = media as unknown as Record<string, unknown>;
  capabilitiesBody.replaceChildren(
    ...CAPABILITIES.map(({ capability, ui, probe }) => {
      const claimed = probe(probeTarget);
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = capability;
      const status = document.createElement('td');
      status.className = `state ${claimed ? 'ok' : 'bad'}`;
      status.textContent = claimed ? 'claimed' : 'unclaimed';
      const description = document.createElement('td');
      description.textContent = ui;
      row.append(name, status, description);
      return row;
    })
  );
}

// ── Panels ───────────────────────────────────────────────────────────────────
function renderRows(target: HTMLDListElement, rows: [label: string, value: string][]): void {
  target.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.title = value;
      row.append(dt, dd);
      return row;
    })
  );
}

function formatSeconds(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(2)}s`;
}

function formatBitrate(bps: number | undefined): string {
  if (bps === undefined) return '—';
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} Kbps`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

function renderPanels(media: SimpleMoqVideoElement): void {
  const engineState = snapshot(media.engine.state);
  const engineContext = snapshot(media.engine.context);

  const session = engineContext.moqSessionActor?.snapshot.get().context;
  renderRows(PANELS.session, [
    ['status', session?.status ?? 'no session'],
    ['goaway', session?.goaway ? 'announced' : '—'],
    ['error', session?.error ? String(session.error) : '—'],
    ['preload gate', engineState.loadActivated ? 'activated' : `preload=${engineState.preload ?? 'default'}`],
  ]);

  const presentation = engineState.presentation;
  const resolved = isResolvedPresentation(presentation);
  const videoTracks = presentation?.selectionSets?.find((set) => set.type === 'video')?.switchingSets[0]?.tracks ?? [];
  const audioTracks = presentation?.selectionSets?.find((set) => set.type === 'audio')?.switchingSets[0]?.tracks ?? [];
  renderRows(PANELS.selection, [
    ['catalog', resolved ? 'resolved' : 'pending'],
    ['video tracks', String(videoTracks.length)],
    ['audio tracks', String(audioTracks.length)],
    ['selected video', engineState.selectedVideoTrackId ?? '—'],
    ['selected audio', engineState.selectedAudioTrackId ?? '—'],
    ['bandwidth est.', formatBitrate(engineState.bandwidthState?.fastEstimate)],
  ]);

  renderRows(PANELS.playout, [
    ['paused', String(media.paused)],
    ['readyState', String(media.readyState)],
    ['currentTime', formatSeconds(engineState.currentTime)],
    ['target latency', formatSeconds(engineState.targetLatency)],
    ['measured latency', formatSeconds(engineState.measuredLatency)],
    ['playout rate', engineState.playoutRate?.toFixed(3) ?? '—'],
    ['playout state', engineState.playoutState ?? '—'],
  ]);

  const video = engineContext.videoRendererActor?.snapshot.get().context;
  const audio = engineContext.audioRendererActor?.snapshot.get().context;
  const videoBuffer = engineContext.videoSubscriberActor?.snapshot.get().context;
  const audioBuffer = engineContext.audioSubscriberActor?.snapshot.get().context;
  renderRows(PANELS.renderers, [
    ['video', video ? `${video.status} · ${video.framesDecoded} decoded · ${video.framesDropped} dropped` : '—'],
    ['video buffer', videoBuffer ? `${videoBuffer.frameCount} frames` : '—'],
    ['audio', audio ? `${audio.status} · ${audio.framesScheduled} scheduled` : '—'],
    ['audio buffer', audioBuffer ? `${audioBuffer.frameCount} frames` : '—'],
    ['canvas', `${media.videoWidth}×${media.videoHeight}`],
  ]);

  if (state.mode === 'loopback' && activeRelay) {
    const { subscriptions, objectsPublished, bytesPublished } = activeRelay.stats;
    renderRows(PANELS.publisher, [
      ['mode', 'loopback (in-page)'],
      ['subscribed', subscriptions.length ? subscriptions.join(', ') : 'none'],
      ['objects', String(objectsPublished)],
      ['published', formatBytes(bytesPublished)],
    ]);
  } else {
    renderRows(PANELS.publisher, [
      ['mode', 'remote relay'],
      ['url', state.relaySrc],
    ]);
  }
}

// ── Rendition buttons ────────────────────────────────────────────────────────
function renderTrackButtons(media: SimpleMoqVideoElement): void {
  const presentation = media.engine.state.presentation.get();
  const tracks = presentation?.selectionSets?.find((set) => set.type === 'video')?.switchingSets[0]?.tracks ?? [];

  trackButtons.replaceChildren(
    ...tracks.map((track) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = track.width && track.height ? `${track.width}×${track.height}` : track.id;
      button.dataset.trackId = track.id;
      button.addEventListener('click', () => {
        media.engine.state.userVideoTrackSelection.set({ id: track.id });
        log(`user selected video track ${track.id}`);
        syncTrackButtons(media);
      });
      return button;
    })
  );

  syncTrackButtons(media);
}

function syncTrackButtons(media: SimpleMoqVideoElement): void {
  const selectedId = untrack(() => media.engine.state.userVideoTrackSelection.get())?.id;
  trackAutoButton.setAttribute('aria-pressed', String(!selectedId));
  for (const button of trackButtons.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.trackId === selectedId));
  }
}

// ── Mount ────────────────────────────────────────────────────────────────────
let teardown: (() => void) | undefined;

/**
 * Bumped on every `render()` entry — including the ones that bail early on
 * missing APIs — so a call still awaiting its skin import cannot resume and
 * mount over a newer decision (or into a mode that was just rejected).
 */
let renderGeneration = 0;

function currentSrc(): string {
  return state.mode === 'loopback' ? (activeRelay?.src ?? '') : state.relaySrc;
}

function unmount(): void {
  // `teardown` destroys the relay it captured; clearing the module reference
  // too keeps a torn-down relay from outliving its player.
  teardown?.();
  teardown = undefined;
  activeRelay = undefined;
  mount.replaceChildren();
  // The rendition buttons close over the media element, so they have to go
  // with it — otherwise they stay clickable and write to a destroyed engine
  // until the next catalog resolves and rebuilds them.
  trackButtons.replaceChildren();
  trackAutoButton.setAttribute('aria-pressed', 'true');
}

async function render(): Promise<void> {
  const generation = ++renderGeneration;

  // Re-checked per render, not once at boot: what's required depends on the
  // mode, and the mode is switchable at runtime.
  const missing = await missingSupport(state.mode);
  // The codec probe awaits, so this is a suspension point like the skin load.
  if (generation !== renderGeneration) return;
  if (missing.length > 0) {
    unmount();
    unsupported.hidden = false;
    unsupported.textContent = `This browser cannot run: ${missing.join(', ')}. MoQ playback needs all of them.`;
    return;
  }
  unsupported.hidden = true;

  let skinTag: string;
  try {
    skinTag = await loadVideoSkinTag(state.skin, 'css', { live: true });
  } catch (error) {
    log(`failed to load the ${state.skin} skin: ${String(error)}`, 'error');
    return;
  }
  // A newer render() superseded this one while the skin loaded.
  if (generation !== renderGeneration) return;

  unmount();

  if (state.mode === 'loopback') {
    activeRelay = createLoopbackRelay({ onLog: (message) => log(`relay: ${message}`) });
    modeBadge.textContent = 'loopback';
    modeBadge.classList.remove('relay');
  } else {
    modeBadge.textContent = 'relay';
    modeBadge.classList.add('relay');
  }

  const player = document.createElement('live-video-player');
  const skin = document.createElement(skinTag);
  const tagName = state.mode === 'loopback' ? LOOPBACK_TAG : SimpleMoqVideoElement.tagName;
  const media = document.createElement(tagName) as SimpleMoqVideoElement;

  media.setAttribute('preload', state.preload);
  if (state.muted) media.setAttribute('muted', '');
  if (state.autoplay) media.setAttribute('autoplay', '');
  media.setAttribute('target-latency', String(state.targetLatency));

  skin.append(media);
  player.append(skin);
  mount.append(player);

  // Before the source: the `src` setter dispatches the load cycle
  // (`loadstart`, `durationchange`, `streamtypechange`,
  // `targetlivewindowchange`) synchronously, and that lifecycle is the point
  // of the event log — listeners attached afterward would miss all of it.
  connectDiagnostics(media);

  // Assigned after connection so the engine sees a mounted render surface, and
  // as a property so relay URLs need no attribute escaping.
  media.src = currentSrc();

  log(`mounted ${tagName} in <live-video-player>/<${skinTag}> — src ${media.src}`);
}

function connectDiagnostics(media: SimpleMoqVideoElement): void {
  const disposers: (() => void)[] = [];

  for (const type of BRIDGED_EVENTS) {
    const handler = () => log(`event: ${type}`, 'event');
    media.addEventListener(type, handler);
    disposers.push(() => media.removeEventListener(type, handler));
  }

  // Catalog changes are rare; the rest of the panels poll because renderer
  // counters move every frame and a UI panel wants a fixed cadence. Only
  // `presentation` should re-trigger this, so the rebuild reads untracked.
  disposers.push(
    effect(() => {
      const resolved = isResolvedPresentation(media.engine.state.presentation.get());
      if (resolved) untrack(() => renderTrackButtons(media));
    })
  );

  const timer = setInterval(() => renderPanels(media), 250);
  disposers.push(() => clearInterval(timer));

  renderCapabilities(media);
  renderPanels(media);

  const relay = activeRelay;
  teardown = () => {
    for (const dispose of disposers) dispose();
    relay?.destroy();
  };
}

// ── Controls ─────────────────────────────────────────────────────────────────
function mediaElement(): SimpleMoqVideoElement | null {
  return mount.querySelector<SimpleMoqVideoElement>(`${LOOPBACK_TAG}, ${SimpleMoqVideoElement.tagName}`);
}

applyRelayButton.addEventListener('click', () => {
  const value = relayInput.value.trim();
  if (!value) {
    log('enter a moqt:// URL first', 'error');
    return;
  }
  const problem = relayProblem(value);
  if (problem) {
    log(`relay URL ${problem}`, 'error');
    return;
  }
  state.mode = 'relay';
  state.relaySrc = value;
  void render();
});

useLoopbackButton.addEventListener('click', () => {
  state.mode = 'loopback';
  void render();
});

composeLoadButton.addEventListener('click', () => {
  const path = pathInput.value.trim();
  if (!path) {
    log('enter a broadcast path first (e.g. mattypoo/room/42)', 'error');
    return;
  }
  let composed: string;
  try {
    composed = composeMsfSource(hostInput.value, path, tokenInput.value.trim());
  } catch (error) {
    log(`cannot compose a source — ${error instanceof Error ? error.message : String(error)}`, 'error');
    return;
  }
  const problem = relayProblem(composed);
  if (problem) {
    log(`composed URL ${problem}`, 'error');
    return;
  }
  // Shown where it can be copied: the composed URL is exactly what 'Load
  // relay' accepts, so the row doubles as a reference for the MSF format.
  relayInput.value = composed;
  state.mode = 'relay';
  state.relaySrc = composed;
  void render();
});

trackAutoButton.addEventListener('click', () => {
  const media = mediaElement();
  if (!media) return;
  media.engine.state.userVideoTrackSelection.set(undefined);
  log('user selection cleared — back to ABR');
  syncTrackButtons(media);
});

latencyInput.addEventListener('change', () => {
  const value = Number(latencyInput.value);
  if (!Number.isFinite(value) || value <= 0) return;
  state.targetLatency = value;
  mediaElement()?.setAttribute('target-latency', String(value));
  log(`target latency → ${value}s`);
});

preloadSelect.addEventListener('change', () => {
  state.preload = oneOf(preloadSelect.value, PRELOAD_VALUES, state.preload);
  mediaElement()?.setAttribute('preload', state.preload);
  log(`preload → ${state.preload}`);
});

skinSelect.addEventListener('change', () => {
  state.skin = oneOf(skinSelect.value, SKINS, state.skin);
  void render();
});

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Playback needs the WebCodecs decoders in both modes. Everything else is
 * mode-specific: only the in-page publisher encodes and draws offscreen, and
 * only a remote relay needs WebTransport — so a browser that can play a real
 * relay must not be turned away for lacking encoders.
 */
async function missingSupport(mode: Mode): Promise<string[]> {
  const missing: string[] = [];
  if (typeof VideoDecoder === 'undefined' || typeof AudioDecoder === 'undefined') missing.push('WebCodecs decoders');

  if (mode === 'loopback') {
    if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
      missing.push('WebCodecs encoders (loopback publisher)');
    }
    if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas (loopback publisher)');
    // Present constructors don't mean the platform can run these codecs, and
    // a rejected `configure()` would surface only as a stream that never
    // delivers — so probe the exact configurations the publisher uses.
    if (missing.length === 0) missing.push(...(await unsupportedLoopbackCodecs()));
  } else if (typeof WebTransport === 'undefined') {
    missing.push('WebTransport');
  }

  return missing;
}

if (composeProblem) log(`ignoring ?ns= — ${composeProblem}`, 'error');
if (relayParamProblem)
  log(`ignoring ${nsParam ? 'the composed source' : '?relay='} — it ${relayParamProblem}`, 'error');
log(
  state.autoplay
    ? 'autoplay — video starts immediately; audio (the master clock) unlocks on the first gesture'
    : 'press play — the AudioContext (and with it the master clock) resumes on a user gesture'
);
void render();
