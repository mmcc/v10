import { VideoCSSVars } from '@videojs/media/dom/custom-media-element';
import { effect } from '@videojs/spf';
import { isResolvedPresentation, MoqMediaMixin, type MoqMediaProps } from '@videojs/spf/moq';
import { applyShadowStyles, createShadowStyle } from '@videojs/utils/dom';
import { isNull } from '@videojs/utils/predicate';
import { MediaAttachMixin } from '../../store/media-attach-mixin';

// SSR guard mirroring `CustomMediaElement` — this class is evaluated at
// module scope, so it must not touch `HTMLElement` where no DOM exists.
const HTMLElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;
const MoqMediaBase = MoqMediaMixin(HTMLElementBase);

/** Native `timeupdate` cadence — poll the audio master clock at the same rate. */
const TIME_POLL_INTERVAL_MS = 250;

/**
 * Layout parity with `CustomMediaElement`'s video template: the host
 * generates no box, so the canvas fills the skin's media container the same
 * way a slotted `<video>` does and honors the same style hooks. Without
 * this the canvas resolves `height: 100%` against an inline host and
 * collapses to its intrinsic bitmap height inside a skin.
 *
 * Deliberately NOT tagged with the build's `/* css *​/` marker: that plugin
 * swaps each `${…}` for an `___EXPR_n___` placeholder before running
 * lightningcss, and these interpolations are custom-property *names* inside
 * `var()`, so it would emit `var(___EXPR_0___)` and fail to parse. Keeping
 * the shared `VideoCSSVars` constants is worth more than minifying ~300
 * bytes of static CSS.
 */
const SHADOW_STYLES = /*css*/ `
  :host {
    display: contents;
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: var(${VideoCSSVars.borderRadius});
    object-fit: var(${VideoCSSVars.objectFit}, contain);
    object-position: var(${VideoCSSVars.objectPosition}, center);
  }
`;

// One constructable sheet shared by every instance, mirroring the skins'
// `static styles = createShadowStyle(...)`. SSR-safe: `createShadowStyle`
// falls back to raw CSS where `CSSStyleSheet` is undefined.
const SHADOW_STYLE_SHEET = createShadowStyle(SHADOW_STYLES);

// `HTMLMediaElement` readyState constants — this element doesn't extend it,
// so the values are restated here (store features compare against them).
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_ENOUGH_DATA = 4;

const PRELOAD_VALUES = ['', 'none', 'metadata', 'auto'] as const;

function isValidPreload(value: string | null): value is MoqMediaProps['preload'] {
  return !isNull(value) && (PRELOAD_VALUES as readonly string[]).includes(value);
}

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
  static shadowRootOptions: ShadowRootInit = { mode: 'open' };

  readonly #canvas: HTMLCanvasElement;
  #bridge: AbortController | null = null;
  #readyState: number = HAVE_NOTHING;
  #lastTime = 0;
  #lastWidth = 0;
  #lastHeight = 0;
  #destroyed = false;

  defaultMuted = false;
  loop = false;

  constructor(...args: ConstructorParameters<typeof MoqMediaBase>) {
    super(...args);
    if (__DEV__) {
      console.warn(
        '<simple-moq-video> is experimental: the MoQ engine has no error slot yet, so transport, ' +
          'codec, and catalog failures are logged rather than surfaced on the element.'
      );
    }
    // Declarative shadow DOM attaches a root during upgrade — a second bare
    // `attachShadow` throws NotSupportedError and leaves the element dead.
    // Mirrors `CustomMediaElement`/`BackgroundVideo`/`SkinElement`.
    if (!this.shadowRoot) {
      this.attachShadow((this.constructor as typeof SimpleMoqMediaImpl).shadowRootOptions);
    }
    const root = this.shadowRoot!;
    this.#canvas = root.querySelector('canvas') ?? document.createElement('canvas');
    if (!this.#canvas.isConnected) root.append(this.#canvas);
    applyShadowStyles(root, [SHADOW_STYLE_SHEET]);
  }

  connectedCallback(): void {
    // A reconnect after teardown would attach into a destroyed composition,
    // whose slots have all been reset — the canvas would stay black with no
    // error anywhere. Refuse instead of failing silently.
    if (this.#destroyed) {
      if (__DEV__) {
        console.warn('<simple-moq-video> was reconnected after destroy(); create a new element instead.');
      }
      return;
    }
    this.attach(this.#canvas);
    this.#connectEventBridge();
  }

  disconnectedCallback(): void {
    this.#bridge?.abort();
    this.#bridge = null;
    this.detach();
    // `keep-alive` opts out of teardown entirely (same escape hatch as
    // `CustomMediaElement`), for hosts that reparent asynchronously.
    if (this.hasAttribute('keep-alive')) return;
    // Defer so a synchronous reparent (remove + insert) doesn't tear down
    // the engine — mirrors `CustomMediaElement`'s disconnect guard.
    queueMicrotask(() => {
      if (this.isConnected || this.#destroyed) return;
      this.#destroyed = true;
      this.destroy();
    });
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'src') {
      this.src = newValue ?? '';
    } else if (name === 'preload') {
      this.preload = isValidPreload(newValue) ? newValue : '';
    } else if (name === 'target-latency') {
      // A bare attribute or garbage would otherwise reach the latency
      // controller as 0 (continuous catch-up) or NaN (every comparison
      // false, so latency control silently stops).
      const parsed = isNull(newValue) ? Number.NaN : Number(newValue);
      this.targetLatency = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    } else if (name === 'muted') {
      // `muted` is the *default* muted state per spec: removing the
      // attribute must not unmute an element the user muted.
      this.defaultMuted = !isNull(newValue);
      if (!isNull(newValue)) this.muted = true;
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
        // The clock does not advance while paused, so a stale `#lastTime`
        // would make the first tick after resuming look like a stall and
        // flash the spinner on a perfectly healthy stream.
        if (!paused) this.#lastTime = this.currentTime;
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
      // The canvas bitmap is sized on first decode and on every resolution
      // switch; consumers track dimensions through `resize`, so without this
      // `videoWidth`/`videoHeight` readers never refresh.
      if (this.#canvas.width !== this.#lastWidth || this.#canvas.height !== this.#lastHeight) {
        this.#lastWidth = this.#canvas.width;
        this.#lastHeight = this.#canvas.height;
        this.#dispatch('resize');
      }
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
  // Video dimension capability
  // --------------------------------------------------------------------

  // `error` is deliberately NOT defined. `isMediaErrorCapable` only checks
  // `!isUndefined(media.error)`, so a `null`-returning getter would make the
  // error feature attach and then wait forever for an `'error'` event this
  // element cannot fire — the engine has no error slot yet. Leaving the
  // property undefined makes the feature skip, which is honest. Define it
  // (and dispatch `'error'`) once the engine surfaces failures.

  get videoWidth(): number {
    return this.#canvas.width;
  }

  get videoHeight(): number {
    return this.#canvas.height;
  }
}

export class SimpleMoqVideo extends MediaAttachMixin(SimpleMoqMediaImpl) {}
