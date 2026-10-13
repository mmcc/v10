import '@app/styles.css';
// React MoQ Publisher sandbox
// http://localhost:5173/moq-publisher-react/
//
// Renders the React publisher preset (`PublisherSkin` over `publisherFeatures`).
// The default mode reuses the fake publish host from the HTML publisher
// sandbox: real capture, fake publish transport — no relay required.
//
//   (default)          real capture, fake publish transport (FakePublishMedia)
//   ?real              publish to an actual MoQ relay via <MoqPublishVideo>
//   ?relay=<url>       relay endpoint for ?real (default https://relay.mux.dev)
//   ?ns=<namespace>    publish namespace for ?real (default: random name)
//   ?styling=tailwind  compile the skin's Tailwind styling from its authored source
import { SandboxI18nProvider } from '@app/shared/react/sandbox-i18n';
import type { Styling } from '@app/types';
import { createPlayer, useComposedRefs, useMediaInstance } from '@videojs/react';
import { MoqPublishVideo, PublisherSkin, publisherFeatures } from '@videojs/react/publisher';
import { type ComponentProps, forwardRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

import { FakePublishMedia } from '../moq-publisher/fake-media';

const params = new URLSearchParams(location.search);
const styling: Styling = params.get('styling') === 'tailwind' ? 'tailwind' : 'css';
const real = params.has('real');
// The draft-19 relay verified by the moq-relay-interop template;
// relay.quic.video speaks moq-lite, not this engine's draft.
const relay = params.get('relay') || 'https://relay.mux.dev';
const namespace = params.get('ns') || `vjs-sandbox-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The packages ship only the CSS skin, so Tailwind compiles the authored source on request, as the shell does for the
 * playback skins.
 */
async function loadSkin(): Promise<typeof PublisherSkin> {
  if (styling === 'css') {
    await import('@videojs/react/publisher/skin.css');

    return PublisherSkin;
  }

  const [authored] = await Promise.all([
    import('../../../../packages/skins/src/presets/publisher/skin.tsx?style=tailwind&target=react&skin=default-publisher&theme=default'),
    import('@app/styles.authored.css'),
  ]);

  return authored.PublisherSkin;
}

const Skin = await loadSkin();

const { Player } = createPlayer({ features: publisherFeatures });

/**
 * Fake twin of `MoqPublishVideo` — the same preview `<video>` wired to `FakePublishMedia` (real capture, simulated
 * publish session and stats).
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
  return (
    <SandboxI18nProvider>
      <Player>
        <Skin className="mx-auto aspect-video w-full max-w-4xl">
          {real ? <MoqPublishVideo publishEndpoint={relay} publishNamespace={namespace} /> : <FakePublishVideo />}
        </Skin>
      </Player>
    </SandboxI18nProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
