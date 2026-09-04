/**
 * Machine actor owning one WebCodecs `AudioEncoder`.
 *
 * Specializes the shared encoder-actor core (`encoder-actor.ts` — states, backpressure, counters, LOC packaging, sink)
 * with the audio codec. Audio has no forced-keyframe control (`encode` takes no options and every emitted chunk is
 * independently decodable), so each chunk starts its own MOQT group downstream; a codec `description` (e.g. AAC
 * AudioSpecificConfig — Opus carries none) therefore rides every frame, in the LOC Audio Config property.
 */
import type { EncodedChunkSink, EncoderActor, EncoderActorOptions, EncoderMessage } from './encoder-actor';
import { createEncoderActor } from './encoder-actor';

export type AudioEncoderMessage = EncoderMessage<AudioEncoderConfig, AudioData>;
export type AudioEncoderActor = EncoderActor<AudioEncoderConfig, AudioData>;

export function createAudioEncoderActor(sink: EncodedChunkSink, options: EncoderActorOptions = {}): AudioEncoderActor {
  return createEncoderActor<AudioEncoderConfig, AudioData>({
    ...options,
    track: 'audio',
    sink,
    create: ({ output, error }) => {
      const encoder = new AudioEncoder({ output, error });

      return {
        configure: (config) => encoder.configure(config),
        encode: (data) => encoder.encode(data),
        flush: () => encoder.flush(),
        close: () => {
          if (encoder.state !== 'closed') encoder.close();
        },
        get encodeQueueSize() {
          return encoder.encodeQueueSize;
        },
      };
    },
  });
}
