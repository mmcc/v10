import { effect } from '@videojs/spf';
import { isResolvedPresentation, MoqMediaMixin, type MoqMediaProps } from '@videojs/spf/moq';
import { isNull } from '@videojs/utils/predicate';
import { MediaAttachMixin } from '../../store/media-attach-mixin';

// SSR guard mirroring `CustomMediaElement` — this class is evaluated at
// module scope, so it must not touch `HTMLElement` where no DOM exists.
const HTMLElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;
const MoqMediaBase = MoqMediaMixin(HTMLElementBase);

/** Native `timeupdate` cadence — poll the audio master clock at the same rate. */
const TIME_POLL_INTERVAL_MS = 250;

// `HTMLMediaElement` readyState constants — this element doesn't extend it,
// so the values are restated here (store features compare against them).
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

/**
 * `MoqMediaMixin` renders to a canvas + `AudioContext` rather than wrapping
 * a native `<video>`, so it doesn't fit `CustomMediaElement`'s
 * component-onto-a-target-element model (`SimpleHlsVideo`'s pattern) — this
 * class owns the canvas and the custom-element lifecycle directly instead.
 *
 * With no native media events to bridge, the element synthesizes the
 * capability surface core's store features probe for (`Media` is
 * capability-based, not `HTMLMediaElement`-based): pause/seek/source/
 * volume/stream-type/live properties plus the events their features
 * listen to, derived from the engine's state signals and a clock poller.
 * Deliberately not claimed: `buffered`/`seekable` (no buffer model yet),
 * `playbackRate` (live-only), and `textTracks` (no text renderer yet).
 */
class SimpleMoqMediaImpl extends MoqMediaBase {
  static readonly observedAttributes = ['src', 'preload', 'target-latency', 'muted'];

  readonly #canvas: HTMLCanvasElement;
  #bridge: AbortController | null = null;
  #readyState: number = HAVE_NOTHING;
  #lastTime = 0;

  defaultMuted = false;
  loop = false;

