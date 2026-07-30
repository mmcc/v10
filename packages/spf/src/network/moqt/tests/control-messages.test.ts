import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, utf8Encode } from '../bytes';
import {
  ControlMessageDeframer,
  decodeControlMessage,
  decodeKeyValuePairs,
  decodeLocationFilter,
  decodeMessageParameters,
  encodeFetch,
  encodeFetchOk,
  encodeGoaway,
  encodeKeyValuePairs,
  encodeLocationFilter,
  encodeMessageParameters,
  encodePublishDone,
  encodePublishNamespace,
  encodeRequestError,
  encodeSetup,
  encodeSubscribe,
  encodeSubscribeOk,
  MESSAGE_TYPE,
  type MessageParameters,
  REQUEST_ERROR_CODE,
  SETUP_OPTION,
} from '../control-messages';
import { MoqtProtocolError } from '../errors';

function frames(...messages: Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(messages.reduce((total, m) => total + m.length, 0));
  let offset = 0;
  for (const message of messages) {
    merged.set(message, offset);
    offset += message.length;
  }
  return merged;
}

function decodeAll(bytes: Uint8Array) {
  const deframer = new ControlMessageDeframer();
  return deframer.push(bytes).map(decodeControlMessage);
}

describe('ControlMessageDeframer', () => {
  it('reassembles messages split across arbitrary chunk boundaries', () => {
    const encoded = frames(
      encodeSubscribe({ requestId: 0, trackNamespace: ['live', 'a'], trackName: 'video' }),
      encodeGoaway(250)
    );

    // Split at every possible boundary and confirm both frames come out.
    for (let split = 1; split < encoded.length; split++) {
      const deframer = new ControlMessageDeframer();
      const first = deframer.push(encoded.subarray(0, split));
      const second = deframer.push(encoded.subarray(split));
      const all = [...first, ...second];
      expect(all).toHaveLength(2);
      expect(all[0]!.type).toBe(MESSAGE_TYPE.SUBSCRIBE);
      expect(all[1]!.type).toBe(MESSAGE_TYPE.GOAWAY);
      expect(deframer.pendingBytes).toBe(0);
    }
  });

  it('yields one frame per push when messages arrive whole', () => {
    const deframer = new ControlMessageDeframer();
    expect(deframer.push(encodeGoaway(0))).toHaveLength(1);
    expect(deframer.push(encodePublishDone(0x2, 5, 'track ended'))).toHaveLength(1);
  });
});

describe('encodeSubscribe', () => {
  it('round-trips through the decoder', () => {
    const parameters: MessageParameters = {
      subscriberPriority: 16,
      groupOrder: 'ascending',
      locationFilter: { type: 'largest-object' },
      forward: 1,
    };
    const [message] = decodeAll(
      encodeSubscribe({ requestId: 4, trackNamespace: ['live', 'stream1'], trackName: 'catalog', parameters })
    );

    expect(message).toMatchObject({
      kind: 'subscribe',
      requestId: 4,
      trackNamespace: ['live', 'stream1'],
      trackName: 'catalog',
      parameters: {
        subscriberPriority: 16,
        groupOrder: 'ascending',
        locationFilter: { type: 'largest-object' },
        forward: 1,
      },
    });
  });

  it('rejects empty namespace fields', () => {
    expect(() => encodeSubscribe({ requestId: 0, trackNamespace: [''], trackName: 't' })).toThrow(MoqtProtocolError);
  });
});

describe('encodeFetch', () => {
  it('round-trips a standalone fetch', () => {
    const [message] = decodeAll(
      encodeFetch({
        requestId: 2,
        type: 'standalone',
        trackNamespace: ['live'],
        trackName: 'video',
        startLocation: { group: 10, object: 0 },
        endLocation: { group: 12, object: 0 },
      })
    );
    expect(message).toMatchObject({
      kind: 'fetch',
      request: {
        type: 'standalone',
        requestId: 2,
        startLocation: { group: 10, object: 0 },
        endLocation: { group: 12, object: 0 },
      },
    });
  });

  it('round-trips a relative joining fetch (the MSF catalog join shape)', () => {
    const [message] = decodeAll(
      encodeFetch({ requestId: 6, type: 'relative-joining', joiningRequestId: 4, joiningStart: 0 })
    );
    expect(message).toMatchObject({
      kind: 'fetch',
      request: { type: 'relative-joining', requestId: 6, joiningRequestId: 4, joiningStart: 0 },
    });
  });
});

describe('encodeSubscribeOk', () => {
  it('round-trips alias, parameters, and track properties', () => {
    const [message] = decodeAll(
      encodeSubscribeOk(7, { expires: 30_000, largestObject: { group: 41, object: 12 } }, [{ type: 0x02, value: 1 }])
    );
    expect(message).toMatchObject({
      kind: 'subscribe-ok',
      trackAlias: 7,
      parameters: { expires: 30_000, largestObject: { group: 41, object: 12 } },
    });
    expect(message).toHaveProperty('trackProperties', [{ type: 0x02, value: 1 }]);
  });
});

describe('encodeRequestError', () => {
  it('round-trips code, retry interval, and reason', () => {
    const [message] = decodeAll(encodeRequestError(REQUEST_ERROR_CODE.DOES_NOT_EXIST, 'no such track', 1500));
    expect(message).toEqual({
      kind: 'request-error',
      errorCode: REQUEST_ERROR_CODE.DOES_NOT_EXIST,
      retryInterval: 1500,
      reason: 'no such track',
    });
  });
});

