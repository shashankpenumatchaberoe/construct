// The URL policy of Studio: what a storyboard, a chat request or a page probe may open. One place, so the storyboard
// validator, the page probe and the recorder's request guard cannot disagree.
//
// Rules: http and https only (no file:, data:, javascript:, ftp:, ...); no credentials in the URL; loopback, private,
// link-local and other non-public hosts are blocked unless the config sets allowPrivateNetwork. The decision is made on
// the host NAME or literal address (WHATWG URL parsing normalises decimal, hex and octal IPv4 and IPv6 forms first).
// DNS is not resolved here, so a public name that resolves to a private address is not caught by this check alone; the
// recorder's request guard covers that only for literal addresses. Documented limit, not hidden.
import net from 'node:net';

/** Named result codes of the URL policy (frozen). */
export const URL_CODES = Object.freeze({
  URL_INVALID: 'URL_INVALID',
  URL_SCHEME: 'URL_SCHEME',
  URL_CREDENTIALS: 'URL_CREDENTIALS',
  URL_PRIVATE_HOST: 'URL_PRIVATE_HOST',
  URL_CROSS_ORIGIN: 'URL_CROSS_ORIGIN',
});

const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

function ipv4Parts(host) {
  const p = host.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function privateV4([a, b]) {
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224; // multicast and reserved
}

/** Eight 16-bit groups of an IPv6 literal (brackets removed), or null. */
function ipv6Groups(host) {
  let h = host.toLowerCase();
  if (h.includes('%')) h = h.slice(0, h.indexOf('%'));
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (v4tail) {
    const p = ipv4Parts(v4tail[1]);
    if (!p) return null;
    h = h.slice(0, -v4tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** True when `hostname` (as in URL.hostname, IPv6 with or without brackets) is not a public host. Unparseable literals are
 * treated as private (fail closed). */
export function isPrivateHost(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIPv4(h)) return privateV4(ipv4Parts(h));
  if (h.includes(':')) {
    const g = ipv6Groups(h);
    if (!g) return true;
    const zeros = (n) => g.slice(0, n).every((x) => x === 0);
    if (zeros(8) || (zeros(7) && g[7] === 1)) return true; // :: and ::1
    if (zeros(5) && g[5] === 0xffff) return privateV4([g[6] >> 8, g[6] & 255]); // v4-mapped
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4([g[6] >> 8, g[6] & 255]); // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  if (!h.includes('.')) return true; // a bare intranet name
  return PRIVATE_SUFFIXES.some((s) => h.endsWith(s));
}

/**
 * Check one URL. `raw` may be relative when `baseUrl` is given (resolved against it).
 * Options: allowPrivateNetwork (default false), baseUrl, sameOrigin (default true when baseUrl is given).
 * Returns { ok: true, url } (url is the normalised href) or { ok: false, code, message }.
 */
export function checkUrl(raw, { allowPrivateNetwork = false, baseUrl, sameOrigin = Boolean(baseUrl) } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return { ok: false, code: URL_CODES.URL_INVALID, message: 'not a URL' };
  const text = raw.trim();
  let u;
  try { u = new URL(text, baseUrl || undefined); } catch { return { ok: false, code: URL_CODES.URL_INVALID, message: 'not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: URL_CODES.URL_SCHEME, message: `scheme "${u.protocol}" is not allowed; use http or https` };
  if (u.username || u.password) return { ok: false, code: URL_CODES.URL_CREDENTIALS, message: 'credentials in a URL are not allowed' };
  if (!allowPrivateNetwork && isPrivateHost(u.hostname)) {
    return { ok: false, code: URL_CODES.URL_PRIVATE_HOST, message: `host "${u.hostname}" is a local or private address; enable allowPrivateNetwork in the settings to record it` };
  }
  if (sameOrigin && baseUrl && u.origin !== new URL(baseUrl).origin) {
    return { ok: false, code: URL_CODES.URL_CROSS_ORIGIN, message: `${u.origin} is not the origin of the site being recorded (${new URL(baseUrl).origin})` };
  }
  u.hash = '';
  return { ok: true, url: u.href };
}
