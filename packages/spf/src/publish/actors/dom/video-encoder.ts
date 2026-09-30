/**
 * Machine actor owning one WebCodecs `VideoEncoder`.
 *
 * Specializes the shared encoder-actor core (`encoder-actor.ts` — states, backpressure, counters, LOC packaging, sink)
 * with the video codec: `encode` forwards the per-frame `keyFrame` flag (the pump behavior forces it on the group
 * cadence so each GoP becomes one MOQT group), and the codec's `decoderConfig.description` (e.g. avcC for `avc`-format
 * H.264) is carried as the LOC Config property on every keyframe.
 */
import type { EncodedChunkSink, EncoderActor, EncoderActorOptions, EncoderMessage } from './encoder-actor';
import { createEncoderActor } from './encoder-actor';

export type VideoEncoderMessage = EncoderMessage<VideoEncoderConfig, VideoFrame>;
export type VideoEncoderActor = EncoderActor<VideoEncoderConfig, VideoFrame>;

export function createVideoEncoderActor(sink: EncodedChunkSink, options: EncoderActorOptions = {}): VideoEncoderActor {
  return createEncoderActor<VideoEncoderConfig, VideoFrame>({
    ...options,
    track: 'video',
    sink,
    create: ({ output, error }) => {
      const encoder = new VideoEncoder({ output, error });

      return {
        configure: (config) => encoder.configure(config),
        encode: (frame, keyFrame) => encoder.encode(frame, { keyFrame }),
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