  constructor(...args: ConstructorParameters<typeof MoqMediaBase>) {
    super(...args);
    this.attachShadow({ mode: 'open' });
    this.#canvas = document.createElement('canvas');
    this.#canvas.style.cssText = 'display: block; width: 100%; height: 100%;';
    this.shadowRoot!.append(this.#canvas);
  }

  connectedCallback(): void {
    this.attach(this.#canvas);
    this.#connectEventBridge();
  }

  disconnectedCallback(): void {
    this.#bridge?.abort();
    this.#bridge = null;
    this.detach();
    // Defer so a synchronous reparent (remove + insert) doesn't tear down
    // the engine — mirrors `CustomMediaElement`'s disconnect guard.
    queueMicrotask(() => {
      if (!this.isConnected) this.destroy();
    });
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'src') {
      this.src = newValue ?? '';
    } else if (name === 'preload') {
      this.preload = (newValue ?? '') as MoqMediaProps['preload'];
    } else if (name === 'target-latency') {
      this.targetLatency = isNull(newValue) ? undefined : Number(newValue);
    } else if (name === 'muted') {
      this.defaultMuted = !isNull(newValue);
      this.muted = !isNull(newValue);
    }
  }

  // --------------------------------------------------------------------
  // Event bridge — engine signals → media-element event contract
  // --------------------------------------------------------------------

  #connectEventBridge(): void {
    this.#bridge?.abort();
    const bridge = (this.#bridge = new AbortController());
    const own = (cleanup: () => void) => bridge.signal.addEventListener('abort', cleanup, { once: true });

    // The engine paused slot is the source of truth (play()/pause() write
    // it; a src change re-pauses) — mirror its transitions as events.
    let lastPaused = this.paused;
    own(
      effect(() => {
        const paused = this.engine.state.paused.get() ?? true;
        if (paused === lastPaused) return;
        lastPaused = paused;
        this.#dispatch(paused ? 'pause' : 'play');
      })
    );

    // Catalog resolution is this engine's `loadedmetadata` analog.
    own(
      effect(() => {
        const presentation = this.engine.state.presentation.get();
        if (!isResolvedPresentation(presentation) || this.#readyState >= HAVE_METADATA) return;
        this.#readyState = HAVE_METADATA;
        this.#dispatch('loadedmetadata');
        this.#dispatch('durationchange');
      })
    );

    // The audio master clock is the only playback progress signal — poll
    // it at the native timeupdate cadence; a stalled clock while playing
    // means the jitter buffer ran dry (`waiting`).
    const tick = () => {
      if (this.paused) return;
      const time = this.currentTime;
      if (time !== this.#lastTime) {
        this.#lastTime = time;
        if (this.#readyState < HAVE_ENOUGH_DATA) {
          this.#readyState = HAVE_ENOUGH_DATA;
          this.#dispatch('canplay');
          this.#dispatch('canplaythrough');
          this.#dispatch('playing');
        }
        this.#dispatch('timeupdate');
      } else if (this.#readyState === HAVE_ENOUGH_DATA) {
        this.#readyState = HAVE_CURRENT_DATA;
        this.#dispatch('waiting');
      }
    };
    const interval = setInterval(tick, TIME_POLL_INTERVAL_MS);
    own(() => clearInterval(interval));
  }

  #dispatch(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  // --------------------------------------------------------------------
  // Source capability
  // --------------------------------------------------------------------

  override get src(): string {
    return super.src;
  }

  override set src(value: string) {
    const previous = super.src;
    if (value === previous) return;
    super.src = value;
    // Mirror the native load cycle for the new resource. Stream-type and
    // live-window values are derived from `src`, so their change events
    // ride along with the empty↔set transitions.
    this.#readyState = HAVE_NOTHING;
    this.#lastTime = 0;
    if (previous) this.#dispatch('emptied');
    if (value) this.#dispatch('loadstart');
    this.#dispatch('durationchange');
    this.#dispatch('streamtypechange');
    this.#dispatch('targetlivewindowchange');
  }

  get currentSrc(): string {
    return this.src;
  }

  get readyState(): number {
    return this.#readyState;
  }

  load(): void {
    // The engine reloads reactively when `presentation` (src) changes —
    // there is no imperative load step to kick.
  }

  // --------------------------------------------------------------------
  // Pause + seek capabilities
  // --------------------------------------------------------------------

  get ended(): boolean {
    // Playback (subscribe) is live-only in this engine phase.
    return false;
  }

  get seeking(): boolean {
    return false;
  }

  override get currentTime(): number {
    return super.currentTime;
  }

  override set currentTime(_value: number) {
    // Live-only: there is no seekable window. Resolve store `seek()` flows
    // (which await `seeked` after assigning) instead of hanging them; defer
    // so the awaiter attaches its listener first.
    queueMicrotask(() => this.#dispatch('seeked'));
  }

  // --------------------------------------------------------------------
  // Volume capability
  // --------------------------------------------------------------------

  override get volume(): number {
    return super.volume;
  }

  override set volume(value: number) {
    const previous = super.volume;
    super.volume = value;
    if (super.volume !== previous) this.#dispatch('volumechange');
  }

  override get muted(): boolean {
    return super.muted;
  }

  override set muted(value: boolean) {
    if (value === super.muted) return;
    super.muted = value;
    this.#dispatch('volumechange');
  }

  // --------------------------------------------------------------------
  // Stream-type + live capabilities
  // --------------------------------------------------------------------

  get streamType(): 'live' | 'unknown' {
    return this.src ? 'live' : 'unknown';
  }

  get liveEdgeStart(): number {
    // No DVR window — playback is always at the live edge.
    return this.src ? 0 : Number.NaN;
  }

  get targetLiveWindow(): number {
    return this.src ? 0 : Number.NaN;
  }

  // --------------------------------------------------------------------
  // Error + video dimension capabilities
  // --------------------------------------------------------------------

  get error(): null {
    // The engine has no error surfacing slot yet — claim the capability so
    // the error feature attaches, and report it once the slot exists.
    return null;
  }

  get videoWidth(): number {
    return this.#canvas.width;
  }

  get videoHeight(): number {
    return this.#canvas.height;
  }
}

export class SimpleMoqVideo extends MediaAttachMixin(SimpleMoqMediaImpl) {}
