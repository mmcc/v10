/**
 * Publish-direction codec round-trips: the encode↔decode pairs the publish session exercises (the announce-and-serve
 * NAMESPACE entries, the SUBSCRIBE_OK/REQUEST_OK responses, inbound REQUEST_UPDATE, and the legacy PUBLISH/PUBLISH_DONE
 * shapes the codec keeps for symmetric fakes) against the existing decoders as the golden reference — plus byte-exact
 * pins where moq-lite-rs's decoder is stricter than a round-trip can prove.
 */
import { describe, expect, it } from 'vite-plus/test';

import { utf8Encode } from '../bytes';
import {
  ControlMessageDeframer,
  decodeControlMessage,
  encodeNamespace,
  encodeNamespaceDone,
  encodePublish,
  encodePublishDone,
  encodeRequestOk,
  encodeRequestUpdate,
  encodeSubscribeOk,
  PUBLISH_DONE_STATUS,
  TRACK_PROPERTY,
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

describe('encodeNamespace', () => {
  it('round-trips the announce entry', () => {
    const message = decodeOne(encodeNamespace(['live', 'abc123']));

    expect(message).toEqual({ kind: 'namespace', trackNamespaceSuffix: ['live', 'abc123'] });
  });

  it('writes the suffix tuple and nothing else', () => {
    // moq-lite-rs requires the body to END with the tuple: even a zero
    // parameter count after it is a WrongSize error that kills the
    // announce stream.
    expect(encodeNamespace(['abc123'])).toEqual(
      new Uint8Array([0x08, 0x00, 0x08, 0x01, 0x06, ...utf8Encode('abc123')])
    );
  });

  it('encodes announcing the prefix itself as an empty tuple', () => {
    expect(encodeNamespace([])).toEqual(new Uint8Array([0x08, 0x00, 0x01, 0x00]));
  });
});

describe('encodeNamespaceDone', () => {
  it('round-trips the retraction with the same body shape', () => {
    const message = decodeOne(encodeNamespaceDone(['live', 'abc123']));

    expect(message).toEqual({ kind: 'namespace-done', trackNamespaceSuffix: ['live', 'abc123'] });
    expect(encodeNamespaceDone(['abc123'])).toEqual(
      new Uint8Array([0x0e, 0x00, 0x08, 0x01, 0x06, ...utf8Encode('abc123')])
    );
  });
});

describe('decodeControlMessage', () => {
  it('accepts a SUBSCRIBE laid out exactly as moq-lite-rs writes it', () => {
    // Hand-assembled from the relay's `write_subscribe` at moq-relay
    // 0.14.14 on draft-20: delta-encoded ascending parameter types;
    // FORWARD (0x10), SUBSCRIBER_PRIORITY (0x20), and GROUP_ORDER (0x22)
    // as single RAW bytes (not varints — pinned with a priority of 0x80,
    // which a varint decoder would misread as a two-byte prefix);
    // LOCATION_FILTER (0x21) length-prefixed holding the single field 0x1
    // (`relative-group 1`: the current group from object 0).
    const body = [
      0x05, // request id
      0x02, // namespace: 2 fields
      0x04,
      ...utf8Encode('live'),
      0x06,
      ...utf8Encode('abc123'),
      0x05, // track name
      ...utf8Encode('video'),
      0x04, // parameter count
      0x10, // +0x10 → FORWARD
      0x01, //   raw byte: true
      0x10, // +0x10 → SUBSCRIBER_PRIORITY
      0x80, //   raw byte 128
      0x01, // +0x01 → LOCATION_FILTER
      0x01, //   length 1
      0x01, //   relative-group 1
      0x01, // +0x01 → GROUP_ORDER
      0x02, //   raw byte: descending
    ];
    const message = decodeOne(new Uint8Array([0x03, 0x00, body.length, ...body]));

    expect(message).toEqual({
      kind: 'subscribe',
      requestId: 5,
      trackNamespace: ['live', 'abc123'],
      trackName: 'video',
      parameters: {
        forward: 1,
        subscriberPriority: 0x80,
        locationFilter: { type: 'relative-group', groupsBeforeNext: 1 },
        groupOrder: 'descending',
      },
    });
  });
});

describe('encodeRequestOk (draft-20 byte shape)', () => {
  it('emits the bare parameter-count body a solicitation acceptance needs', () => {
    // The publisher's REQUEST_OK to a SUBSCRIBE_NAMESPACE carries no
    // request id and no parameters — moq-lite-rs decodes exactly
    // `[type][u16 1][0x00]` and anything longer is a decode error on the
    // announce path.
    expect(encodeRequestOk()).toEqual(new Uint8Array([0x07, 0x00, 0x01, 0x00]));
  });
});

describe('encodeSubscribeOk (serving shape)', () => {
  it('carries the alias, no parameters, and the microsecond TIMESCALE property', () => {
    const bytes = encodeSubscribeOk(11, {}, [{ type: TRACK_PROPERTY.TIMESCALE, value: 1_000_000 }]);
    const message = decodeOne(bytes);

    expect(message).toEqual({
      kind: 'subscribe-ok',
      trackAlias: 11,
      parameters: {},
      trackProperties: [{ type: TRACK_PROPERTY.TIMESCALE, value: 1_000_000 }],
    });
  });
});
