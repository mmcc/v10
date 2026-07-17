import { describe, expect, it } from 'vitest';
import { decodeNamespaceName, encodeNamespaceName, isMoqSourceUrl, parseMoqSource } from '../parse-source';

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
});

describe('isMoqSourceUrl', () => {
  it('matches only moqt URLs', () => {
    expect(isMoqSourceUrl('moqt://example.com/live#msf:a--catalog')).toBe(true);
    expect(isMoqSourceUrl('https://example.com/live.m3u8')).toBe(false);
  });
});
