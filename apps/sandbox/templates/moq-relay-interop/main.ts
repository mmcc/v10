// MoQ (draft-ietf-moq-transport-20 / MSF) relay interop smoke test.
// http://localhost:5173/moq-relay-interop/
//
// Query params:
//   src=<moqt://...>   Override the default relay.mux.dev test stream

import '@videojs/html/media/simple-moq-video';
import { effect } from '@videojs/spf';
import { isResolvedPresentation } from '@videojs/spf/moq';

const DEFAULT_SRC = 'moqt://relay.mux.dev/#msf:anon--catalog';
const params = new URLSearchParams(window.location.search);
const initialSrc = params.get('src') ?? DEFAULT_SRC;

const video = document.querySelector('simple-moq-video')!;
const srcInput = document.getElementById('src-input') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement;
const muteToggle = document.getElementById('mute-toggle') as HTMLInputElement;
const stateDiv = document.getElementById('state') as HTMLDivElement;
const logsDiv = document.getElementById('logs') as HTMLDivElement;

srcInput.value = initialSrc;
video.muted = muteToggle.checked;

function log(msg: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const timestamp = new Date().toLocaleTimeString();

  console.log(`[moq] ${msg}`);
  const div = document.createElement('div');

  div.className = type;
  div.textContent = `[${timestamp}] ${msg}`;
  logsDiv.appendChild(div);
  logsDiv.scrollTop = logsDiv.scrollHeight;
}

// The engine has no error slot yet (transport/codec/catalog failures are
// only console.error'd — see the <simple-moq-video> mount warning), so
// mirror console output into the panel rather than requiring devtools.
const originalConsoleError = console.error.bind(console);

console.error = (...args: unknown[]) => {
  originalConsoleError(...args);
  log(`console.error: ${args.map(String).join(' ')}`, 'error');
};
const originalConsoleWarn = console.warn.bind(console);

console.warn = (...args: unknown[]) => {
  originalConsoleWarn(...args);
  log(`console.warn: ${args.map(String).join(' ')}`, 'warning');
};
window.addEventListener('error', (event) => log(`uncaught error: ${event.error ?? event.message}`, 'error'));
window.addEventListener('unhandledrejection', (event) => log(`unhandled rejection: ${event.reason}`, 'error'));

const MEDIA_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'durationchange',
  'streamtypechange',
  'canplay',
  'canplaythrough',
  'playing',
  'waiting',
  'pause',
  'play',
  'emptied',
  'seeked',
] as const;

for (const type of MEDIA_EVENTS) {
  video.addEventListener(type, () => log(`event: ${type}`));
}

video.addEventListener('error', () => log(`event: error — ${JSON.stringify(video.error)}`, 'error'));

function loadSrc(src: string) {
  log(`loading ${src}`);
  video.src = src;
}

loadBtn.addEventListener('click', () => loadSrc(srcInput.value.trim()));

playBtn.addEventListener('click', async () => {
  try {
    await video.play();
    log('play() resolved', 'success');
  } catch (err) {
    log(`play() rejected: ${err}`, 'error');
  }
});

pauseBtn.addEventListener('click', () => video.pause());

muteToggle.addEventListener('change', () => {
  video.muted = muteToggle.checked;
});

// Connection/catalog/latency state isn't part of the media-element facade —
// reach through `.engine` (the underlying SPF composition) to surface what
// this smoke test needs to diagnose relay interop.
effect(() => {
  const engine = video.engine;
  const status = engine.context.moqSessionActor.get()?.snapshot.get().context.status ?? 'not connected';
  const presentation = engine.state.presentation.get();
  const measuredLatency = engine.state.measuredLatency.get();
  const playoutState = engine.state.playoutState.get();
  const bandwidth = engine.state.bandwidthState.get();

  const presentationLabel = !presentation ? 'none' : isResolvedPresentation(presentation) ? 'resolved' : 'pending';

  stateDiv.textContent = [
    `session:         ${status}`,
    `currentTime:     ${video.currentTime.toFixed(2)}s`,
    `readyState:      ${video.readyState}`,
    `presentation:    ${presentationLabel}`,
    `measuredLatency: ${measuredLatency !== undefined ? `${(measuredLatency * 1000).toFixed(0)}ms` : '—'}`,
    `playoutState:    ${playoutState ?? '—'}`,
    `bandwidth:       ${bandwidth ? `${Math.round(bandwidth.fastEstimate / 1000)}kbps (${bandwidth.bytesSampled}B sampled)` : '—'}`,
  ].join('\n');
});

let lastStatus: string | undefined;

effect(() => {
  const snapshot = video.engine.context.moqSessionActor.get()?.snapshot.get();
  const status = snapshot?.context.status;
  if (status === lastStatus) return;

  lastStatus = status;

  if (status === 'ready') log('MOQT session ready', 'success');
  else if (status === 'failed') log(`MOQT session failed: ${snapshot?.context.error}`, 'error');
  else if (status === 'closed') log('MOQT session closed', 'warning');
  else if (status === 'connecting') log('MOQT session connecting…');
});

loadSrc(initialSrc);
