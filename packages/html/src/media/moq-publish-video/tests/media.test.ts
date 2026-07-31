import { afterEach, describe, expect, it } from 'vitest';
import { MoqPublishVideo } from '../media';

customElements.define('test-moq-publish-video', MoqPublishVideo);

function createMoqPublishVideo(): MoqPublishVideo {
  const el = new MoqPublishVideo();
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
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

  it('selects and releases the capture source through the capture-source attribute', () => {
    const el = createMoqPublishVideo();

    el.setAttribute('capture-source', 'camera');
    expect(el.host.captureSource).toBe('camera');

    el.removeAttribute('capture-source');
    expect(el.host.captureSource).toBe(null);
  });
});
