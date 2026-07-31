import '@app/styles.css';
// MoQ Publisher sandbox
// http://localhost:5173/moq-publisher/
//
// Renders the real skinned publisher (`<video-publisher>` + `<publisher-skin>`)
// over a media host. The default mode is an end-to-end in-page loopback:
// the real MoQ publish engine (real capture, real WebCodecs encode, real
// draft-19 bytes) publishes into `./loopback-relay.ts`, and a bare
// `<simple-moq-video>` player beside it subscribes and renders the camera
// back — camera in, playback out, one page.
//
//   (default)        loopback: publisher + relay + player side by side
//   ?real            publish to an actual MoQ relay via <moq-publish-video>
//   ?relay=<url>     relay endpoint for ?real (default https://relay.quic.video)
//   ?ns=<namespace>  publish namespace for ?real (default: persisted random name)
//   ?fake            real capture, fake publish transport (FakePublishMedia)
//   ?synthetic       stub getUserMedia with canvas+oscillator capture, so the
//                    demo runs headlessly / without a camera

// Registers video-publisher, publisher-skin, and all publisher UI elements.
import '@videojs/html/publisher/skin';
// Registers moq-publish-video for the `?real` path.
import '@videojs/html/media/moq-publish-video';
import { MediaAttachMixin } from '@videojs/html';
import { SimpleMoqVideoElement } from '@videojs/html/media/simple-moq-video';
import type { MediaPublishStats } from '@videojs/media';
import { CustomMediaElement } from '@videojs/media/dom/custom-media-element';
import { MoqPublishMedia } from '@videojs/media/dom/moq-publish';
import type { MoqPublishMediaOptions } from '@videojs/spf/moq-publish';
import { FakePublishMedia } from './fake-media';
import { createPublisherLoopbackRelay, type PublisherLoopbackRelay } from './loopback-relay';

const html = String.raw;
const input = 'min-w-64 rounded border border-zinc-300 bg-white px-2 py-1';
const button = 'rounded border border-zinc-300 bg-white px-2 py-1 hover:bg-zinc-100';

// ── Mode + settings (query params with localStorage fallback) ───────────────

const DEFAULT_RELAY = 'https://relay.quic.video';
const RELAY_STORAGE_KEY = 'moq-publisher:relay';
const NS_STORAGE_KEY = 'moq-publisher:ns';
/** Namespace the loopback publisher and the relay's `src` agree on. */
const LOOPBACK_NAMESPACE = 'loopback';

const params = new URLSearchParams(window.location.search);
type Mode = 'loopback' | 'real' | 'fake';
const mode: Mode = params.has('real') ? 'real' : params.has('fake') ? 'fake' : 'loopback';

const relay = params.get('relay') || localStorage.getItem(RELAY_STORAGE_KEY) || DEFAULT_RELAY;
const namespace =
  params.get('ns') || localStorage.getItem(NS_STORAGE_KEY) || `vjs-sandbox-${Math.random().toString(36).slice(2, 8)}`;

localStorage.setItem(RELAY_STORAGE_KEY, relay);
localStorage.setItem(NS_STORAGE_KEY, namespace);

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

// ── Synthetic capture (?synthetic) ───────────────────────────────────────────
// Mirrors the SPF browser tests: a canvas-capture video track plus a WebAudio
// oscillator audio track stand in for a camera, so the pipeline is verifiable
// headlessly (fake-device flags often expose no devices at all).

function installSyntheticCapture(): void {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d')!;
    const startedAt = performance.now();
    let frame = 0;
    const interval = setInterval(() => {
      const t = (performance.now() - startedAt) / 1000;
      ctx.fillStyle = '#101014';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = `hsl(${Math.round((t * 90) % 360)} 80% 55%)`;
      ctx.fillRect(((t / 4) % 1) * canvas.width, 0, 40, canvas.height);
      ctx.fillStyle = '#f4f4f5';
      ctx.font = '600 40px monospace';
      ctx.fillText('synthetic', 38, 64);
      ctx.font = '28px monospace';
      ctx.fillText(`${t.toFixed(2)}s #${frame}`, 38, 110);
      frame++;
    }, 1000 / 30);

    const stream = canvas.captureStream(30);
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0.05;
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

    // The host stops tracks to release capture — stop the synthesis with it.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      clearInterval(interval);
      void audioContext.close().catch(() => {});
    });
    return stream;
  };
}

if (params.has('synthetic')) installSyntheticCapture();

// ── Media element definitions ────────────────────────────────────────────────

class FakePublishVideoElement extends MediaAttachMixin(CustomMediaElement('video', FakePublishMedia)) {}

customElements.define('fake-publish-video', FakePublishVideoElement);

// One relay per page load in loopback mode. The elements are constructed by
// the browser with no arguments, so the subclasses read the module ref.
let activeRelay: PublisherLoopbackRelay | undefined;

