/**
 * Relay-side MOQT codec for the in-memory fake relays in SPF's tests.
 *
 * The player speaks MOQT through `@caprid/moq-core`, whose public entry exports only the subscriber's surface. A fake
 * relay also needs the other side of the wire — server SETUP, SUBSCRIBE decoding, SUBSCRIBE_OK and REQUEST_ERROR — so
 * this re-exports the package's own codec modules instead of keeping a second implementation that could drift from the
 * one the player runs. The deep path bypasses the package's `exports` map on purpose; it is test-only, and a package
 * release that moves these modules fails the tests loudly rather than silently.
 */
export { StreamReader, utf8Encode } from '../../../../node_modules/@caprid/moq-core/dist/protocol/bytes.js';
export {
  type ControlMessage,
  decodeControlMessage,
  encodeRequestError,
  encodeSetup,
  encodeSubscribeOk,
} from '../../../../node_modules/@caprid/moq-core/dist/protocol/control-messages.js';
