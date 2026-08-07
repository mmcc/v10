/**
 * Publish-direction codec round-trips. The codec in `control-messages.ts`
 * is already symmetric — the encoders below exist for the inbound-PUBLISH
 * path and the in-memory fake peer — so the publisher needs no new
 * message codecs; these tests pin the exact encode↔decode pairs the
 * publish session exercises (PUBLISH offers, PUBLISH_DONE, the
 * SUBSCRIBE_OK/REQUEST_OK responses, and inbound REQUEST_UPDATE) against
 * the existing decoders as the golden reference.
 */
import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../bytes';
import {
  ControlMessageDeframer,
  decodeControlMessage,
  encodePublish,
  encodePublishDone,
  encodeRequestOk,
  encodeRequestUpdate,
  encodeSubscribeOk,
  PUBLISH_DONE_STATUS,
} from '../control-messages';

function decodeOne(bytes: Uint8Array) {
  const frames = new ControlMessageDeframer().push(bytes);
  expect(frames).toHaveLength(1);
  return decodeControlMessage(frames[0]!);
}

describe('encodePublish', () => {
  it('round-trips the publisher-initiated track offer', () => {
    const message = decodeOne(
      encodePublish(
        {
          requestId: 4,
          trackNamespace: ['live', 'abc123'],
          trackName: 'video',
          trackAlias: 2,
          parameters: { forward: 1, authorizationTokens: [utf8Encode('token')] },
        },
        [{ type: 0x02, value: 7 }]
      )
    );
    expect(message).toEqual({
      kind: 'publish',
      requestId: 4,
      trackNamespace: ['live', 'abc123'],
      trackName: 'video',
      trackAlias: 2,
      parameters: { forward: 1, authorizationTokens: [utf8Encode('token')] },
      trackProperties: [{ type: 0x02, value: 7 }],
    });
  });
});

describe('encodePublishDone', () => {
  it('round-trips status, stream count, and reason', () => {
    const message = decodeOne(encodePublishDone(PUBLISH_DONE_STATUS.TRACK_ENDED, 12, 'stopped'));
    expect(message).toEqual({
      kind: 'publish-done',
      statusCode: PUBLISH_DONE_STATUS.TRACK_ENDED,
      streamCount: 12,
      reason: 'stopped',
    });
  });
});

describe('encodeSubscribeOk', () => {
  it('round-trips the publisher answer to an inbound SUBSCRIBE', () => {
    const message = decodeOne(encodeSubscribeOk(5, { expires: 0 }, [{ type: 0x02, value: 1 }]));
    expect(message).toEqual({
      kind: 'subscribe-ok',
      trackAlias: 5,
      parameters: { expires: 0 },
      trackProperties: [{ type: 0x02, value: 1 }],
    });
  });
});

describe('encodeRequestOk', () => {
  it('round-trips the PUBLISH_OK-role response with parameters', () => {
    const message = decodeOne(encodeRequestOk({ forward: 1 }));
    expect(message).toEqual({ kind: 'request-ok', parameters: { forward: 1 }, trackProperties: [] });
  });
});

describe('encodeRequestUpdate', () => {
  it('round-trips the update a publisher receives on its request streams', () => {
    const message = decodeOne(encodeRequestUpdate(4, { forward: 0, subscriberPriority: 8 }));
    expect(message).toEqual({
      kind: 'request-update',
      requestId: 4,
      parameters: { forward: 0, subscriberPriority: 8 },
    });
  });
});