/**
 * `CustomMediaElement` constructs its host with `new MediaHost()` — no
 * constructor options can flow through the element — so the loopback
 * transport seam is injected by subclassing the host and pre-binding
 * `engineConfig` here. VP8 is preferred over the H.264 default so the
 * loopback player can decode without out-of-band decoder descriptions.
 */
class LoopbackPublishMedia extends MoqPublishMedia {
  constructor() {
    const options: MoqPublishMediaOptions = {
      engineConfig: {
        video: { codec: 'vp8' },
        connectTransport: (endpoint) => {
          if (!activeRelay) throw new Error('loopback relay is not running');
          return activeRelay.connectPublisher(endpoint);
        },
      },
    };
    super(options);
  }
}

const LoopbackPublishVideoBase = MediaAttachMixin(CustomMediaElement('video', LoopbackPublishMedia));

/** Loopback twin of `<moq-publish-video>` — same attribute map, seamed host. */
class LoopbackPublishVideoElement extends LoopbackPublishVideoBase {
  static properties = {
    ...LoopbackPublishVideoBase.properties,
    publishEndpoint: { type: String, attribute: 'publish-endpoint', empty: '' },
    publishNamespace: { type: String, attribute: 'publish-namespace', empty: '' },
    captureSource: { type: String, attribute: 'capture-source', empty: null },
  };
}

customElements.define('loopback-publish-video', LoopbackPublishVideoElement);

/** `<simple-moq-video>` wired to the loopback relay's subscribe side. */
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

customElements.define('loopback-moq-video', LoopbackMoqVideoElement);

// ── Rendering ────────────────────────────────────────────────────────────────

const mediaTag = {
  loopback: html`<loopback-publish-video
    id="media"
    publish-endpoint="moqt://loopback.videojs.test/live"
    publish-namespace="${LOOPBACK_NAMESPACE}"
  ></loopback-publish-video>`,
  real: html`<moq-publish-video
    id="media"
    publish-endpoint="${escapeAttr(relay)}"
    publish-namespace="${escapeAttr(namespace)}"
  ></moq-publish-video>`,
  fake: html`<fake-publish-video id="media"></fake-publish-video>`,
}[mode];

const settingsRow = {
  loopback: html`
    <p class="text-xs text-zinc-500">
      In-page loopback: real publish engine → in-memory relay → real MoQ player. Go live to start playback.
      <a class="underline" href="?real">Real MoQ publish</a> ·
      <a class="underline" href="?fake">Fake publish</a> ·
      <a class="underline" href="?synthetic">Synthetic capture</a>
    </p>
  `,
  real: html`
    <div class="flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1">Relay <input id="relay" class="${input}" value="${escapeAttr(relay)}" spellcheck="false" /></label>
      <label class="flex items-center gap-1">Namespace <input id="ns" class="${input}" value="${escapeAttr(namespace)}" spellcheck="false" /></label>
      <button id="apply" type="button" class="${button}">Apply</button>
    </div>
    <p class="text-xs text-zinc-500">
      Real MoQ publish — if the relay does not speak this draft, "Go live" will surface an error.
      <a class="underline" href="?">Switch to loopback</a>
    </p>
  `,
  fake: html`
    <p class="text-xs text-zinc-500">
      Real capture, fake publish transport.
      <a class="underline" href="?">Switch to loopback</a> ·
      <a class="underline" href="?real">Real MoQ publish</a>
    </p>
  `,
}[mode];

const publisherPane = html`
  <video-publisher>
    <publisher-skin class="aspect-video w-full">${mediaTag}</publisher-skin>
  </video-publisher>
`;

document.getElementById('root')!.innerHTML = html`
  <div class="mx-auto flex w-full ${mode === 'loopback' ? 'max-w-6xl' : 'max-w-3xl'} flex-col gap-3 p-4 font-mono text-sm">
    <h1 class="text-lg font-semibold">MoQ Publisher</h1>
    ${settingsRow}
    ${
      mode === 'loopback'
        ? html`
            <div class="grid gap-3 md:grid-cols-2">
              <div class="flex flex-col gap-1">
                <span class="text-xs text-zinc-500">publisher (capture → encode → MOQT)</span>
                ${publisherPane}
              </div>
              <div class="flex flex-col gap-1">
                <span class="text-xs text-zinc-500">player (&lt;simple-moq-video&gt; ← loopback relay)</span>
                <div class="aspect-video w-full overflow-hidden rounded bg-zinc-950">
                  <loopback-moq-video id="player" muted preload="auto"></loopback-moq-video>
                </div>
              </div>
            </div>
          `
        : publisherPane
    }
    <pre id="status" class="whitespace-pre-wrap rounded bg-zinc-100 p-2 text-xs"></pre>
  </div>
`;

