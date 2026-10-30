// Access from other devices (phones) on your network or VPN: one-time pairing
// codes made on this computer, and the device tokens they are traded for.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ensureCertificates, loadCertificates } from './tls.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const SEEN_EVERY_MS = 60 * 1000;
const COOKIE = 'photobox_device';
const COOKIE_DAYS = 400; // the longest browsers keep a cookie

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const deviceName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Device';

/** Out-of-band public trust anchor: native clients verify TLS before redeeming the code. */
export function nativePairingPayload(network, server, code, expiresAt) {
  const cert = new crypto.X509Certificate(network.tls.ca ?? network.tls.cert);
  return JSON.stringify({
    type: 'photobox-pair', version: 1, server, code, expiresAt,
    trust: {
      kind: network.tls.ca ? 'ca' : 'certificate',
      sha256: crypto.createHash('sha256').update(cert.raw).digest('hex'),
      certificate: cert.raw.toString('base64'),
    },
  });
}

/** The device token a request carries: `Authorization: Bearer …` (apps) or the cookie (browsers). */
export function requestToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  // Tokens are base64url, written to the cookie as they are; nothing to decode.
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export const tokenCookie = (token) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`;

/**
 * Pairing codes live only in memory and work once. Device tokens are random,
 * and the library keeps only their SHA-256, so a copy of the database can't be
 * used to get in.
 */
export class Pairing {
  constructor(library, { ttl = CODE_TTL_MS } = {}) {
    this.library = library;
    this.ttl = ttl;
    this.codes = new Map(); // code -> expiry (epoch ms)
  }

  create() {
    this.#prune();
    const code = randomToken(16);
    const expiresAt = Date.now() + this.ttl;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** Trade a code for a new device and its token, or null if the code is unknown, used or expired. */
  redeem(code, name) {
    this.#prune();
    if (typeof code !== 'string' || !this.codes.has(code)) return null;
    this.codes.delete(code);
    const token = randomToken(32);
    const device = this.library.addDevice(deviceName(name), hashToken(token));
    return { token, device };
  }

  /** The paired device a token belongs to, or null. */
  authenticate(token) {
    if (typeof token !== 'string' || !token) return null;
    const device = this.library.deviceByTokenHash(hashToken(token));
    if (!device) return null;
    if (!device.last_seen_at || Date.now() - device.last_seen_at > SEEN_EVERY_MS) this.library.touchDevice(device.id);
    return device;
  }

  #prune() {
    const now = Date.now();
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }
}

/** IPv4 addresses other devices can reach this computer at: Wi-Fi, Ethernet, VPN. */
function networkAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/**
 * What the network listener needs: pairing, the certificate, and the URLs to
 * reach it at. `address` is one address, or 0.0.0.0 for every network this
 * computer is on. Uses your own certificate if given, otherwise one from
 * Photobox's own CA. `port` is filled in once the listener is up.
 */
export function networkAccess(config, library, { address, tlsCert, tlsKey }) {
  const everywhere = address === '0.0.0.0' || address === '::';
  const addresses = everywhere ? networkAddresses() : [address];
  const tls = tlsCert
    ? loadCertificates(tlsCert, tlsKey)
    : ensureCertificates(path.join(config.dataDir, 'tls'), ['localhost', os.hostname(), ...addresses]);
  // A brought certificate is only valid for its own names; ours covers the addresses.
  const hosts = tls.ca ? addresses : tls.names.filter((n) => !n.startsWith('*'));
  const network = {
    pairing: new Pairing(library),
    tls,
    port: null,
    info: () => ({
      urls: hosts.map((h) => `https://${h.includes(':') ? `[${h}]` : h}:${network.port}`),
      fingerprint: tls.fingerprint,
    }),
  };
  return network;
}
