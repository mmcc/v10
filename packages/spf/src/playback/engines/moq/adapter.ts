/**
 * Canvas + facade adapter — §6 prototype (1) of the MoQ engine plan.
 *
 * With no `HTMLMediaElement` driving playback, the integration surface synthesizes the parts of the media-element
 * contract the player shell needs: `src`, `preload`, `currentTime`, `duration` (∞ while live), `paused`,
 * `play()`/`pause()`. Rendering happens on a canvas the host attaches; audio through an `AudioContext` the adapter owns
 * (created on `attach` and aligned with the paused flag there, resumed on `play()` — the user-gesture-bound resume is
 * the autoplay-policy gate the engine's capability check calls out).
 *
 * The MediaStreamTrackGenerator bridge (§6 option 2) is the Chromium-only alternative to evaluate against this in the
 * Phase 4 prototype comparison; this facade is the cross-browser default.
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
 * The `AudioContextLike` render seam plus the lifecycle surface the adapter drives (`resume`/`suspend` on play/pause,
 * `close` on destroy) and the `createGain` factory backing the facade's `volume`/`muted`. `AudioContext` satisfies it
 * structurally.
 */
export interface MoqAudioContext extends AudioContextLike {
  readonly state: AudioContextState;
  createGain(): GainNode;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/** Constructor options for {@link MoqMediaMixin} classes, read from the first constructor argument. */
export interface MoqMediaOptions {
  /**
   * AudioContext factory seam — injectable like the engine's `createMoqTransport`, so tests can observe resume/suspend
   * alignment without a live audio device. Defaults to `new AudioContext()`.
   */
  createAudioContext?: () => MoqAudioContext;
  /**
   * Engine config forwarded to `createMoqEngine` — reaches the transport factory (`createMoqTransport`) and the
   * ABR/latency tuning seams from outside the element, which a relay-less harness needs. The adapter owns
   * `onSignalsReady`, so it is not overridable.
   */
  engineConfig?: Omit<MoqEngineConfig, 'onSignalsReady'>;
}

export interface MoqMediaProps {
  src: string;
  preload: '' | 'none' | 'metadata' | 'auto';
  /** Target latency in seconds. */
  targetLatency: number | undefined;
  /**
   * Let the engine choose the target latency from observed delivery instead of holding a fixed one. An explicit
   * `targetLatency` still wins — this only fills in where the consumer stated nothing.
   *
   * Tri-state, the same shape `targetLatency` has: `undefined` is not "off", it is _unstated_, and it defers to
   * `engineConfig.adaptiveLatency.enabled` (itself off by default). Reading it back reports the override rather than
   * the effective state, so a host that enabled adaptation through config sees `undefined` here and a proposal in
   * `adaptiveTargetLatency`.
   */
  adaptiveLatency: boolean | undefined;
  /**
   * Begin playback as soon as a source is set, without waiting for `play()`. Autoplay policy still gates the audio
   * clock: outside a user gesture the AudioContext cannot resume, so video starts on the renderer self-clock with the
   * audio subscription deferred (`state.audioSuspended`) until the first resume() settles.
   */
  autoplay: boolean;
}

export const moqMediaDefaultProps: MoqMediaProps = {
  src: '',
  preload: '',
  targetLatency: undefined,
  adaptiveLatency: undefined,
  autoplay: false,
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
  /** Output gain, clamped to [0, 1]. Applied through a GainNode ahead of the destination. */
  volume: number;
  muted: boolean;
  /** Media time from the audio master clock, in seconds. */
  readonly currentTime: number;
  /** Live streams have no bounded duration. */
  readonly duration: number;
  readonly measuredLatency: number | undefined;
  /**
   * The target the latency controller is actually holding, in seconds, after consumer → adaptive → catalog → default
   * resolution. Pair it with `measuredLatency` to read the controller: they are the setpoint and the process variable.
   */
  readonly effectiveTargetLatency: number | undefined;
  /** The adaptive controller's proposal, or `undefined` when it has none. */
  readonly adaptiveTargetLatency: number | undefined;
}

/**
 * Mixin that adds MoQ playback-engine behavior to any base class, mirroring `SimpleHlsMediaMixin`'s shape. A single
 * engine instance is created at construction and recycled across src changes.
 *
 * @example
 *   class MoqMedia extends MoqMediaMixin(class {}) {}
 *
 *   const media = new MoqMedia();
 *   media.attach(document.querySelector('canvas')!);
 *   media.src = 'moqt://relay.example.com/live#msf:live--catalog';
 *   await media.play();
 */
export function MoqMediaMixin<Base extends Constructor<object>>(BaseClass: Base): MixinReturn<Base, MoqMediaAPI> {
  class MoqMediaImpl extends BaseClass implements MoqMediaAPI {
    readonly #engine: Composition<MoqEngineState, MoqEngineContext>;
    #signals!: MoqEngineSignals;
    #src = moqMediaDefaultProps.src;
    #preload: MoqMediaProps['preload'] = moqMediaDefaultProps.preload;
    #autoplay = moqMediaDefaultProps.autoplay;
    /**
     * The spec's can-autoplay flag, inverted: one autoplay attempt per load cycle, and none once playback was ever
     * started or paused explicitly — a later `autoplay = true` must not restart playback.
     */
    #autoplayAttempted = false;
    readonly #createAudioContext: () => MoqAudioContext;
    #audioContext: MoqAudioContext | undefined;
    /**
     * The most recent fire-and-forget `suspend()` still in flight. `state` only reports 'suspended' once the control
     * thread acknowledges, so a play()/autoplay issued right after a src-change or pause() suspend would read a stale
     * 'running', skip its resume, and let the late suspend silence a facade that reports playing. Resume paths treat a
     * pending suspend as suspended and chain behind it (`#resumeAudio`).
     */
    #pendingSuspend: Promise<void> | undefined;
    #volume = 1;
    #muted = false;
    #gain: GainNode | undefined;
    #renderContext: AudioContextLike | undefined;

    constructor(...args: any[]) {
      super(...args);
      const { createAudioContext, engineConfig } = (args?.[0] ?? {}) as MoqMediaOptions;

      this.#createAudioContext = createAudioContext ?? (() => new AudioContext());
      const config: MoqEngineConfig = {
        ...engineConfig,
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
      // Close the load gate with it. Nothing else writes this slot false
      // (the MoQ engine deliberately omits `trackLoadTriggers`), so without
      // this a single earlier play() would make every later src change
      // bypass `preload` and open a session + subscriptions immediately.
      this.#signals.state.loadActivated.set(false);

      // The other half of `pause()`: the audio renderer has no rate-0 gate —
      // suspending the context *is* the pause — so without this the old
      // source's already-scheduled audio keeps playing audibly while
      // `paused` reports true.
      if (this.#audioContext) this.#suspendAudio(this.#audioContext);

      // A new load cycle re-arms autoplay (the spec's load algorithm resets
      // the can-autoplay flag) and clears the old source's audio deferral.
      this.#autoplayAttempted = false;
      this.#signals.state.audioSuspended.set(undefined);
      this.#signals.state.presentation.set(value ? { url: value } : undefined);

      if (this.#autoplay) this.#attemptAutoplay();
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

    get adaptiveLatency(): boolean | undefined {
      // The slot itself, not `?? false`: collapsing unstated to false made
      // this getter report adaptation off while it was running from
      // `engineConfig.adaptiveLatency.enabled`, and left no way to hand the
      // decision back to config once the property had been written.
      return this.#signals.state.adaptiveLatencyEnabled.get();
    }

    set adaptiveLatency(value: boolean | undefined) {
      this.#signals.state.adaptiveLatencyEnabled.set(value);
    }

    get autoplay(): boolean {
      return this.#autoplay;
    }

    set autoplay(value: boolean) {
      this.#autoplay = value;

      if (value) this.#attemptAutoplay();
    }

    /**
     * The autoplay procedure: begin playback without a user gesture. Playback intent applies in full (`paused` false +
     * load gate open) so video renders on the self-clock immediately, but a suspended AudioContext cannot resume
     * outside a gesture — mark audio deferred (`audioSuspended`) so the audio subscription waits, and let whichever
     * resume() settles first clear it (`play()`, attach() alignment, or the queued resume below).
     */
    #attemptAutoplay(): void {
      if (!this.#src || this.#autoplayAttempted) return;

      this.#autoplayAttempted = true;

      if (!this.paused) return;

      this.#signals.state.paused.set(false);
      this.#signals.state.loadActivated.set(true);
      const audioContext = this.#audioContext;

      if (!audioContext) {
        // No context until attach(); its alignment resume owns the unlock.
        this.#signals.state.audioSuspended.set(true);
        return;
      }

      if (!this.#audioContextSuspended(audioContext)) return;

      this.#signals.state.audioSuspended.set(true);
      // Chromium queues a pre-gesture resume() and settles it on the first
      // user activation, so this is both an immediate start attempt and an
      // unlock signal. Engines that reject instead (Safari) stay deferred
      // until a host gesture path calls play().
      this.#resumeAudio(audioContext)
        .then(() => this.#signals.state.audioSuspended.set(undefined))
        .catch(() => {});
    }

    /** Suspend, recording the in-flight promise so resume paths can serialize behind it — see {@link #pendingSuspend}. */
    #suspendAudio(audioContext: MoqAudioContext): void {
      const clear = (): void => {
        if (this.#pendingSuspend === pending) this.#pendingSuspend = undefined;
      };
      const pending: Promise<void> = audioContext.suspend().then(clear, clear);

      this.#pendingSuspend = pending;
    }

    /** Suspended for playback purposes: an in-flight suspend counts. */
    #audioContextSuspended(audioContext: MoqAudioContext): boolean {
      return this.#pendingSuspend !== undefined || audioContext.state === 'suspended';
    }

    /**
     * Resume serialized behind any in-flight suspend, so a suspend acked after the resume decision cannot silence a
     * playing facade.
     */
    #resumeAudio(audioContext: MoqAudioContext): Promise<void> {
      const pending = this.#pendingSuspend;

      return pending ? pending.then(() => audioContext.resume()) : audioContext.resume();
    }

    attach(surface: HTMLCanvasElement): void {
      this.#signals.context.renderSurface.set(surface);
      const audioContext = (this.#audioContext ??= this.#createAudioContext());

      // Align the context with the paused flag: a context created here —
      // outside a user gesture — starts 'suspended' (so a play() that ran
      // before attach() would otherwise stay permanently silent), while
      // one created inside a gesture can start 'running' while paused.
      if (this.#audioContextSuspended(audioContext)) {
        if (!this.paused) {
          this.#resumeAudio(audioContext)
            .then(() => this.#signals.state.audioSuspended.set(undefined))
            .catch(() => {});
        }
      } else if (audioContext.state === 'running') {
        // A running context can always render audio — an autoplay deferral
        // recorded before the context existed is already settled.
        this.#signals.state.audioSuspended.set(undefined);

        if (this.paused) this.#suspendAudio(audioContext);
      }

      this.#signals.context.audioContext.set((this.#renderContext ??= this.#createRenderContext(audioContext)));
    }

    /**
     * Renderer-facing view of the audio context whose `destination` is a GainNode implementing `volume`/`muted` — the
     * renderer connects its sources to `destination`, so routing that through the gain gives the facade volume control
     * without a renderer seam.
     */
    #createRenderContext(audioContext: MoqAudioContext): AudioContextLike {
      const gain = (this.#gain = audioContext.createGain());

      gain.connect(audioContext.destination);
      gain.gain.value = this.#muted ? 0 : this.#volume;
      return {
        get currentTime() {
          return audioContext.currentTime;
        },
        get destination() {
          return gain;
        },
        createBuffer: (numberOfChannels, length, sampleRate) =>
          audioContext.createBuffer(numberOfChannels, length, sampleRate),
        createBufferSource: () => audioContext.createBufferSource(),
      };
    }

    detach(): void {
      this.#signals.context.renderSurface.set(undefined);
      this.#signals.context.audioContext.set(undefined);
    }

    async play(): Promise<void> {
      // Explicit playback settles autoplay for this load cycle (the spec
      // clears the can-autoplay flag once playback starts).
      this.#autoplayAttempted = true;
      // The engine-side pause gate: renderers hold their playout rate at 0
      // while set, which is what actually freezes video-only playback.
      this.#signals.state.paused.set(false);
      // Set before the resume below: play() is the load intent regardless of
      // whether the audio device comes up, and a rejection must not leave
      // the engine unable to load at all.
      this.#signals.state.loadActivated.set(true);

      // The autoplay-policy gate: resuming inside the user gesture that
      // triggered play() is what unlocks the audio clock. A rejection —
      // Safari outside a gesture, or an already-closed context — means
      // playback did not start, so restore `paused` rather than leaving the
      // player reporting playing over a frozen clock.
      if (this.#audioContext && this.#audioContextSuspended(this.#audioContext)) {
        try {
          await this.#resumeAudio(this.#audioContext);
        } catch (error) {
          this.#signals.state.paused.set(true);
          throw error;
        }
      }

      // Reached with the context running (resumed above or never blocked):
      // any standing autoplay deferral of the audio subscription is over.
      // Pre-attach (no context yet) the deferral must survive — attach()'s
      // alignment resume owns the unlock there.
      if (this.#audioContext) this.#signals.state.audioSuspended.set(undefined);
    }

    pause(): void {
      // Pausing settles autoplay too (spec: pause() clears can-autoplay) —
      // toggling `autoplay` on later must not restart a paused player.
      this.#autoplayAttempted = true;
      this.#signals.state.paused.set(true);

      if (this.#audioContext) this.#suspendAudio(this.#audioContext);
    }

    get paused(): boolean {
      // The engine slot is the single source of truth; it starts (and is
      // reset on destroy to) `undefined`, which reads as paused here.
      return this.#signals.state.paused.get() ?? true;
    }

    get volume(): number {
      return this.#volume;
    }

    set volume(value: number) {
      // NaN would survive the clamp (the infinities do not) and Web Audio
      // rejects a non-finite gain value with a TypeError once attached —
      // drop the write instead, keeping the documented [0, 1] invariant.
      if (Number.isNaN(value)) return;

      this.#volume = Math.min(1, Math.max(0, value));
      this.#applyGain();
    }

    get muted(): boolean {
      return this.#muted;
    }

    set muted(value: boolean) {
      this.#muted = value;
      this.#applyGain();
    }

    #applyGain(): void {
      if (this.#gain) this.#gain.gain.value = this.#muted ? 0 : this.#volume;
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

    get effectiveTargetLatency(): number | undefined {
      return this.#signals.state.effectiveTargetLatency.get();
    }

    get adaptiveTargetLatency(): number | undefined {
      return this.#signals.state.adaptiveTargetLatency.get();
    }

    destroy(): void {
      const audioContext = this.#audioContext;

      this.#audioContext = undefined;
      this.#gain = undefined;
      this.#renderContext = undefined;
      // Close the context only after the composition has torn the renderers
      // down: an in-flight renderer tick still calls `createBuffer` /
      // `createBufferSource`, which throw `InvalidStateError` on a closed
      // context. Both arms close so a failed teardown still releases the
      // audio device.
      const closeAudio = () => {
        audioContext?.close().catch(() => {});
      };

      this.#engine.destroy().then(closeAudio, closeAudio);
    }
  }

  return MoqMediaImpl as unknown as MixinReturn<Base, MoqMediaAPI>;
}

/** Standalone canvas-facade media object (no host base class). */
export class MoqMediaElement extends MoqMediaMixin(class {}) {}
