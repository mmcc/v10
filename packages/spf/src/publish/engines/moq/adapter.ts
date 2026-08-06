/**
 * Media-host adapter for the MoQ publish engine, mirroring
 * `SimpleHlsMediaMixin` / `MoqMediaMixin`'s shape: one engine per
 * instance (created at construction, signals captured via
 * `onSignalsReady`), with the publisher media-contract surface —
 * `MediaPublishCapability`, `MediaCaptureSourceCapability`,
 * `MediaCaptureDevicesCapability`, `MediaCaptureToggleCapability`,
 * `MediaPublishStatsCapability` — expressed structurally so
 * `@videojs/media` can compose it without `@videojs/spf` depending on the
 * contracts package.
 *
 * All members are prototype accessors/methods: `CustomMediaElement` only
 * forwards prototype accessors, so instance fields would not surface on a
 * custom-element host.
 *
 * The adapter owns the contract events: `effect()` bridges on the engine's
 * fact signals dispatch `publishstatechange`, `capturestatechange`,
 * `capturesourcechange`, `capturestreamchange`, `capturedeviceschange`,
 * `capturetogglechange`, and `publishstatsupdate` on `this` (when the base
 * class provides `dispatchEvent`) — the engine itself stays event-free.
 */
import type { Constructor, MixinReturn } from '@videojs/utils/types';
import type { Composition } from '../../../core/composition/create-composition';
import { effect } from '../../../core/signals/effect';
import { peek } from '../../../core/signals/primitives';
import type {
  CaptureDeviceFacts,
  CaptureStatus,
  MoqPublishEngineConfig,
  MoqPublishEngineContext,
  MoqPublishEngineSignals,
  MoqPublishEngineState,
  PreviewSource,
  PublishSessionStatus,
  PublishStatsFacts,
} from './engine';
import { createMoqPublishEngine } from './engine';

/**
 * Publish session lifecycle exposed on the media surface
 * (`MediaPublishSessionState`-shaped). The engine's finer-grained
 * `PublishSessionStatus` collapses onto it: `idle`/`closed` → `'idle'`,
 * `connecting`/`ready` → `'connecting'`, `draining` → `'stopping'`.
 */
export type MoqPublishMediaSessionState = 'idle' | 'connecting' | 'live' | 'stopping' | 'error';

/** `ErrorLike`-shaped publish error exposed on the media surface. */
export interface MoqPublishMediaError {
  readonly code: number;
  readonly message: string;
}

/**
 * Constructor options for {@link MoqPublishMediaMixin} classes, read from
 * the first constructor argument.
 */
export interface MoqPublishMediaOptions {
  /**
   * Engine config forwarded to `createMoqPublishEngine`. The adapter owns
   * `onSignalsReady`, so it is not overridable.
   */
  engineConfig?: Omit<MoqPublishEngineConfig, 'onSignalsReady'>;
}

export interface MoqPublishMediaProps {
  /** Publish endpoint URL (e.g. a MoQ relay's WebTransport URL). */
  publishEndpoint: string;
  /** Namespace/path the media is published under, `'/'`-delimited. */
  publishNamespace: string;
  /**
   * Bearer token sent as the MOQT `AUTHORIZATION TOKEN` parameter on the
   * session's requests; empty string sends none.
   */
  publishAuthToken: string;
  /** Camera acquisition; additive with `screenShareActive`, not exclusive. */
  cameraActive: boolean;
  /** Screen-share acquisition; additive with `cameraActive`, not exclusive. */
  screenShareActive: boolean;
  /** Which capture stream the preview element mirrors. */
  previewSource: PreviewSource;
  /** Selected camera; empty string defers to the platform default. */
  videoInputDeviceId: string;
  /** Selected microphone; empty string defers to the platform default. */
  audioInputDeviceId: string;
  /** Whether outgoing camera video is muted (track disabled, capture continues). */
  cameraMuted: boolean;
  /** Whether outgoing microphone audio is muted (track disabled, capture continues). */
  micMuted: boolean;
}

export const moqPublishMediaDefaultProps: MoqPublishMediaProps = {
  publishEndpoint: '',
  publishNamespace: '',
  publishAuthToken: '',
  cameraActive: false,
  screenShareActive: false,
  previewSource: 'camera',
  videoInputDeviceId: '',
  audioInputDeviceId: '',
  cameraMuted: false,
  micMuted: false,
};

