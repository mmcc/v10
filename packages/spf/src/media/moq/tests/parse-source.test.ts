import { describe, expect, it } from 'vitest';
import {
  composeMoqSource,
  decodeNamespaceName,
  encodeNamespaceName,
  isMoqSourceUrl,
  parseMoqSource,
} from '../parse-source';

describe('parseMoqSource', () => {
  it('parses the msf-01 §11.1.3 catalog example', () => {
    const source = parseMoqSource('moqt://example.com/server/config?a=1&b=2#msf:customer-livestream-123--catalog');
    expect(source).toMatchObject({
      connectUrl: 'https://example.com/server/config?a=1&b=2',
      sessionUri: 'moqt://example.com/server/config?a=1&b=2',
      namespace: ['customer', 'livestream', '123'],
      trackName: 'catalog',
    });
  });

  it('parses reserved fragment parameters', () => {
    const source = parseMoqSource(
      'moqt://relay.example.com/live#msf:ns--catalog&connection=wt&c4m=abc123&wallclock-range=100-200&location-range=16.24'
    );
    expect(source.connection).toBe('webtransport');
    expect(source.c4mToken).toBe('abc123');
    expect(source.wallclockRanges).toEqual([{ start: 100, end: 200 }]);
    expect(source.locationRanges).toEqual([{ start: { group: 16, object: 24 } }]);
  });

  it('parses connection=q as native QUIC', () => {
    const source = parseMoqSource('moqt://example.com/relay#msf:a-b--catalog&connection=q');
    expect(source.connection).toBe('quic');
  });

  it('collects free parameters for variable substitution', () => {
    const source = parseMoqSource('moqt://example.com/live#msf:ns--catalog&token=XYZ789&userId=42');
    expect(source.fragmentParams).toMatchObject({ token: 'XYZ789', userId: '42' });
  });

  it('rejects non-moqt schemes and missing msf fragments', () => {
    expect(() => parseMoqSource('https://example.com/live#msf:ns--catalog')).toThrow();
    expect(() => parseMoqSource('moqt://example.com/live')).toThrow();
    expect(() => parseMoqSource('moqt://example.com/live#other:ns--catalog')).toThrow();
  });

  it('parses open and closed range forms', () => {
    const source = parseMoqSource(
      'moqt://h/p#msf:n--catalog&mediatime-range=982&location-range=34.0-2145.16&location-range=16-24'
    );
    expect(source.mediatimeRanges).toEqual([{ start: 982 }]);
    expect(source.locationRanges).toEqual([
      { start: { group: 34, object: 0 }, end: { group: 2145, object: 16 } },
      { start: { group: 16, object: 0 }, end: { group: 24 } },
    ]);
  });
});

describe('decodeNamespaceName', () => {
  it('decodes hex escapes (moq-transport §1.5 example)', () => {
    expect(decodeNamespaceName('example.2enet-team2-project_x--report')).toEqual({
      namespace: ['example.net', 'team2', 'project_x'],
      trackName: 'report',
    });
  });

  it('rejects uppercase hex, redundant escapes, and bad escapes', () => {
    expect(() => decodeNamespaceName('a.2E--t')).toThrow();
    expect(() => decodeNamespaceName('a.61--t')).toThrow(); // 'a' must be literal
    expect(() => decodeNamespaceName('a.--t')).toThrow();
    expect(() => decodeNamespaceName('ab--t.')).toThrow();
  });

  it('decodes multi-byte UTF-8 escapes as bytes, not code units', () => {
    expect(decodeNamespaceName('caf.c3.a9--t')).toEqual({
      namespace: ['café'],
      trackName: 't',
    });
  });

  it('rejects escape sequences that are not valid UTF-8', () => {
    expect(() => decodeNamespaceName('a.c3--t')).toThrow(/invalid UTF-8/); // truncated sequence
    expect(() => decodeNamespaceName('a.ff--t')).toThrow(/invalid UTF-8/);
  });

  it('rejects identifiers without the -- delimiter', () => {
    expect(() => decodeNamespaceName('just-a-namespace')).toThrow();
  });
});

