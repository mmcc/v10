/**
 * MSF source resolution (draft-ietf-moq-msf-01 §11.1).
 *
 * What `state.presentation.url` actually _means_ for the MoQ engine: an MSF URL identifies a MOQT session (scheme +
 * authority + path + query) and, in its fragment, the track to start from — normally the catalog — plus client-side
 * key-value parameters (auth tokens, connection preference, subclip ranges, and free variables for catalog
 * substitution, §5.4).
 *
 *     moqt://relay.example.com/app?a=1#msf:customer-livestream-123--catalog&connection=wt&token=XYZ
 */

// ============================================================================
// Result model
// ============================================================================

export interface MoqLocationRange {
  start: { group: number; object: number };
  end?: { group: number; object?: number };
}

export interface MoqNumericRange {
  start: number;
  end?: number;
}

export interface MoqSource {
  /**
   * WebTransport connect URL — the moqt URI with its scheme replaced by https and the fragment stripped (moq-transport
   * §3.1.4).
   */
  connectUrl: string;
  /** The moqt URI without its fragment — the session identity. */
  sessionUri: string;
  /** Track namespace tuple decoded from the fragment's track identifier. */
  namespace: string[];
  /** Track name from the fragment — `'catalog'` for a standard MSF source. */
  trackName: string;
  /** `connection` fragment parameter (§11.1.1): `q` (native QUIC) or `wt`. */
  connection?: 'quic' | 'webtransport';
  /** Base64 CAT token from the `c4m` fragment parameter, verbatim. */
  c4mToken?: string;
  /** Subclip ranges (§11.1.1). Multiple ranges of one kind union. */
  wallclockRanges?: MoqNumericRange[];
  mediatimeRanges?: MoqNumericRange[];
  locationRanges?: MoqLocationRange[];
  /**
   * Every fragment parameter (first value wins for variable use), for MSF catalog variable substitution (§5.4) and
   * custom parameters.
   */
  fragmentParams: Record<string, string>;
}

// ============================================================================
// MSF namespace-name string decoding (moq-transport §1.5)
// ============================================================================

const LITERAL_CHAR = /^[a-zA-Z0-9_]$/;
const LOWER_HEX = /^[0-9a-f]{2}$/;

/**
 * Decode one MSF-encoded namespace field or track name: literal `[a-zA-Z0-9_]` bytes plus `.xx` lowercase-hex escapes
 * for every other UTF-8 byte (tuples are byte strings, §11.1.2). Rejects malformed and non-canonical encodings
 * (uppercase hex, redundant escapes of literal characters, invalid UTF-8) per moq-transport §1.5.1.
 */
function decodeNameComponent(encoded: string): string {
  const bytes: number[] = [];

  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i]!;

    if (char === '.') {
      const hex = encoded.slice(i + 1, i + 3);
      if (!LOWER_HEX.test(hex)) throw new Error(`invalid MSF name encoding: bad escape in ${JSON.stringify(encoded)}`);

      const byte = Number.parseInt(hex, 16);

      if (LITERAL_CHAR.test(String.fromCharCode(byte))) {
        throw new Error(`invalid MSF name encoding: redundant escape .${hex}`);
      }

      bytes.push(byte);
      i += 2;
    } else if (LITERAL_CHAR.test(char)) {
      bytes.push(char.charCodeAt(0));
    } else {
      throw new Error(`invalid MSF name encoding: unexpected character ${JSON.stringify(char)}`);
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(`invalid MSF name encoding: invalid UTF-8 in ${JSON.stringify(encoded)}`);
  }
}

/** Encode one namespace field or track name into the MSF string form. */
export function encodeNameComponent(value: string): string {
  let out = '';

  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);

    out += LITERAL_CHAR.test(char) ? char : `.${byte.toString(16).padStart(2, '0')}`;
  }

  return out;
}

/** Decode an MSF namespace-name string (`ns1-ns2--name`, §11.1.2) into the namespace tuple and track name. */
export function decodeNamespaceName(identifier: string): { namespace: string[]; trackName: string } {
  const splitAt = identifier.indexOf('--');
  if (splitAt < 0) throw new Error(`MSF track identifier is missing the '--' namespace/name delimiter: ${identifier}`);

  const namespacePart = identifier.slice(0, splitAt);
  const namePart = identifier.slice(splitAt + 2);
  const namespace = namespacePart.length === 0 ? [] : namespacePart.split('-').map(decodeNameComponent);

  return { namespace, trackName: decodeNameComponent(namePart) };
}

/**
 * Encode a namespace tuple + track name into the MSF namespace-name string (`ns1-ns2--name`, §11.1.2) — the identifier
 * that follows `#msf:` in a source URL. The inverse of what `parseMoqSource` decodes, for callers composing a source
 * URL from structured parts.
 */
export function encodeNamespaceName(namespace: readonly string[], trackName: string): string {
  return `${namespace.map(encodeNameComponent).join('-')}--${encodeNameComponent(trackName)}`;
}

// ============================================================================
// Range parameter parsing (§11.1.1)
// ============================================================================

function parseNumericRange(value: string): MoqNumericRange {
  const [start, end] = value.split('-');
  const startValue = Number(start);
  if (!Number.isFinite(startValue)) throw new Error(`invalid range start: ${value}`);

  if (end === undefined || end === '') return { start: startValue };

  const endValue = Number(end);
  if (!Number.isFinite(endValue)) throw new Error(`invalid range end: ${value}`);

  return { start: startValue, end: endValue };
}

function parseLocation(value: string): { group: number; object?: number } {
  const [group, object] = value.split('.');
  const groupValue = Number(group);
  if (!Number.isFinite(groupValue)) throw new Error(`invalid location: ${value}`);

  if (object === undefined) return { group: groupValue };

  const objectValue = Number(object);
  if (!Number.isFinite(objectValue)) throw new Error(`invalid location: ${value}`);

  return { group: groupValue, object: objectValue };
}