export interface MoqPublishMediaAPI extends MoqPublishMediaProps {
  readonly engine: Composition<MoqPublishEngineState, MoqPublishEngineContext>;
  /** Camera pipeline lifecycle. Fires `capturestatechange`. */
  readonly cameraState: CaptureStatus;
  /** Screen-share pipeline lifecycle. Fires `capturestatechange`. */
  readonly screenShareState: CaptureStatus;
  /**
   * Microphone pipeline lifecycle. Fires `capturestatechange`. `idle`
   * while video captures means audio-less publish (no usable mic);
   * `denied`/`ended` say why a live broadcast has no sound.
   */
  readonly micState: CaptureStatus;
  /** Live camera stream while `cameraState` is `active`, else `null`. */
  readonly cameraStream: MediaStream | null;
  /** Live screen-share stream while `screenShareState` is `active`, else `null`. */
  readonly screenShareStream: MediaStream | null;
  /** Known capture input devices. Fires `capturedeviceschange`. */
  readonly captureDevices: readonly CaptureDeviceFacts[];
  /** Current publish session lifecycle. Fires `publishstatechange`. */
  readonly publishState: MoqPublishMediaSessionState;
  /**
   * Epoch ms when the session last entered `live`. Held through
   * `'stopping'` (so UIs keep showing the elapsed time while draining)
   * and reset to `NaN` once the session settles on `'idle'` or `'error'`.
   */
  readonly publishStartedAt: number;
  /** The failure that moved `publishState` to `error`, if any. */
  readonly publishError: MoqPublishMediaError | null;
  /** Latest sampled stats, `null` before the first sample. */
  readonly publishStats: PublishStatsFacts | null;
  /**
   * Start publishing. Resolves once the session is `live`; rejects when
   * the attempt fails, when `unpublish()` abandons it, or immediately
   * (`play()`-like) when its preconditions are unmet — a `publishEndpoint`
   * must be set and capture must be `'active'`. Calling it again after an
   * `'error'` tears the failed session down and reconnects, settling on
   * the new attempt's outcome.
   */
  publish(): Promise<void>;
  unpublish(): void;
  /** Mount the capture preview onto a video element. */
  attach(previewElement: HTMLVideoElement): void;
  detach(): void;
  destroy(): void;
}

/** `PublishErrorFacts.code` → numeric `ErrorLike.code` for the media surface. */
const publishErrorCodes = { capture: 1, encode: 2, transport: 3, protocol: 4 } as const;

function toPublishState(status: PublishSessionStatus | undefined): MoqPublishMediaSessionState {
  switch (status) {
    case 'connecting':
    case 'ready':
      return 'connecting';
    case 'live':
      return 'live';
    case 'draining':
      return 'stopping';
    case 'error':
      return 'error';
    default:
      // 'idle' | 'closed' | undefined (pre-seed / post-destroy)
      return 'idle';
  }
}

/**
 * Mixin that adds MoQ publish-engine behavior to any base class.
 *
 * @example
 * class MoqPublishMedia extends MoqPublishMediaMixin(HTMLVideoElementHost) {}
 *
 * const media = new MoqPublishMedia();
 * media.attach(document.querySelector('video')!);
 * media.cameraActive = true;
 * media.publishEndpoint = 'https://relay.example.com/moq';
 * media.publishNamespace = 'live/abc123';
 */