// ── Status panel ─────────────────────────────────────────────────────────────

/** The capability surface the status panel reads; every host implements it. */
type PublisherHostLike = Pick<
  FakePublishMedia,
  'captureSource' | 'captureState' | 'publishState' | 'publishStartedAt' | 'publishError' | 'publishStats'
>;

const el = document.getElementById('media') as HTMLElement & { host: PublisherHostLike };
const media = el.host;
const statusEl = document.getElementById('status') as HTMLPreElement;
const player = document.getElementById('player') as SimpleMoqVideoElement | null;

function formatStats(stats: MediaPublishStats | null): string {
  if (!stats) return '—';
  const sent =
    stats.bytesSent >= 1e6 ? `${(stats.bytesSent / 1e6).toFixed(1)} MB` : `${Math.round(stats.bytesSent / 1e3)} KB`;
  return [
    `${stats.encodedFps} fps`,
    `${(stats.videoBitrate / 1e6).toFixed(2)} Mbps video`,
    `${Math.round(stats.audioBitrate / 1e3)} kbps audio`,
    `${sent} sent`,
    `${stats.droppedFrames} dropped`,
    `subs ${stats.subscriberCount}`,
  ].join(' · ');
}

const modeLabel = {
  loopback: 'loopback (in-page relay)',
  real: `real (${relay} / ${namespace})`,
  fake: 'fake publish',
}[mode];

function renderStatus(): void {
  const source = media.captureSource ? ` (${media.captureSource})` : '';
  const since = Number.isFinite(media.publishStartedAt)
    ? ` since ${new Date(media.publishStartedAt).toLocaleTimeString()}`
    : '';
  const error = media.publishError?.message ?? '';
  const lines = [
    `mode:    ${modeLabel}${params.has('synthetic') ? ' · synthetic capture' : ''}`,
    `capture: ${media.captureState}${source}`,
    `publish: ${media.publishState}${since}`,
    `stats:   ${formatStats(media.publishStats)}`,
  ];
  if (activeRelay) {
    const { publisherState, publishedTracks, subscriptions, objectsReceived, objectsForwarded } = activeRelay.stats;
    lines.push(
      `relay:   publisher ${publisherState} · tracks [${publishedTracks.join(', ')}] · ${objectsReceived} objs in · ${objectsForwarded} out`,
      `         player subs [${subscriptions.join(', ')}]`
    );
  }
  if (player) {
    lines.push(
      `player:  readyState ${player.readyState} · ${player.videoWidth}×${player.videoHeight} · t=${player.currentTime.toFixed(2)}s · ${player.paused ? 'paused' : 'playing'}`
    );
  }
  if (error) lines.push(`error:   ${error}`);
  statusEl.textContent = lines.join('\n');
}

// The custom element bridges host events, so the page listens on the element —
// the same surface the player store uses.
const CAPABILITY_EVENTS = [
  'publishstatechange',
  'capturesourcechange',
  'capturestatechange',
  'capturestreamchange',
  'capturetogglechange',
  'publishstatsupdate',
] as const;

for (const type of CAPABILITY_EVENTS) {
  el.addEventListener(type, renderStatus);
}

// The relay counters and the player clock move continuously — poll too.
if (mode === 'loopback') setInterval(renderStatus, 500);

renderStatus();

// ── Loopback wiring — publish going live starts the player ──────────────────

if (mode === 'loopback' && player) {
  activeRelay = createPublisherLoopbackRelay({
    onLog: (message) => console.info(`[loopback-relay] ${message}`),
  });

  el.addEventListener('publishstatechange', () => {
    if (media.publishState === 'live') {
      // Set on (re-)going live so every publish cycle gets a fresh player
      // session against the relay's latest catalog.
      if (!player.src) player.src = activeRelay!.src;
      void player.play().catch((error) => console.warn('player.play() failed:', error));
    } else if (media.publishState === 'idle' || media.publishState === 'error') {
      if (player.src) player.src = '';
    }
    renderStatus();
  });
}

// ── Real-mode settings wiring ────────────────────────────────────────────────

if (mode === 'real') {
  const relayInput = document.getElementById('relay') as HTMLInputElement;
  const nsInput = document.getElementById('ns') as HTMLInputElement;

  document.getElementById('apply')!.addEventListener('click', () => {
    const nextRelay = relayInput.value.trim() || DEFAULT_RELAY;
    const nextNs = nsInput.value.trim();

    localStorage.setItem(RELAY_STORAGE_KEY, nextRelay);
    localStorage.setItem(NS_STORAGE_KEY, nextNs);

    const next = new URLSearchParams(window.location.search);
    next.set('relay', nextRelay);
    next.set('ns', nextNs);
    window.location.search = next.toString();
  });
}
