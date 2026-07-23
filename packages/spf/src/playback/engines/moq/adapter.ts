/**
 * Canvas + facade adapter — §6 prototype (1) of the MoQ engine plan.
 *
 * With no `HTMLMediaElement` driving playback, the integration surface
 * synthesizes the parts of the media-element contract the player shell
 * needs: `src`, `preload`, `currentTime`, `duration` (∞ while live),
 * `paused`, `play()`/`pause()`. Rendering happens on a canvas the host
 * attaches; audio through an `AudioContext` the adapter owns (created on
 * `attach` and aligned with the paused flag there, resumed on `play()` —
 * the user-gesture-bound resume is the autoplay-policy gate the engine's
 * capability check calls out).
 *
 * The MediaStreamTrackGenerator bridge (§6 option 2) is the Chromium-only
 * alternative to evaluate against this in the Phase 4 prototype
 * comparison; this facade is the cross-browser default.
 */
import type { Constructor, MixinReturn } from '@videojs/utils/types';
import type { Composition } from '../../../core/composition/create-composition';
import type { AudioContextLike } from '../../actors/dom/audio-renderer';
import {
  createMoqEngine,
  type MoqEngineConfig,
  type MoqEngineContext,
  type MoqEngineSignals,
  type MoqEngineState,
} from './engine';

/**
 * The `AudioContextLike` render seam plus the lifecycle surface the
 * adapter drives (`resume`/`suspend` on play/pause, `close` on destroy).
 * `AudioContext` satisfies it structurally.
 */
export interface MoqAudioContext extends AudioContextLike {
  readonly state: AudioContextState;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Constructor options for {@link MoqMediaMixin} classes, read from the
 * first constructor argument.
 */
export interface MoqMediaOptions {
  /**
   * AudioContext factory seam — injectable like the engine's
   * `createMoqTransport`, so tests can observe resume/suspend alignment
   * without a live audio device. Defaults to `new AudioContext()`.
   */
  createAudioContext?: () => MoqAudioContext;
}

export interface MoqMediaProps {
  src: string;
  preload: '' | 'none' | 'metadata' | 'auto';
  /** Target latency in seconds. */
  targetLatency: number | undefined;
}

export const moqMediaDefaultProps: MoqMediaProps = {
  src: '',
  preload: '',
  targetLatency: undefined,
};

export interface MoqMediaAPI extends MoqMediaProps {
  readonly engine: Composition<MoqEngineState, MoqEngineContext>;
  /** Mount rendering onto a canvas. Replaces any previous surface. */
  attach(surface: HTMLCanvasElement): void;
  detach(): void;
  destroy(): void;
  play(): Promise<void>;
  pause(): void;
  readonly paused: boolean;
  /** Media time from the audio master clock, in seconds. */
  readonly currentTime: number;
  /** Live streams have no bounded duration. */
  readonly duration: number;
  readonly measuredLatency: number | undefined;
}

/**
 * Mixin that adds MoQ playback-engine behavior to any base class,
 * mirroring `SimpleHlsMediaMixin`'s shape. A single engine instance is
 * created at construction and recycled across src changes.
 *
 * @example
 * class MoqMedia extends MoqMediaMixin(class {}) {}
 *
 * const media = new MoqMedia();
 * media.attach(document.querySelector('canvas')!);
 * media.src = 'moqt://relay.example.com/live#msf:live--catalog';
 * await media.play();
 */
export function MoqMediaMixin<Base extends Constructor<object>>(BaseClass: Base): MixinReturn<Base, MoqMediaAPI> {
  class MoqMediaImpl extends BaseClass implements MoqMediaAPI {
    readonly #engine: Composition<MoqEngineState, MoqEngineContext>;
    #signals!: MoqEngineSignals;
    #src = moqMediaDefaultProps.src;
    #preload: MoqMediaProps['preload'] = moqMediaDefaultProps.preload;
    readonly #createAudioContext: () => MoqAudioContext;
    #audioContext: MoqAudioContext | undefined;

    constructor(...args: any[]) {
      super(...args);
      const { createAudioContext } = (args?.[0] ?? {}) as MoqMediaOptions;
      this.#createAudioContext = createAudioContext ?? (() => new AudioContext());
      const config: MoqEngineConfig = {
        onSignalsReady: (refs) => {
          this.#signals = refs;
        },
      };
      this.#engine = createMoqEngine(config);
    }

    get engine(): Composition<MoqEngineState, MoqEngineContext> {
      return this.#engine;
    }

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      if (value === this.#src) return;
      this.#src = value;
      this.#signals.state.paused.set(true);
      this.#signals.state.presentation.set(value ? { url: value } : undefined);
    }

    get preload(): MoqMediaProps['preload'] {
      return this.#preload;
    }

    set preload(value: MoqMediaProps['preload']) {
      this.#preload = value;
      this.#signals.state.preload.set(value === '' ? undefined : value);
    }

    get targetLatency(): number | undefined {
      return this.#signals.state.targetLatency.get();
    }

    set targetLatency(value: number | undefined) {
      this.#signals.state.targetLatency.set(value);
    }

    attach(surface: HTMLCanvasElement): void {
      this.#signals.context.renderSurface.set(surface);
      const audioContext = (this.#audioContext ??= this.#createAudioContext());
      // Align the context with the paused flag: a context created here —
      // outside a user gesture — starts 'suspended' (so a play() that ran
      // before attach() would otherwise stay permanently silent), while
      // one created inside a gesture can start 'running' while paused.
      if (!this.paused && audioContext.state === 'suspended') {
        void audioContext.resume();
      } else if (this.paused && audioContext.state === 'running') {
        void audioContext.suspend();
      }
      this.#signals.context.audioContext.set(audioContext);
    }

    detach(): void {
      this.#signals.context.renderSurface.set(undefined);
      this.#signals.context.audioContext.set(undefined);
    }

    async play(): Promise<void> {
      // The engine-side pause gate: renderers hold their playout rate at 0
      // while set, which is what actually freezes video-only playback.
      this.#signals.state.paused.set(false);
      // The autoplay-policy gate: resuming inside the user gesture that
      // triggered play() is what unlocks the audio clock.
      if (this.#audioContext && this.#audioContext.state === 'suspended') {
        await this.#audioContext.resume();
      }
      this.#signals.state.loadActivated.set(true);
    }

    pause(): void {
      this.#signals.state.paused.set(true);
      void this.#audioContext?.suspend();
    }

    get paused(): boolean {
      // The engine slot is the single source of truth; it starts (and is
      // reset on destroy to) `undefined`, which reads as paused here.
      return this.#signals.state.paused.get() ?? true;
    }

    get currentTime(): number {
      return this.#signals.state.currentTime.get() ?? 0;
    }

    get duration(): number {
      // Playback (subscribe) is live-only in this engine phase.
      return this.#src ? Number.POSITIVE_INFINITY : Number.NaN;
    }

    get measuredLatency(): number | undefined {
      return this.#signals.state.measuredLatency.get();
    }

    destroy(): void {
      void this.#engine.destroy();
      void this.#audioContext?.close();
      this.#audioContext = undefined;
    }
  }

  return MoqMediaImpl as unknown as MixinReturn<Base, MoqMediaAPI>;
}

/** Standalone canvas-facade media object (no host base class). */
export class MoqMediaElement extends MoqMediaMixin(class {}) {}