describe('encodeSetup', () => {
  it('round-trips setup options as generic key-value pairs', () => {
    const [message] = decodeAll(
      encodeSetup([
        { type: SETUP_OPTION.MOQT_IMPLEMENTATION, value: utf8Encode('spf-test') },
        { type: SETUP_OPTION.MAX_REQUEST_UPDATES, value: 3 },
      ])
    );
    expect(message?.kind).toBe('setup');
    if (message?.kind !== 'setup') return;
    // Serialized in ascending type order regardless of input order.
    expect(message.options.map((o) => o.type)).toEqual([
      SETUP_OPTION.MOQT_IMPLEMENTATION,
      SETUP_OPTION.MAX_REQUEST_UPDATES,
    ]);
    expect(message.options[1]!.value).toBe(3);
  });
});

describe('encodeGoaway', () => {
  it('encodes a zero-length URI (client rule) and round-trips the timeout', () => {
    const [message] = decodeAll(encodeGoaway(500));
    expect(message).toEqual({ kind: 'goaway', newSessionUri: '', timeout: 500 });
  });
});

describe('encodePublishNamespace', () => {
  it('round-trips through the decoder', () => {
    const [message] = decodeAll(
      encodePublishNamespace({ requestId: 1, trackNamespace: ['anon'], parameters: { forward: 1 } })
    );
    expect(message).toMatchObject({
      kind: 'publish-namespace',
      requestId: 1,
      trackNamespace: ['anon'],
      parameters: { forward: 1 },
    });
  });
});

describe('decodeControlMessage', () => {
  it('throws MoqtProtocolError for unknown message types', () => {
    expect(() => decodeControlMessage({ type: 0x99, body: new Uint8Array(0) })).toThrow(MoqtProtocolError);
  });

  it('throws when the body has trailing bytes', () => {
    // GOAWAY body: uri length 0, timeout 0, plus a stray trailing byte.
    expect(() => decodeControlMessage({ type: MESSAGE_TYPE.GOAWAY, body: new Uint8Array([0, 0, 0xab]) })).toThrow(
      MoqtProtocolError
    );
  });
});

describe('encodeMessageParameters', () => {
  it('round-trips every supported parameter', () => {
    const parameters: MessageParameters = {
      objectDeliveryTimeout: 100,
      subgroupDeliveryTimeout: 200,
      authorizationTokens: [utf8Encode('tok-a'), utf8Encode('tok-b')],
      expires: 60_000,
      largestObject: { group: 100, object: 3 },
      forward: 0,
      subscriberPriority: 200,
      locationFilter: { type: 'absolute-range', start: { group: 5, object: 1 }, endGroupDelta: 4 },
      groupOrder: 'descending',
      newGroupRequest: 42,
    };
    const writer = new ByteWriter();
    encodeMessageParameters(writer, parameters);
    const decoded = decodeMessageParameters(new ByteReader(writer.toBytes()));
    expect(decoded).toEqual(parameters);
  });

  it('throws MoqtProtocolError on an unknown parameter type', () => {
    // Hand-craft: 1 parameter, type 0x99 (unknown).
    const writer = new ByteWriter();
    writer.writeVarint(1);
    writer.writeVarint(0x99);
    expect(() => decodeMessageParameters(new ByteReader(writer.toBytes()))).toThrow(MoqtProtocolError);
  });
});

describe('encodeLocationFilter', () => {
  it('round-trips all filter shapes', () => {
    const filters = [
      { type: 'largest-object' },
      { type: 'next-group-start' },
      { type: 'absolute-start', start: { group: 3, object: 9 } },
      { type: 'absolute-range', start: { group: 3, object: 9 }, endGroupDelta: 0 },
    ] as const;
    for (const filter of filters) {
      expect(decodeLocationFilter(encodeLocationFilter(filter))).toEqual(filter);
    }
  });

  it('rejects trailing bytes after the filter', () => {
    const encoded = encodeLocationFilter({ type: 'next-group-start' });
    const padded = new Uint8Array(encoded.length + 1);
    padded.set(encoded);
    expect(() => decodeLocationFilter(padded)).toThrow(MoqtProtocolError);
  });
});

describe('encodeFetchOk', () => {
  it('round-trips and rejects end-of-track values other than 0 and 1', () => {
    const notEnded = encodeFetchOk(false, { group: 3, object: 9 });
    const ended = encodeFetchOk(true, { group: 3, object: 9 });
    expect(decodeAll(notEnded)[0]).toMatchObject({ kind: 'fetch-ok', endOfTrack: false });
    expect(decodeAll(ended)[0]).toMatchObject({ kind: 'fetch-ok', endOfTrack: true });

    // The end-of-track byte is the single position where the two differ.
    const offset = notEnded.findIndex((byte, index) => byte !== ended[index]);
    const invalid = notEnded.slice();
    invalid[offset] = 2;
    expect(() => decodeAll(invalid)).toThrow(MoqtProtocolError);
  });
});

describe('encodeKeyValuePairs', () => {
  it('delta-encodes types and round-trips even/odd values', () => {
    const pairs = [
      { type: 0x02, value: 7 },
      { type: 0x07, value: utf8Encode('bytes') },
      { type: 0x08, value: 1_000_000 },
    ];
    const writer = new ByteWriter();
    encodeKeyValuePairs(writer, pairs);
    const bytes = writer.toBytes();
    // First delta is the absolute type (0x02), then 5, then 1.
    expect(bytes[0]).toBe(0x02);
    const decoded = decodeKeyValuePairs(new ByteReader(bytes), bytes.length);
    expect(decoded).toEqual(pairs);
  });
});
