import { afterEach, describe, expect, it, vi } from 'vitest';

describe('SSR-safe define imports', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('imports video skin without browser-only globals', async () => {
    vi.stubGlobal('customElements', undefined);
    vi.stubGlobal('CSSStyleSheet', undefined);

    await expect(import('../video/skin')).resolves.toBeDefined();
  });

  it('imports hls-video without customElements', async () => {
    vi.stubGlobal('customElements', undefined);

    await expect(import('../media/hls-video')).resolves.toBeDefined();
  });

  it('imports simple-moq-video without customElements or HTMLElement', async () => {
    vi.stubGlobal('customElements', undefined);
    vi.stubGlobal('HTMLElement', undefined);

    await expect(import('../media/simple-moq-video')).resolves.toBeDefined();
  });
});
