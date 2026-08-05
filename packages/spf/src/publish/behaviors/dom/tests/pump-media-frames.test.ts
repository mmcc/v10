import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '../../../../core/signals/primitives';
import type { AudioEncoderActor } from '../../../actors/dom/audio-encoder';
import type { EncoderActorCounters, EncoderActorUserState } from '../../../actors/dom/encoder-actor';
import { type PumpMediaFramesContext, type PumpMediaFramesState, pumpMediaFrames } from '../pump-media-frames';

/**
 * Source-switch regression coverage for the frame pump: a capture-source
 * switch replaces the `MediaStream` while the audio settings (and
 * possibly the encoder actor) stay identical — the audio read loop must
 * rebind to the NEW stream's track, not keep reading the stopped one.
 */

const disposals: (() => void)[] = [];

/** Chromium's Breakout-Box writable track (pair of the processor the pump uses). */
interface MediaStreamTrackGeneratorLike extends MediaStreamTrack {
  writable: WritableStream<AudioData>;
}
declare const MediaStreamTrackGenerator: new (init: { kind: 'audio' }) => MediaStreamTrackGeneratorLike;

/**
 * Synthesized audio stream via `MediaStreamTrackGenerator` — identical
 * settings across instances, like a camera→screen switch that re-merges
 * the same microphone. Generator-fed so the frames flow deterministically
 * with no capture device or running AudioContext.
 */
async function makeAudioStream(): Promise<MediaStream> {
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
  const writer = generator.writable.getWriter();
  let timestampUs = 0;
  const sampleRate = 48_000;
  const frames = 960; // 20ms
  const pump = setInterval(() => {
    const data = new Float32Array(frames);
    for (let i = 0; i < frames; i++) data[i] = Math.sin((i / frames) * 2 * Math.PI * 8);
    void writer
      .write(
        new AudioData({
          format: 'f32-planar',
          sampleRate,
          numberOfFrames: frames,
          numberOfChannels: 1,
          timestamp: timestampUs,
          data,
        })
      )
      .catch(() => undefined);
    timestampUs += (frames / sampleRate) * 1_000_000;
  }, 20);
  disposals.push(() => {
    clearInterval(pump);
    writer.close().catch(() => undefined);
    generator.stop();
  });
  return new MediaStream([generator]);
}

/** Encoder-actor stand-in that counts and closes delivered frames. */
function makeRecordingAudioActor() {
  const snapshot = signal<{ value: EncoderActorUserState | 'destroyed'; context: EncoderActorCounters }>({
    value: 'encoding',
    context: { encodedFrames: 0, encodedBytes: 0, droppedFrames: 0, keyframes: 0, lastTimestampUs: Number.NaN },
  });
  let received = 0;
  const actor: AudioEncoderActor = {
    get snapshot() {
      return snapshot;
    },
    send(message) {
      if (message.type !== 'encode') return;
      received++;
      message.frame.close();
    },
    destroy() {
      snapshot.set({ ...snapshot.get(), value: 'destroyed' });
    },
  };
  return { actor, receivedFrames: () => received };
}

function setupBehavior() {
  const state = {
    publishError: signal<PumpMediaFramesState['publishError']>(undefined),
  };
  const context = {
    captureStream: signal<PumpMediaFramesContext['captureStream']>(undefined),
    videoEncoderActor: signal<PumpMediaFramesContext['videoEncoderActor']>(undefined),
    audioEncoderActor: signal<PumpMediaFramesContext['audioEncoderActor']>(undefined),
  };
  const reactor = pumpMediaFrames.setup({ state, context, config: {} });
  disposals.push(() => reactor.destroy());
  return { state, context, reactor };
}

describe('pumpMediaFrames', () => {
  afterEach(() => {
    for (const dispose of disposals.splice(0)) dispose();
  });

  it('rebinds the audio read loop when the stream changes with identical audio settings', async () => {
    const { state, context } = setupBehavior();
    const { actor, receivedFrames } = makeRecordingAudioActor();
    context.audioEncoderActor.set(actor);

    const firstStream = await makeAudioStream();
    context.captureStream.set(firstStream);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (receivedFrames() > 0) {
          clearInterval(poll);
          resolve();
        }
      }, 20);
    });

    // The switch: the old tracks are stopped and a NEW stream (same audio
    // settings, same actor identity) takes the slot — mirroring
    // `acquireCaptureSource`'s release → re-acquire sequence.
    for (const track of firstStream.getTracks()) track.stop();
    const secondStream = await makeAudioStream();
    context.captureStream.set(secondStream);
    // Let the swap settle, then measure fresh: the old track is stopped,
    // so any further frames can only come from the new stream's track.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const baseline = receivedFrames();

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receivedFrames()).toBeGreaterThan(baseline);
    expect(state.publishError.get()).toBeUndefined();
  }, 15_000);

  it('reports a reader failure that lands while the pump is live', async () => {
    const { state, context } = setupBehavior();
    const { actor } = makeRecordingAudioActor();
    context.audioEncoderActor.set(actor);

    // A processor whose readable errors mid-pump — the platform killing
    // the track (device unplugged, OS permission revoke) surfaces exactly
    // here, not as a clean `done`.
    const failure = new Error('track processor exploded');
    const globals = globalThis as Record<string, unknown>;
    const original = globals.MediaStreamTrackProcessor;
    globals.MediaStreamTrackProcessor = class {
      readable = new ReadableStream<AudioData>({
        pull() {
          return Promise.reject(failure);
        },
      });
    };
    disposals.push(() => {
      globals.MediaStreamTrackProcessor = original;
    });

    context.captureStream.set(await makeAudioStream());

    await vi.waitFor(() => {
      expect(state.publishError.get()).toMatchObject({ code: 'encode', cause: failure });
    });
  }, 15_000);

  it('does not report a replaced stream’s late reader failure against the new stream', async () => {
    const { state, context } = setupBehavior();
    const { actor } = makeRecordingAudioActor();
    context.audioEncoderActor.set(actor);

    // First processor: a read we can reject on demand. Later processors
    // (the replacement stream's) read forever without failing.
    let rejectRead: ((error: Error) => void) | undefined;
    const globals = globalThis as Record<string, unknown>;
    const original = globals.MediaStreamTrackProcessor;
    globals.MediaStreamTrackProcessor = class {
      readable = new ReadableStream<AudioData>({
        pull() {
          return new Promise<void>((_, reject) => {
            rejectRead ??= reject;
          });
        },
      });
    };
    disposals.push(() => {
      globals.MediaStreamTrackProcessor = original;
    });

    context.captureStream.set(await makeAudioStream());
    await vi.waitFor(() => {
      expect(rejectRead).toBeDefined();
    });

    // The dying track's rejection and the capture slot moving on land in
    // the same beat — whichever microtask wins, the old pump's failure
    // must not pin an error on the healthy replacement.
    rejectRead!(new Error('old track died late'));
    context.captureStream.set(await makeAudioStream());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.publishError.get()).toBeUndefined();
  }, 15_000);
});
