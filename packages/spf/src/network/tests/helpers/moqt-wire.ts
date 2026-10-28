/**
 * Relay-side MOQT codec for the in-memory fake relays in SPF's tests.
 *
 * The player and the publisher speak MOQT through `@caprid/moq-core`, whose public entry exports only each endpoint's
 * own surface. A fake relay also needs the other side of the wire — server SETUP, SUBSCRIBE_NAMESPACE and SUBSCRIBE
 * encoding, SUBSCRIBE_OK, REQUEST_ERROR, PUBLISH_DONE and the object stream readers — so this re-exports the package's
 * own codec modules instead of keeping a second implementation that could drift from the one the engines run. The deep
 * path bypasses the package's `exports` map on purpose; it is test-only, and a package release that moves these modules
 * fails the tests loudly rather than silently.
 */
export { StreamReader, utf8Encode } from '../../../../node_modules/@caprid/moq-core/dist/protocol/bytes.js';
export {
  type ControlMessage,
  ControlMessageDeframer,
  decodeControlMessage,
  encodeGoaway,
  encodePublish,
  encodePublishDone,
  encodeRequestError,
  encodeSetup,
  encodeSubscribe,
  encodeSubscribeNamespace,
  encodeSubscribeOk,
} from '../../../../node_modules/@caprid/moq-core/dist/protocol/control-messages.js';
export {
  isSubgroupHeaderType,
  readFetchHeader,
  readSubgroupHeader,
  readSubgroupObjects,
  STREAM_TYPE,
} from '../../../../node_modules/@caprid/moq-core/dist/protocol/object-stream.js';
export { decodeVarint, encodeVarint } from '../../../../node_modules/@caprid/moq-core/dist/protocol/varint.js';
