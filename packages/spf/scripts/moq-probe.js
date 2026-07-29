#!/usr/bin/env node

/**
 * Probe a MoQ relay from the command line — no browser.
 *
 * Drives the real MoQ playback engine against a relay and logs each stage:
 * transport connect, MOQT session, catalog resolution, track selection,
 * subscription, and object arrival. Exits non-zero if any stage fails, so it
 * works both as an interactive probe and as a CI check.
 *
 * Usage:
 *   pnpm -F @videojs/spf moq:probe <moqt-url> [options]
 *   pnpm -F @videojs/spf moq:probe 'moqt://relay.example:4443/#msf:live--catalog'
 *
 * Options:
 *   --objects <n>   Stop once N media objects have arrived (default 5)
 *   --timeout <ms>  Give up after this long (default 30000)
 *   --json          Emit newline-delimited JSON events instead of text
 *   --quiet         Suppress the event log; print only the summary
 *
 * Requires the WebTransport packages, which are NOT workspace dependencies —
 * they ship an 11 MB per-platform native binary that every install would
 * otherwise pay for:
 *
 *   pnpm add -w -D @fails-components/webtransport \
 *                 @fails-components/webtransport-transport-http3-quiche
 *
 * TWO ENVIRONMENT CONSTRAINTS, both of which otherwise fail confusingly:
 *
 *   1. The prebuilt HTTP/3 binary links against GLIBC_2.38, so it needs Ubuntu
 *      24.04 (noble) or newer. On 22.04 (jammy, glibc 2.35) the dlopen fails.
 *   2. On that failure @fails-components/webtransport silently falls back to
 *      WebTransport-over-HTTP/2, and its `quicheLoaded` promise still resolves.
 *      A relay speaking only HTTP/3 then just never connects, with nothing
 *      saying why.
 *
 * A preflight import of the native transport turns both into an explicit error
 * before any network work happens.
 *
 * Renderers are deliberately left unwired: `renderSurface` and `audioContext`
 * are never set, so both renderer reactors stay in 'preconditions-unmet' and no
 * WebCodecs object is ever constructed. That is what lets the whole
 * session -> catalog -> selection -> subscribe -> object-delivery path run under
 * plain Node. Setting either would reintroduce the browser requirement this
 * script exists to avoid.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../dist/dev/moq.js');
const WEBTRANSPORT_MODULE = '@fails-components/webtransport';
const QUICHE_MODULE = '@fails-components/webtransport-transport-http3-quiche';

// ============================================================================
// Args
// ============================================================================

const argv = process.argv.slice(2);

function flag(name, fallback) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : Number(argv[at + 1]);
}

const url = argv.find((arg) => !arg.startsWith('--') && !/^\d+$/.test(arg));
const wantObjects = flag('--objects', 5);
const timeoutMs = flag('--timeout', 30_000);
const asJson = argv.includes('--json');
const quiet = argv.includes('--quiet');

if (!url || argv.includes('--help') || argv.includes('-h')) {
  console.log(
    [
      'Usage: pnpm -F @videojs/spf moq:probe <moqt-url> [options]',
      '',
      '  --objects <n>   Stop once N media objects have arrived (default 5)',
      '  --timeout <ms>  Give up after this long (default 30000)',
      '  --json          Emit newline-delimited JSON events',
      '  --quiet         Print only the summary',
    ].join('\n')
  );
  process.exit(url ? 0 : 2);
}

// ============================================================================
// Logging
// ============================================================================

const t0 = Date.now();
const events = [];

function emit(stage, detail = '', data = {}) {
  const at = Date.now() - t0;
  events.push({ at, stage, detail, ...data });
  if (quiet) return;
  if (asJson) {
    console.log(JSON.stringify({ at, stage, detail, ...data }));
    return;
  }
  console.log(`[${String(at).padStart(6)}ms] ${stage.padEnd(10)} ${detail}`);
}

function fail(message, hint) {
  console.error(`\n✗ ${message}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

// ============================================================================
// Preconditions
// ============================================================================

if (!existsSync(DIST)) {
  fail(`SPF is not built — ${DIST} is missing.`, 'Run: pnpm -F @videojs/spf build');
}

const { createMoqEngine } = await import(DIST);

let WebTransport;
try {
  ({ WebTransport } = await import(WEBTRANSPORT_MODULE));
} catch (error) {
  fail(
    `Cannot load ${WEBTRANSPORT_MODULE}: ${error.message}`,
    'Install it (not a workspace dependency — it carries a native binary):\n' +
      '  pnpm add -w -D @fails-components/webtransport \\\n' +
      '                @fails-components/webtransport-transport-http3-quiche'
  );
}

// Preflight the native HTTP/3 transport before touching the network. Awaiting the
// import here does double duty: it surfaces a dlopen failure with the real cause
// (instead of a 30s catalog timeout further down), and it removes the race where
// constructing a WebTransport too early throws "Lib quiche loading attempt did
// not end".
//
// Verified signals on a glibc-2.35 host, where the binary cannot load:
//   this import       -> throws ERR_DLOPEN_FAILED with the glibc version
//   `quicheLoaded`    -> RESOLVES anyway
//   supportsReliableOnly -> not yet meaningful at construction time
// So this is the check. Do not "simplify" it to `quicheLoaded`.
try {
  await import(QUICHE_MODULE);
} catch (error) {
  const detail = String(error.message).split('\n')[0];
  fail(
    `The native HTTP/3 transport failed to load — ${error.code ?? 'error'}.`,
    `${detail}\n\n` +
      '  Without it, WebTransport silently falls back to HTTP/2 and a relay that\n' +
      '  speaks only HTTP/3 will never connect. The prebuilt binary needs\n' +
      '  glibc >= 2.38 (Ubuntu 24.04 "noble" or newer).'
  );
}

// ============================================================================
// Probe
// ============================================================================

const until = async (predicate, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

let transport;
let signals;

const engine = createMoqEngine({
  createMoqTransport: (connectUrl, protocols) => {
    emit('CONNECT', `${connectUrl} protocols=[${protocols.join(', ')}]`);
    transport = new WebTransport(connectUrl, { protocols });
    return { transport, ready: transport.ready.then(() => undefined) };
  },
  onSignalsReady: (refs) => {
    signals = refs;
  },
});

const frames = [];
let exitCode = 0;

try {
  emit('START', url);
  signals.state.presentation.set({ url });
  signals.state.loadActivated.set(true);

  const resolved = await until(() => !!signals.state.presentation.get()?.selectionSets, timeoutMs);
  if (!resolved) {
    fail(
      `Catalog did not resolve within ${timeoutMs}ms.`,
      'The relay connected but served no usable catalog. Confirm it publishes a\n' +
        '  draft-ietf-moq-msf-01 catalog track, and that the URL fragment names it\n' +
        `  (e.g. #msf:live--catalog). Events so far: ${events.length}`
    );
  }

  const presentation = signals.state.presentation.get();
  const trackIds = [];
  for (const set of presentation.selectionSets ?? []) {
    for (const switchingSet of set.switchingSets) {
      for (const track of switchingSet.tracks) trackIds.push(track.id);
    }
  }
  emit('CATALOG', `${trackIds.length} track(s): ${trackIds.join(', ')}`, { trackIds });

  const videoId = signals.state.selectedVideoTrackId.get();
  const audioId = signals.state.selectedAudioTrackId.get();
  emit('SELECT', `video=${videoId ?? '(none)'} audio=${audioId ?? '(none)'}`, { videoId, audioId });
  if (!videoId && !audioId) fail('Catalog resolved but no track was selected.');

  const subscribed = await until(
    () => !!(signals.context.videoSubscriberActor.get() ?? signals.context.audioSubscriberActor.get()),
    timeoutMs
  );
  if (!subscribed) fail('No subscriber actor was built after selection.');
  emit('SUBSCRIBE', 'subscriber actor built');

  // Drain the jitter buffers. Nothing decodes here, so payloads are opaque —
  // arrival is the signal.
  const drain = () => {
    for (const actor of [signals.context.videoSubscriberActor.get(), signals.context.audioSubscriberActor.get()]) {
      for (let f = actor?.dequeue(); f; f = actor?.dequeue()) {
        frames.push(f);
        emit('OBJECT', `g=${f.groupId} o=${f.objectId} ts=${f.timestampUs}us key=${f.isKey} len=${f.payload.length}`, {
          groupId: f.groupId,
          objectId: f.objectId,
          timestampUs: f.timestampUs,
          isKey: f.isKey,
          bytes: f.payload.length,
        });
      }
    }
  };

  const gotObjects = await until(() => {
    drain();
    return frames.length >= wantObjects;
  }, timeoutMs);

  if (!gotObjects) {
    fail(
      `Subscribed, but only ${frames.length}/${wantObjects} object(s) arrived within ${timeoutMs}ms.`,
      'Selection and subscription succeeded, so this is the relay not publishing\n' +
        '  (or publishing on a different track than the catalog advertises).'
    );
  }

  const keyframes = frames.filter((f) => f.isKey).length;
  const bytes = frames.reduce((sum, f) => sum + f.payload.length, 0);
  console.log(
    `\n✓ ${frames.length} objects (${keyframes} keyframe${keyframes === 1 ? '' : 's'}, ` +
      `${(bytes / 1024).toFixed(1)} KiB) in ${Date.now() - t0}ms`
  );
  if (keyframes === 0) {
    console.log('  note: no keyframe-led object arrived — a decoder could not start from this data');
  }
} catch (error) {
  console.error(`\n✗ ${error?.stack ?? error}`);
  exitCode = 1;
} finally {
  await engine.destroy().catch(() => {});
  try {
    transport?.close();
  } catch {
    // Already closed, or never opened.
  }
  process.exit(exitCode);
}