function parseLocationRange(value: string): MoqLocationRange {
  const [startPart, endPart] = value.split('-');
  if (startPart === undefined || startPart === '') throw new Error(`invalid location range: ${value}`);

  const start = parseLocation(startPart);

  if (endPart === undefined || endPart === '') {
    return { start: { group: start.group, object: start.object ?? 0 } };
  }

  return { start: { group: start.group, object: start.object ?? 0 }, end: parseLocation(endPart) };
}

// ============================================================================
// Source parsing
// ============================================================================

/**
 * Parse an MSF URL into its session, track, and client-parameter parts. Throws on non-`moqt:` schemes, a
 * missing/invalid `msf:` fragment, or a malformed track identifier — the caller treats that as an unplayable source,
 * not a recoverable state.
 */
export function parseMoqSource(url: string): MoqSource {
  const hashIndex = url.indexOf('#');
  const withoutFragment = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : url.slice(hashIndex + 1);

  const parsed = new URL(withoutFragment);
  if (parsed.protocol !== 'moqt:') throw new Error(`not a moqt URL: ${url}`);

  if (!fragment.startsWith('msf:')) {
    throw new Error(`MSF URL is missing its 'msf:' fragment: ${url}`);
  }

  const [identifier = '', ...parameterParts] = fragment.slice('msf:'.length).split('&');
  const { namespace, trackName } = decodeNamespaceName(decodeURIComponent(identifier));

  const source: MoqSource = {
    connectUrl: `https:${withoutFragment.slice('moqt:'.length)}`,
    sessionUri: withoutFragment,
    namespace,
    trackName,
    fragmentParams: {},
  };

  for (const part of parameterParts) {
    const equalsIndex = part.indexOf('=');
    const name = equalsIndex < 0 ? part : part.slice(0, equalsIndex);
    const value = equalsIndex < 0 ? '' : decodeURIComponent(part.slice(equalsIndex + 1));

    source.fragmentParams[name] ??= value;

    switch (name) {
      case 'connection':
        if (value !== 'q' && value !== 'wt') throw new Error(`invalid connection parameter: ${value}`);

        source.connection = value === 'q' ? 'quic' : 'webtransport';
        break;
      case 'c4m':
        source.c4mToken = value;
        break;
      case 'wallclock-range':
        (source.wallclockRanges ??= []).push(parseNumericRange(value));
        break;
      case 'mediatime-range':
        (source.mediatimeRanges ??= []).push(parseNumericRange(value));
        break;
      case 'location-range':
        (source.locationRanges ??= []).push(parseLocationRange(value));
        break;
      default:
        // Free variable for catalog substitution (§5.4) — already recorded.
        break;
    }
  }

  return source;
}

/** Whether a presentation URL is an MSF/MoQ source this engine can handle. */
export function isMoqSourceUrl(url: string): boolean {
  return url.startsWith('moqt://');
}

// ============================================================================
// Source composition
// ============================================================================

export interface ComposeMoqSourceOptions {
  /** Track to start from — `'catalog'` (the MSF standard entry) when omitted. */
  trackName?: string;
  /** Auth token to attach as the `c4m` fragment parameter (MSF §11.4). */
  token?: string;
}

/**
 * Compose an MSF source URL — the inverse of `parseMoqSource` — from a relay origin, a broadcast namespace, and an
 * optional auth token, so callers with structured inputs (a relay endpoint plus the path a token was issued for) never
 * hand-write the `#msf:` fragment encoding.
 *
 * The origin may be written as `moqt://`, as `https://` (how relay endpoints are usually recorded — the scheme the
 * connect URL derives back to), or as a bare host; schemes are case-insensitive. An existing path and query survive; a
 * fragment throws, because the fragment is where the composed `msf:` identifier goes. The namespace is a
 * slash-separated path (`'customer/room/42'`, empty segments dropped) or a pre-split tuple for fields containing a
 * literal `/` — tuple fields must be non-empty.
 */
export function composeMoqSource(
  origin: string,
  namespace: string | readonly string[],
  options: ComposeMoqSourceOptions = {}
): string {
  let base = origin.trim();
  if (base.length === 0) throw new Error('relay origin is empty');

  base = base.replace(/^https:\/\//i, 'moqt://');

  if (!base.includes('://')) base = `moqt://${base}`;

  if (base.includes('#')) {
    throw new Error(`relay origin must not carry a fragment: ${origin}`);
  }

  const parsed = new URL(base);
  if (parsed.protocol !== 'moqt:') throw new Error(`not a moqt or https relay origin: ${origin}`);

  // moqt: is not a URL special scheme, so a bare-authority origin keeps an
  // empty pathname instead of gaining '/' — normalize before appending.
  if (parsed.pathname === '') parsed.pathname = '/';

  const tuple = typeof namespace === 'string' ? namespace.split('/').filter((field) => field.length > 0) : namespace;
  if (tuple.length === 0) throw new Error('broadcast namespace is empty');

  // Only reachable via the pre-split form — the string form drops empties as
  // slash-formatting noise. A tuple is precise input, and an empty field is
  // unencodable anyway: it would emit a bare '-' that collides with the '--'
  // name delimiter and compose an identifier the parser rejects. Erroring
  // beats silently composing a different namespace than the caller named.
  if (tuple.includes('')) throw new Error('namespace tuple fields must be non-empty');

  const identifier = encodeNamespaceName(tuple, options.trackName ?? 'catalog');
  const tokenPart = options.token ? `&c4m=${encodeURIComponent(options.token)}` : '';

  return `${parsed}#msf:${identifier}${tokenPart}`;
}