export function MoqPublishMediaMixin<Base extends Constructor<any>>(
  BaseClass: Base
): MixinReturn<Base, MoqPublishMediaAPI> {
  class MoqPublishMediaImpl extends BaseClass {
    readonly #engine: Composition<MoqPublishEngineState, MoqPublishEngineContext>;
    #signals!: MoqPublishEngineSignals;
    #publishEndpoint = moqPublishMediaDefaultProps.publishEndpoint;
    #publishNamespace = moqPublishMediaDefaultProps.publishNamespace;
    #publishAuthToken = moqPublishMediaDefaultProps.publishAuthToken;
    #videoInputDeviceId = moqPublishMediaDefaultProps.videoInputDeviceId;
    #audioInputDeviceId = moqPublishMediaDefaultProps.audioInputDeviceId;
    #publishStartedAt = Number.NaN;
    readonly #disposeBridges: () => void;

    constructor(...args: any[]) {
      super(...args);
      const { engineConfig } = (args?.[0] ?? {}) as MoqPublishMediaOptions;
      const config: MoqPublishEngineConfig = {
        ...engineConfig,
        onSignalsReady: (refs) => {
          this.#signals = refs;
        },
      };
      this.#engine = createMoqPublishEngine(config);
      this.#disposeBridges = this.#installEventBridges();
    }

    /**
     * Underlying publish engine — the low-level SPF reactive composition
     * that drives capture, encode, and the MOQT publish transport. An
     * advanced escape hatch; normal publishing is driven through this
     * adapter's own properties and methods.
     */
    get engine(): Composition<MoqPublishEngineState, MoqPublishEngineContext> {
      return this.#engine;
    }

    // -------------------------------------------------------------------------
    // Publish endpoint — url + namespace compose into `state.endpoint`
    // -------------------------------------------------------------------------

    get publishEndpoint(): string {
      return this.#publishEndpoint;
    }

    set publishEndpoint(value: string) {
      if (value === this.#publishEndpoint) return;
      this.#publishEndpoint = value;
      this.#syncEndpoint();
    }

    get publishNamespace(): string {
      return this.#publishNamespace;
    }

    set publishNamespace(value: string) {
      if (value === this.#publishNamespace) return;
      this.#publishNamespace = value;
      this.#syncEndpoint();
    }

    get publishAuthToken(): string {
      return this.#publishAuthToken;
    }

    set publishAuthToken(value: string) {
      if (value === this.#publishAuthToken) return;
      this.#publishAuthToken = value;
      this.#syncEndpoint();
    }

    #syncEndpoint(): void {
      // No URL, no endpoint — the namespace mirror waits locally until an
      // endpoint URL makes the pair meaningful to the engine.
      this.#signals.state.endpoint.set(
        this.#publishEndpoint
          ? {
              url: this.#publishEndpoint,
              namespace: this.#publishNamespace.split('/').filter(Boolean),
              ...(this.#publishAuthToken ? { authToken: this.#publishAuthToken } : {}),
            }
          : undefined
      );
    }

    // -------------------------------------------------------------------------
    // Capture sources + input devices — additive, not exclusive: setting
    // one never releases the other. Each pipeline reacts to its own
    // intent slot directly; no selection object to rebuild by hand.
    // The intent slots are multi-writer: the acquire behaviors consume
    // them (write `false`) when a pipeline terminates on its own
    // (`denied`/`ended`) — see `acquire-capture-source`'s module doc — so
    // a `true` write here is always a real acquisition attempt.
    // -------------------------------------------------------------------------

    get cameraActive(): boolean {
      return this.#signals.state.cameraActive.get() ?? false;
    }

    set cameraActive(value: boolean) {
      this.#signals.state.cameraActive.set(value);
    }

    get screenShareActive(): boolean {
      return this.#signals.state.screenShareActive.get() ?? false;
    }

    set screenShareActive(value: boolean) {
      this.#signals.state.screenShareActive.set(value);
    }

    get previewSource(): PreviewSource {
      return this.#signals.state.previewSource.get() ?? 'camera';
    }

    set previewSource(value: PreviewSource) {
      this.#signals.state.previewSource.set(value);
    }

    get cameraState(): CaptureStatus {
      return this.#signals.state.cameraState.get() ?? 'idle';
    }

    get screenShareState(): CaptureStatus {
      return this.#signals.state.screenShareState.get() ?? 'idle';
    }

    get micState(): CaptureStatus {
      return this.#signals.state.micState.get() ?? 'idle';
    }

    get cameraStream(): MediaStream | null {
      return this.#signals.context.cameraStream.get() ?? null;
    }

    get screenShareStream(): MediaStream | null {
      return this.#signals.context.screenStream.get() ?? null;
    }

    get captureDevices(): readonly CaptureDeviceFacts[] {
      return this.#signals.state.captureDevices.get() ?? [];
    }

    get videoInputDeviceId(): string {
      return this.#videoInputDeviceId;
    }

    set videoInputDeviceId(value: string) {
      if (value === this.#videoInputDeviceId) return;
      this.#videoInputDeviceId = value;
      this.#signals.state.videoInputDeviceId.set(value);
      // Selections travel on the devices event — store slices re-read both
      // the device list and the selected ids from it.
      this.#dispatch('capturedeviceschange');
    }

    get audioInputDeviceId(): string {
      return this.#audioInputDeviceId;
    }

    set audioInputDeviceId(value: string) {
      if (value === this.#audioInputDeviceId) return;
      this.#audioInputDeviceId = value;
      this.#signals.state.audioInputDeviceId.set(value);
      this.#dispatch('capturedeviceschange');
    }

    // -------------------------------------------------------------------------
    // Mute toggles
    // -------------------------------------------------------------------------

    get cameraMuted(): boolean {
      return this.#signals.state.cameraMuted.get() ?? false;
    }

    set cameraMuted(value: boolean) {
      this.#signals.state.cameraMuted.set(value);
    }

    get micMuted(): boolean {
      return this.#signals.state.micMuted.get() ?? false;
    }

    set micMuted(value: boolean) {
      this.#signals.state.micMuted.set(value);
    }

    // -------------------------------------------------------------------------
    // Publish session
    // -------------------------------------------------------------------------

    get publishState(): MoqPublishMediaSessionState {
      return toPublishState(this.#signals.state.sessionStatus.get());
    }

    get publishStartedAt(): number {
      return this.#publishStartedAt;
    }

    get publishError(): MoqPublishMediaError | null {
      const error = this.#signals.state.publishError.get();
      return error ? { code: publishErrorCodes[error.code], message: error.message } : null;
    }

    get publishStats(): PublishStatsFacts | null {
      return this.#signals.state.publishStats.get() ?? null;
    }

    publish(): Promise<void> {
      const { state } = this.#signals;
      // play()-like precondition rejections: the session gate requires an
      // endpoint and active capture — neither is something publish() can
      // produce, so waiting on them would pend forever. The intent slot
      // stays untouched.
      if (!peek(state.endpoint)) {
        return Promise.reject(
          new Error('MoqPublishMedia: publish() requires a publishEndpoint before it can start a session.')
        );
      }
      if (peek(state.cameraState) !== 'active' && peek(state.screenShareState) !== 'active') {
        return Promise.reject(new Error('MoqPublishMedia: publish() requires an active capture source.'));
      }
      return this.#activatePublish();
    }

    async #activatePublish(): Promise<void> {
      const { state } = this.#signals;
      if (peek(state.sessionStatus) === 'error') {
        // Restart after a failure: the session behavior reconnects on the
        // activation gate's rising edge, so cycle the (adapter-owned)
        // intent slot through false and yield a microtask so the reactor
        // observes the drop before the gate re-arms — a same-tick
        // false→true write coalesces into no change.
        state.publishActivated.set(false);
        await Promise.resolve();
      }
      // Record the intent — the transport behaviors gate on this slot.
      state.publishActivated.set(true);
      // Settle on the session outcome: resolve once live, reject on a
      // session error (with the engine's publishError) or when the
      // attempt is abandoned (`unpublish()` before going live). A sticky
      // `'error'` from a previous attempt must not settle this call: only
      // an error transition observed after this point — a status change
      // onto 'error', or a fresh publishError identity — rejects.
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let dispose: (() => void) | undefined;
        let lastStatus = peek(state.sessionStatus);
        const staleError = peek(state.publishError);
        const settle = (complete: () => void): void => {
          if (settled) return;
          settled = true;
          complete();
          dispose?.();
        };
        dispose = effect(() => {
          const status = state.sessionStatus.get();
          const error = state.publishError.get();
          const statusChanged = status !== lastStatus;
          lastStatus = status;
          if (status === 'live') {
            settle(resolve);
          } else if (status === 'error' && (statusChanged || error !== staleError)) {
            settle(() =>
              reject(
                Object.assign(new Error(error?.message ?? 'MoqPublishMedia: publishing failed.'), {
                  cause: error?.cause,
                })
              )
            );
          } else if (state.publishActivated.get() !== true) {
            settle(() => reject(new Error('MoqPublishMedia: publish was cancelled before the session went live.')));
          }
        });
        // The effect runs synchronously once — if it already settled,
        // `dispose` was not assigned yet inside `settle`.
        if (settled) dispose();
      });
    }

    unpublish(): void {
      this.#signals.state.publishActivated.set(false);
    }

    // -------------------------------------------------------------------------
    // Media element lifecycle
    // -------------------------------------------------------------------------

    attach(previewElement: HTMLVideoElement): void {
      super.attach?.(previewElement);
      this.#signals.context.previewElement.set(previewElement);
    }

    detach(): void {
      this.#signals.context.previewElement.set(undefined);
      super.detach?.();
    }

    destroy(): void {
      // Bridges first so the destroy-time signal resets don't dispatch.
      this.#disposeBridges();
      this.#engine.destroy();
      super.destroy?.();
    }

    // -------------------------------------------------------------------------
    // Event bridges — engine facts → contract events on `this`
    // -------------------------------------------------------------------------

    #installEventBridges(): () => void {
      const { state, context } = this.#signals;
      const cleanups = [
        this.#bridge(
          () => toPublishState(state.sessionStatus.get()),
          (next) => {
            // Held through 'stopping' so timers show the final duration
            // while the session drains; cleared once it settles.
            if (next === 'live') this.#publishStartedAt = Date.now();
            else if (next === 'idle' || next === 'error') this.#publishStartedAt = Number.NaN;
            this.#dispatch('publishstatechange');
          }
        ),
        this.#bridge(
          () => state.publishError.get(),
          // Encoder and track-publisher failures surface while the session
          // stays 'live', so the mapped state above never moves for them —
          // without this bridge the store feature (which re-reads
          // `publishError` only on 'publishstatechange') would keep
          // exposing null. Gated to 'live' on purpose: a failure that also
          // moves the session (connect errors write status + error in one
          // flush) already dispatches through the status bridge — firing
          // here too would double the event — and idle-time capture/probe
          // errors stay off the publish surface (publish() rejects with
          // them instead).
          () => {
            if (toPublishState(peek(state.sessionStatus)) === 'live') this.#dispatch('publishstatechange');
          }
        ),
        this.#bridge(
          () =>
            `${state.cameraState.get() ?? 'idle'}|${state.screenShareState.get() ?? 'idle'}|${state.micState.get() ?? 'idle'}`,
          () => this.#dispatch('capturestatechange')
        ),
        this.#bridge(
          () => `${state.cameraActive.get() ?? false}|${state.screenShareActive.get() ?? false}`,
          () => this.#dispatch('capturesourcechange')
        ),
        this.#bridge(
          () => `${context.cameraStream.get() !== undefined}|${context.screenStream.get() !== undefined}`,
          () => this.#dispatch('capturestreamchange')
        ),
        this.#bridge(
          () => state.captureDevices.get(),
          (devices) => {
            if (devices) this.#dispatch('capturedeviceschange');
          }
        ),
        this.#bridge(
          () => `${state.cameraMuted.get() ?? false}|${state.micMuted.get() ?? false}`,
          () => this.#dispatch('capturetogglechange')
        ),
        this.#bridge(
          () => state.publishStats.get(),
          // Dispatch on every transition including the reset to `undefined`
          // at teardown — consumers must observe stats going away, or a
          // connection-quality readout would stick at its last value.
          () => this.#dispatch('publishstatsupdate')
        ),
      ];
      return () => {
        for (const dispose of cleanups) dispose();
      };
    }

    /**
     * Watch a fact projection and invoke `onChange` on every change after
     * the initial run — the construction-time value must not dispatch.
     */
    #bridge<T>(read: () => T, onChange: (next: T, prev: T | undefined) => void): () => void {
      let initialized = false;
      let previous: T | undefined;
      return effect(() => {
        const value = read();
        if (!initialized) {
          initialized = true;
          previous = value;
          return;
        }
        if (Object.is(value, previous)) return;
        const prev = previous;
        previous = value;
        onChange(value, prev);
      });
    }

    #dispatch(type: string): void {
      // The base class may not be an EventTarget (e.g. the standalone
      // `class {}` form) — events are adapter sugar, not a hard dependency.
      (this as unknown as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent?.(new Event(type));
    }
  }

  return MoqPublishMediaImpl as unknown as MixinReturn<Base, MoqPublishMediaAPI>;
}

/** Standalone publish media adapter with no base class. */
export class MoqPublishMediaElement extends MoqPublishMediaMixin(class {}) {}
