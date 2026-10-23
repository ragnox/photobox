// HTTPS for the network listener. Photobox makes its own small certificate
// authority on first use and signs the server certificate with it. Installing
// that CA on a phone once makes its browser trust Photobox, which a browser
// requires before it lets you install the web app.
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';

const DAY = 86_400_000;
const CA_DAYS = 3650;
const SERVER_DAYS = 397; // browsers refuse server certificates valid for longer
const RENEW_DAYS = 30;

const serial = () => `01${crypto.randomBytes(15).toString('hex')}`; // positive, 128 bits

function rsaKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' })),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

function signed({ subject, issuer, publicKey, signingKey, days, extensions }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - DAY);
  cert.validity.notAfter = new Date(Date.now() + days * DAY);
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions(extensions);
  cert.sign(signingKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function makeCa() {
  const keys = rsaKeys();
  const subject = [{ name: 'commonName', value: `Photobox on ${os.hostname()}` }, { name: 'organizationName', value: 'Photobox' }];
  const cert = signed({
    subject, issuer: subject, publicKey: keys.publicKey, signingKey: keys.privateKey, days: CA_DAYS,
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ],
  });
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert };
}

function makeServer(ca, names) {
  const caCert = forge.pki.certificateFromPem(ca.cert);
  const keys = rsaKeys();
  const cert = signed({
    subject: [{ name: 'commonName', value: names[0] }],
    issuer: caCert.subject.attributes,
    publicKey: keys.publicKey,
    signingKey: forge.pki.privateKeyFromPem(ca.key),
    days: SERVER_DAYS,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: names.map((n) => (net.isIP(n) ? { type: 7, ip: n } : { type: 2, value: n })) },
    ],
  });
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert };
}

/** The host names and IP addresses a certificate is valid for. */
const altNames = (cert) => (cert.subjectAltName ?? '').split(', ').map((s) => s.replace(/^(DNS|IP Address):/, '')).filter(Boolean);

/** Is this server certificate from `ca`, valid for a while yet, and does it cover every name? */
function usable(server, ca, names) {
  try {
    const cert = new crypto.X509Certificate(server.cert);
    const issuer = new crypto.X509Certificate(ca.cert);
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return false;
    if (Date.parse(cert.validTo) - Date.now() < RENEW_DAYS * DAY) return false;
    const covered = new Set(altNames(cert));
    return names.every((n) => covered.has(n));
  } catch {
    return false;
  }
}

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

function write(file, pem, mode) {
  fs.writeFileSync(file, pem, { mode });
  fs.chmodSync(file, mode); // writeFileSync keeps the mode of an existing file
}

/**
 * The CA and a server certificate for `names` (host names and IP addresses) in
 * `dir`, made or renewed as needed. The CA is kept as long as it exists, so a
 * phone that trusts it keeps trusting Photobox when the server certificate is
 * renewed for a new address.
 */
export function ensureCertificates(dir, names) {
  names = [...new Set(names.filter(Boolean))];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {
    caKey: path.join(dir, 'ca-key.pem'), caCert: path.join(dir, 'ca.pem'),
    key: path.join(dir, 'server-key.pem'), cert: path.join(dir, 'server.pem'),
  };
  let ca = { key: read(files.caKey), cert: read(files.caCert) };
  if (!ca.key || !ca.cert) {
    ca = makeCa();
    write(files.caKey, ca.key, 0o600);
    write(files.caCert, ca.cert, 0o644);
  }
  let server = { key: read(files.key), cert: read(files.cert) };
  if (!server.key || !server.cert || !usable(server, ca, names)) {
    server = makeServer(ca, names);
    write(files.key, server.key, 0o600);
    write(files.cert, server.cert, 0o644);
  }
  const caX509 = new crypto.X509Certificate(ca.cert);
  return { key: server.key, cert: server.cert, ca: ca.cert, caDer: caX509.raw, fingerprint: caX509.fingerprint256, names };
}

/** A certificate you brought yourself (from `tailscale cert`, mkcert, ...), with the names it is valid for. */
export function loadCertificates(certFile, keyFile) {
  const cert = fs.readFileSync(certFile, 'utf8');
  const names = altNames(new crypto.X509Certificate(cert));
  return { key: fs.readFileSync(keyFile, 'utf8'), cert, ca: null, caDer: null, fingerprint: null, names };
}
