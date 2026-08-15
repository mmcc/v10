/**
 * Shared capture + playback harness for the cross-engine suites
 * (`publish/engines/moq/tests/cross-engine*.test.ts`): the synthetic
 * capture device (animated canvas + oscillator audio) and a real playback
 * engine joined to the relay hub's broadcast. Per-suite
 * `getUserMedia`/`getDisplayMedia` stubbing stays in each suite — which
 * pipeline gets which stream (and with what injected skew) is the
 * scenario under test.
 *
 * Helpers register their cleanup on the caller's `disposals` array, the
 * suites' shared teardown idiom (`afterEach` drains it).
 */
// The real playback engine, from the `@videojs/spf/moq` entry module —
// parent-owned reference implementation; used, never modified.
import { createMoqEngine, type MoqEngineSignals } from '../../../../../playback/engines/moq/index';
import type { RelayHub } from '../../../../tests/helpers/relay-hub';

export interface SyntheticStreamSize {
  width: number;
  height: number;
}

/** An animated canvas track, optionally with oscillator audio, standing in for a device. */
export function makeSyntheticStream(
  size: SyntheticStreamSize,
  withAudio: boolean,
  disposals: (() => void)[]
): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d')!;
  let hue = 0;
  const paint = setInterval(() => {
    hue = (hue + 11) % 360;
    context.fillStyle = `hsl(${hue}, 80%, 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  disposals.push(() => clearInterval(paint));
  const stream = canvas.captureStream(30);

  if (withAudio) {
    const audioContext = new AudioContext({ sampleRate: 48_000 });
    disposals.push(() => void audioContext.close().catch(() => undefined));
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.start();
    void audioContext.resume().catch(() => undefined);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }
  return stream;
}

/** A playback engine subscribed to the catalog, with a canvas + audio context wired up. */
export function createSubscriber(hub: RelayHub, disposals: (() => void)[]) {
  let signals!: MoqEngineSignals;
  const player = createMoqEngine({
    createMoqTransport: () => hub.connectSubscriber(),
    onSignalsReady: (refs) => {
      signals = refs;
    },
  });
  disposals.push(() => void player.destroy());

  const canvas = document.createElement('canvas');
  const audioContext = new AudioContext({ sampleRate: 48_000 });
  disposals.push(() => void audioContext.close().catch(() => undefined));
  void audioContext.resume().catch(() => undefined);
  signals.context.renderSurface.set(canvas);
  signals.context.audioContext.set(audioContext);
  signals.state.presentation.set({ url: 'moqt://relay.test/live#msf:live--catalog' });
  signals.state.loadActivated.set(true);

  return { player, signals, canvas };
}
