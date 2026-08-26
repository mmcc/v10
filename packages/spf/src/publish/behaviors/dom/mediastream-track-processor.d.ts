/**
 * Global type declarations for `MediaStreamTrackProcessor` (mediacapture- transform) — Chromium-only, not yet in TS's
 * DOM lib. Precedent: `media/dom/mse/mediasource.d.ts` for `ManagedMediaSource`.
 */

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }

  interface MediaStreamTrackProcessor<T extends VideoFrame | AudioData = VideoFrame | AudioData> {
    readonly readable: ReadableStream<T>;
  }

  const MediaStreamTrackProcessor:
    | {
        prototype: MediaStreamTrackProcessor;
        new <T extends VideoFrame | AudioData = VideoFrame | AudioData>(
          init: MediaStreamTrackProcessorInit
        ): MediaStreamTrackProcessor<T>;
      }
    | undefined;
}

export {};
