import '@app/styles.css';
// React MoQ Publisher sandbox
// http://localhost:5173/react-moq-publisher/
//
// Renders the React publisher preset (`PublisherSkin` over `publisherFeatures`).
// The default mode reuses the fake publish host from the HTML publisher
// sandbox: real capture, fake publish transport — no relay required.
//
//   (default)          real capture, fake publish transport (FakePublishMedia)
//   ?real              publish to an actual MoQ relay via <MoqPublishVideo>
//   ?relay=<url>       relay endpoint for ?real (default https://relay.quic.video)
//   ?ns=<namespace>    publish namespace for ?real (default: random name)
//   ?styling=tailwind  use the Tailwind skin twin

import { SandboxI18nProvider } from '@app/shared/react/sandbox-i18n';
import type { Styling } from '@app/types';
import { createPlayer, useComposedRefs, useMediaInstance } from '@videojs/react';
import { MoqPublishVideo, PublisherSkin, PublisherSkinTailwind, publisherFeatures } from '@videojs/react/publisher';
import { type ComponentProps, forwardRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { FakePublishMedia } from '../moq-publisher/fake-media';

const params = new URLSearchParams(location.search);
const styling: Styling = params.get('styling') === 'tailwind' ? 'tailwind' : 'css';
const real = params.has('real');
const relay = params.get('relay') || 'https://relay.quic.video';
const namespace = params.get('ns') || `vjs-sandbox-${Math.random().toString(36).slice(2, 8)}`;

if (styling === 'css') await import('@videojs/react/publisher/skin.css');

const { Provider } = createPlayer({ features: publisherFeatures });

/**
 * Fake twin of `MoqPublishVideo` — the same preview `<video>` wired to
 * `FakePublishMedia` (real capture, simulated publish session and stats).
 */
const FakePublishVideo = forwardRef<HTMLVideoElement, ComponentProps<'video'>>(function FakePublishVideo(props, ref) {
  const media = useMediaInstance(FakePublishMedia);
  const attachRef = useCallback(
    (element: HTMLVideoElement | null) => {
      if (element) media.attach(element);
      else media.detach();
    },
    [media]
  );
  const composedRef = useComposedRefs(attachRef, ref);

  return <video muted playsInline autoPlay ref={composedRef} {...props} />;
});

function App() {
  const Skin = styling === 'tailwind' ? PublisherSkinTailwind : PublisherSkin;

  return (
    <SandboxI18nProvider>
      <Provider>
        <Skin className="aspect-video w-full max-w-4xl mx-auto">
          {real ? <MoqPublishVideo publishEndpoint={relay} publishNamespace={namespace} /> : <FakePublishVideo />}
        </Skin>
      </Provider>
    </SandboxI18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
