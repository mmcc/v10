import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { MoqPublishVideo } from '../media';

customElements.define('test-moq-publish-video', MoqPublishVideo);

function createMoqPublishVideo(): MoqPublishVideo {
  const el = new MoqPublishVideo();

  document.body.appendChild(el);
  return el;
}

/** Happy-dom's mediaDevices is minimal — install a controllable stand-in. */
function stubMediaDevices(getUserMedia: (constraints?: MediaStreamConstraints) => Promise<MediaStream>): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MoqPublishVideo', () => {
  it('renders a preview video in the shadow root', () => {
    const el = createMoqPublishVideo();

    expect(el.shadowRoot?.querySelector('video')).not.toBeNull();
  });

  it('maps the publish endpoint attributes onto the host', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('publish-endpoint', 'https://relay.example.com/moq');
    el.setAttribute('publish-namespace', 'live/abc123');

    expect(el.host.publishEndpoint).toBe('https://relay.example.com/moq');
    expect(el.host.publishNamespace).toBe('live/abc123');
  });

  it('reflects publisher property writes back to attributes', () => {
    const el = createMoqPublishVideo();

    el.publishEndpoint = 'https://relay.example.com/moq';
    el.publishNamespace = 'live/abc123';

    expect(el.getAttribute('publish-endpoint')).toBe('https://relay.example.com/moq');
    expect(el.getAttribute('publish-namespace')).toBe('live/abc123');
    expect(el.host.publishEndpoint).toBe('https://relay.example.com/moq');
  });

  it('does not mirror publisher attributes onto the preview video', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('publish-endpoint', 'https://relay.example.com/moq');

    expect(el.shadowRoot?.querySelector('video')?.hasAttribute('publish-endpoint')).toBe(false);
  });

  it('activates and releases the camera through the camera-active attribute', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('camera-active', '');
    expect(el.host.cameraActive).toBe(true);

    el.removeAttribute('camera-active');
    expect(el.host.cameraActive).toBe(false);
  });

  it('clears the camera-active attribute when the engine consumes the intent, keeping property retry live', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const restore = stubMediaDevices(getUserMedia);

    try {
      const el = createMoqPublishVideo();

      el.cameraActive = true;
      expect(el.hasAttribute('camera-active')).toBe(true);

      // Denial consumes the intent in the engine; the attribute must
      // follow, or the next property write toggles an already-present
      // attribute (no attributeChangedCallback) and retry is dead.
      await vi.waitFor(() => {
        expect(el.host.cameraState).toBe('denied');
        expect(el.host.cameraActive).toBe(false);
        expect(el.hasAttribute('camera-active')).toBe(false);
      });

      const cameraCalls = () =>
        getUserMedia.mock.calls.filter((call) => (call[0] as MediaStreamConstraints | undefined)?.video).length;
      const callsAfterDenial = cameraCalls();

      el.cameraActive = true;
      await vi.waitFor(() => {
        expect(cameraCalls()).toBeGreaterThan(callsAfterDenial);
      });
    } finally {
      restore();
    }
  });

  it('activates an audio-only capture through the mic-active attribute', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('mic-active', '');
    expect(el.host.micActive).toBe(true);
    // No video source rides along — audio-only publish (issue #26).
    expect(el.host.cameraActive).toBe(false);
    expect(el.host.screenShareActive).toBe(false);

    el.removeAttribute('mic-active');
    expect(el.host.micActive).toBe(false);
  });

  it('clears the mic-active attribute when the engine consumes the intent, keeping property retry live', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    const restore = stubMediaDevices(getUserMedia);

    try {
      const el = createMoqPublishVideo();

      el.micActive = true;
      expect(el.hasAttribute('mic-active')).toBe(true);

      // Denial consumes the intent in the engine; the attribute must
      // follow, or the next property write toggles an already-present
      // attribute (no attributeChangedCallback) and retry is dead.
      await vi.waitFor(() => {
        expect(el.host.micState).toBe('denied');
        expect(el.host.micActive).toBe(false);
        expect(el.hasAttribute('mic-active')).toBe(false);
      });

      const micCalls = () =>
        getUserMedia.mock.calls.filter((call) => (call[0] as MediaStreamConstraints | undefined)?.audio).length;
      const callsAfterDenial = micCalls();

      el.micActive = true;
      await vi.waitFor(() => {
        expect(micCalls()).toBeGreaterThan(callsAfterDenial);
      });
    } finally {
      restore();
    }
  });

  it('activates screen share independently through the screen-share-active attribute', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('camera-active', '');
    el.setAttribute('screen-share-active', '');
    expect(el.host.cameraActive).toBe(true);
    expect(el.host.screenShareActive).toBe(true);

    el.removeAttribute('screen-share-active');
    expect(el.host.screenShareActive).toBe(false);
    // The camera is untouched by releasing screen share — additive.
    expect(el.host.cameraActive).toBe(true);
  });
});