describe('encodeNamespaceName', () => {
  it('round-trips names containing reserved characters', () => {
    const encoded = encodeNamespaceName(['example.net', 'team-2'], 'hi res');
    expect(decodeNamespaceName(encoded)).toEqual({
      namespace: ['example.net', 'team-2'],
      trackName: 'hi res',
    });
  });

  it('escapes non-ASCII names per UTF-8 byte and round-trips them', () => {
    expect(encodeNamespaceName(['café'], '中文')).toBe('caf.c3.a9--.e4.b8.ad.e6.96.87');
    expect(decodeNamespaceName(encodeNamespaceName(['café'], '中文'))).toEqual({
      namespace: ['café'],
      trackName: '中文',
    });
  });
});

describe('isMoqSourceUrl', () => {
  it('matches only moqt URLs', () => {
    expect(isMoqSourceUrl('moqt://example.com/live#msf:a--catalog')).toBe(true);
    expect(isMoqSourceUrl('https://example.com/live.m3u8')).toBe(false);
  });
});

describe('composeMoqSource', () => {
  it('composes a catalog source that round-trips through parseMoqSource', () => {
    const url = composeMoqSource('https://relay.example.com', 'customer/room/42', { token: 'tok.abc_1-2' });
    expect(url).toBe('moqt://relay.example.com/#msf:customer-room-42--catalog&c4m=tok.abc_1-2');
    expect(parseMoqSource(url)).toMatchObject({
      connectUrl: 'https://relay.example.com/',
      namespace: ['customer', 'room', '42'],
      trackName: 'catalog',
      c4mToken: 'tok.abc_1-2',
    });
  });

  it('accepts moqt origins, bare hosts, and case-insensitive schemes', () => {
    expect(composeMoqSource('moqt://relay.example.com', 'a/b')).toBe('moqt://relay.example.com/#msf:a-b--catalog');
    expect(composeMoqSource('relay.example.com:4443', 'a/b')).toBe('moqt://relay.example.com:4443/#msf:a-b--catalog');
    expect(composeMoqSource('HTTPS://relay.example.com', 'a/b')).toBe('moqt://relay.example.com/#msf:a-b--catalog');
  });

  it('preserves the origin path and query the session identity includes', () => {
    expect(composeMoqSource('https://relay.example.com/live?region=sjc', 'a/b')).toBe(
      'moqt://relay.example.com/live?region=sjc#msf:a-b--catalog'
    );
  });

  it('escapes namespace fields and tracks outside the literal set', () => {
    const url = composeMoqSource('relay.example.com', 'customer/room-2', { trackName: 'hi res' });
    expect(url).toBe('moqt://relay.example.com/#msf:customer-room.2d2--hi.20res');
    expect(parseMoqSource(url)).toMatchObject({
      namespace: ['customer', 'room-2'],
      trackName: 'hi res',
    });
  });

  it('accepts a pre-split tuple for fields containing a literal slash', () => {
    const url = composeMoqSource('relay.example.com', ['a/b', 'c']);
    expect(parseMoqSource(url).namespace).toEqual(['a/b', 'c']);
  });

  it('rejects empty origins, non-derivable schemes, fragments, and empty namespaces', () => {
    expect(() => composeMoqSource('', 'a/b')).toThrow(/empty/);
    expect(() => composeMoqSource('http://relay.example.com', 'a/b')).toThrow(/not a moqt or https/);
    expect(() => composeMoqSource('moqt://relay.example.com/#msf:a--catalog', 'a/b')).toThrow(/fragment/);
    expect(() => composeMoqSource('relay.example.com', '//')).toThrow(/empty/);
    expect(() => composeMoqSource('relay.example.com', [])).toThrow(/empty/);
  });

  it('rejects an empty field in a pre-split tuple instead of composing an unparseable identifier', () => {
    // ['a', '', 'b'] would encode as 'a--b', colliding with the '--' name
    // delimiter — and dropping the field would name a different broadcast.
    expect(() => composeMoqSource('relay.example.com', ['a', '', 'b'])).toThrow(/non-empty/);
  });

  it('percent-encodes token characters the fragment parser decodes back', () => {
    const url = composeMoqSource('relay.example.com', 'a', { token: 'a&b=c#d' });
    expect(parseMoqSource(url).c4mToken).toBe('a&b=c#d');
  });
});
