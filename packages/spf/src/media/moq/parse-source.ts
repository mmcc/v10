/**
 * MSF source resolution (draft-ietf-moq-msf-01 §11.1).
 *
 * What `state.presentation.url` actually *means* for the MoQ engine: an
 * MSF URL identifies a MOQT session (scheme + authority + path + query)
 * and, in its fragment, the track to start from — normally the catalog —
 * plus client-side key-value parameters (auth tokens, connection
 * preference, subclip ranges, and free variables for catalog
 * substitution, §5.4).
 *
 * ```
 * moqt://relay.example.com/app?a=1#msf:customer-livestream-123--catalog&connection=wt&token=XYZ
 * ```
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
   * WebTransport connect URL — the moqt URI with its scheme replaced by
   * https and the fragment stripped (moq-transport §3.1.4).
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
   * Every fragment parameter (first value wins for variable use), for MSF
   * catalog variable substitution (§5.4) and custom parameters.
   */
  fragmentParams: Record<string, string>;
}

// ============================================================================
// MSF namespace-name string decoding (moq-transport §1.5)
// ============================================================================

const LITERAL_CHAR = /^[a-zA-Z0-9_]$/;
const LOWER_HEX = /^[0-9a-f]{2}$/;

/**
 * Decode one MSF-encoded namespace field or track name: literal
 * `[a-zA-Z0-9_]` bytes plus `.xx` lowercase-hex escapes for everything
 * else. Rejects malformed and non-canonical encodings (uppercase hex,
 * redundant escapes of literal characters) per moq-transport §1.5.1.
 */
function decodeNameComponent(encoded: string): string {
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    const char = encoded[i]!;
    if (char === '.') {
      const hex = encoded.slice(i + 1, i + 3);
      if (!LOWER_HEX.test(hex)) {
        throw new Error(`invalid MSF name encoding: bad escape in ${JSON.stringify(encoded)}`);
      }
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      if (LITERAL_CHAR.test(decoded)) {
        throw new Error(`invalid MSF name encoding: redundant escape .${hex}`);
      }
      out += decoded;
      i += 2;
    } else if (LITERAL_CHAR.test(char)) {
      out += char;
    } else {
      throw new Error(`invalid MSF name encoding: unexpected character ${JSON.stringify(char)}`);
    }
  }
  return out;
}

/** Encode one namespace field or track name into the MSF string form. */
export function encodeNameComponent(value: string): string {
  let out = '';
  for (const char of value) {
    if (LITERAL_CHAR.test(char)) {
      out += char;
    } else {
      for (let i = 0; i < char.length; i++) {
        out += `.${char.charCodeAt(i).toString(16).padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/**
 * Decode an MSF namespace-name string (`ns1-ns2--name`, §11.1.2) into the
 * namespace tuple and track name.
 */
export function decodeNamespaceName(identifier: string): { namespace: string[]; trackName: string } {
  const splitAt = identifier.indexOf('--');
  if (splitAt < 0) {
    throw new Error(`MSF track identifier is missing the '--' namespace/name delimiter: ${identifier}`);
  }
  const namespacePart = identifier.slice(0, splitAt);
  const namePart = identifier.slice(splitAt + 2);
  const namespace = namespacePart.length === 0 ? [] : namespacePart.split('-').map(decodeNameComponent);
  return { namespace, trackName: decodeNameComponent(namePart) };
}

/** Encode a namespace tuple + track name into the MSF string form. */
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
 * Parse an MSF URL into its session, track, and client-parameter parts.
 * Throws on non-`moqt:` schemes, a missing/invalid `msf:` fragment, or a
 * malformed track identifier — the caller treats that as an unplayable
 * source, not a recoverable state.
 */
export function parseMoqSource(url: string): MoqSource {
  const hashIndex = url.indexOf('#');
  const withoutFragment = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex < 0 ? '' : url.slice(hashIndex + 1);

  const parsed = new URL(withoutFragment);
  if (parsed.protocol !== 'moqt:') {
    throw new Error(`not a moqt URL: ${url}`);
  }
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
