import { cleanup, render } from '@testing-library/react';
import { MoqPublishMedia } from '@videojs/spf/moq-publish-video';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { MoqPublishVideo } from '../moq-publish-video';

afterEach(cleanup);

describe('MoqPublishVideo', () => {
  it('renders a muted, inline, autoplaying preview video', () => {
    const { container } = render(<MoqPublishVideo data-testid="preview" />);

    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video).toBeTruthy();
    expect(video.getAttribute('data-testid')).toBe('preview');
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(true);
  });

  it('keeps the preview muted even when a caller passes muted={false}', () => {
    // A caller prop must not win over the enforced preview attributes: an
    // unmuted local monitor feeds an attached microphone back through the
    // speakers.
    const { container, rerender } = render(<MoqPublishVideo muted={false} autoPlay={false} />);

    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video.muted).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(true);

    // Re-renders must not re-apply the caller's value either.
    rerender(<MoqPublishVideo muted={false} autoPlay={false} data-marker="second" />);
    expect(video.muted).toBe(true);
  });

  it('forwards publisher props to the media host instead of the video element', () => {
    const publishEndpoint = vi.spyOn(MoqPublishMedia.prototype, 'publishEndpoint', 'set');

    const { container } = render(<MoqPublishVideo publishEndpoint="https://relay.example.com/moq" />);

    expect(publishEndpoint).toHaveBeenCalledWith('https://relay.example.com/moq');
    // The publisher prop is consumed by the media host, not spread onto the element.
    const video = container.querySelector('video') as HTMLVideoElement;

    expect(video.hasAttribute('publishendpoint')).toBe(false);

    publishEndpoint.mockRestore();
  });

  it('forwards device and mute-toggle props to the media host', () => {
    const videoInputDeviceId = vi.spyOn(MoqPublishMedia.prototype, 'videoInputDeviceId', 'set');
    const cameraMuted = vi.spyOn(MoqPublishMedia.prototype, 'cameraMuted', 'set');

    render(<MoqPublishVideo videoInputDeviceId="cam-1" cameraMuted />);

    expect(videoInputDeviceId).toHaveBeenCalledWith('cam-1');
    expect(cameraMuted).toHaveBeenCalledWith(true);

    videoInputDeviceId.mockRestore();
    cameraMuted.mockRestore();
  });
});
