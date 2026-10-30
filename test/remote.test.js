// Network access: the HTTPS listener for paired devices, pairing, and the certificates behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { createApp } from '../src/server.js';
import { networkAccess, hashToken, nativePairingPayload } from '../src/remote.js';
import { ensureCertificates } from '../src/tls.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));

/** A library with both listeners running: `local` (http, loopback) and `remote` (https, paired devices only). */
async function setup(t, { ttl } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-remote-'));
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  const indexer = new Indexer(library, config);
  const watcher = { watchSource() {}, async unwatch() {} };
  const network = networkAccess(config, library, { address: '127.0.0.1' });
  if (ttl) network.pairing.ttl = ttl;
  const { tls } = network;
  const deps = { library, indexer, watcher, config, network };
  const localServer = await listen(http.createServer(createApp(deps)));
  const remoteServer = await listen(https.createServer({ key: tls.key, cert: tls.cert }, createApp(deps, { remote: true })));
  network.port = remoteServer.address().port;
  t.after(async () => {
    for (const s of [localServer, remoteServer]) {
      s.closeAllConnections();
      s.close();
    }
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const client = (server, secure) => (method, urlPath, { body, token, cookie, headers = {} } = {}) => new Promise((resolve, reject) => {
    const h = { Host: `localhost:${server.address().port}`, ...headers };
    if (body !== undefined) h['Content-Type'] ??= 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    if (cookie) h.Cookie = cookie;
    const req = (secure ? https : http).request({
      host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers: h, agent: false,
      ...(secure ? { ca: tls.ca, servername: 'localhost' } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });

  return { library, tls, local: client(localServer, false), remote: client(remoteServer, true) };
}

/** Make a pairing code on the computer and redeem it from "the phone". */
async function pair({ local, remote }, name = 'Pixel 10 Pro') {
  const made = await local('POST', '/api/pairing', { body: {} });
  const code = made.json.links[0].url.split('#')[1];
  const paired = await remote('POST', '/api/pair', { body: { code, name } });
  return { made, code, paired, token: paired.json?.token };
}

test('the network listener answers only paired devices, apart from the pairing page', async (t) => {
  const { remote, tls } = await setup(t);
  assert.equal((await remote('GET', '/api/status')).status, 401);
  assert.equal((await remote('GET', '/api/timeline')).status, 401);
  const home = await remote('GET', '/');
  assert.equal(home.status, 303);
  assert.equal(home.headers.location, '/pair.html');
  assert.equal((await remote('GET', '/pair.html')).status, 200);
  const ca = await remote('GET', '/photobox-ca.crt');
  assert.equal(ca.status, 200);
  assert.match(ca.headers['content-type'], /application\/x-x509-ca-cert/);
  assert.deepEqual(ca.raw, Buffer.from(tls.caDer));
  assert.equal((await remote('POST', '/api/pair', { body: { code: 'guess' } })).status, 401);
  assert.equal((await remote('POST', '/api/pair', { body: { code: 42 } })).status, 401);

  // Malformed input from an unpaired device gets a short JSON error: no stack trace, no paths.
  const badCookie = await remote('GET', '/api/status', { cookie: 'photobox_device=%E0%A4%A' });
  assert.equal(badCookie.status, 401);
  const badJson = await remote('POST', '/api/pair', { body: '{bad' });
  assert.equal(badJson.status, 400);
  assert.ok(badJson.json?.error, 'a JSON error message');
  assert.doesNotMatch(badJson.raw.toString(), /node_modules|\/Users\/|at [\w.]+ \(/);
});

test('a pairing code works once and is traded for a token that is only stored hashed', async (t) => {
  const s = await setup(t);
  const { made, code, paired, token } = await pair(s);
  assert.equal(made.status, 200);
  assert.match(made.json.links[0].url, /^https:\/\/127\.0\.0\.1:\d+\/pair\.html#[\w-]{22}$/);
  assert.match(made.json.links[0].qr, /^<svg/);
  assert.equal(made.json.fingerprint, s.tls.fingerprint);
  const native = JSON.parse(made.json.links[0].native.payload);
  assert.equal(native.type, 'photobox-pair');
  assert.equal(native.version, 1);
  assert.equal(native.server, new URL(made.json.links[0].url).origin);
  assert.equal(native.code, code);
  assert.equal(native.expiresAt, made.json.expiresAt);
  assert.equal(native.trust.kind, 'ca');
  const anchor = Buffer.from(native.trust.certificate, 'base64');
  assert.equal(native.trust.sha256, crypto.createHash('sha256').update(anchor).digest('hex'));
  assert.deepEqual(anchor, Buffer.from(s.tls.caDer));
  assert.match(made.json.links[0].native.qr, /^<svg/);

  assert.equal(paired.status, 200);
  assert.equal(paired.json.device.name, 'Pixel 10 Pro');
  assert.equal(paired.json.ownCertificate, true);
  assert.match(paired.headers['set-cookie'][0], /^photobox_device=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal((await s.remote('POST', '/api/pair', { body: { code, name: 'Again' } })).status, 401, 'used up');

  const rows = s.library.db.prepare('SELECT * FROM devices').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashToken(token));
  assert.ok(!JSON.stringify(rows).includes(token), 'the token itself is not in the database');
});

test('a paired device can browse and favorite, but managing the library stays on the computer', async (t) => {
  const s = await setup(t);
  const { token, paired } = await pair(s);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  const id = s.library.insertMedia({ hash: 'h1', kind: 'image', filename: 'a.jpg', takenAt: 0, localTime: '1970-01-01 01:00:00', dateSource: 'file' });

  const status = await s.remote('GET', '/api/status', { token });
  assert.equal(status.status, 200);
  assert.equal(status.json.remote, true);
  assert.equal(status.json.device, 'Pixel 10 Pro');
  assert.equal(status.json.network, null, 'phones are not told how to pair others');
  assert.equal((await s.remote('GET', '/api/timeline', { cookie })).status, 200);
  assert.equal((await s.remote('GET', '/', { cookie })).status, 200);
  assert.equal((await s.remote('POST', `/api/media/${id}/favorite`, { token, body: { favorite: true } })).status, 200);
  assert.equal(s.library.media(id).favorite, 1);
  assert.equal((await s.remote('POST', `/api/media/${id}/favorite`, { token, body: 'favorite=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);

  for (const [method, url] of [
    ['POST', '/api/sources'], ['DELETE', '/api/sources/1'], ['POST', '/api/rescan'], ['POST', '/api/pick-folder'],
    ['POST', `/api/media/${id}/reveal`], ['POST', '/api/pairing'], ['GET', '/api/devices'], ['DELETE', '/api/devices/1'],
    ['GET', '/api/host'], ['POST', '/api/host/backup-directory'], ['POST', '/api/host/retry'], ['POST', '/api/host/shutdown'],
  ]) {
    // A folder that doesn't exist, so a broken check fails here instead of indexing the disk.
    const res = await s.remote(method, url, { token, body: method === 'GET' ? undefined : { path: '/nonexistent/photobox-test' } });
    assert.equal(res.status, 403, `${method} ${url}`);
  }
});

test('disconnecting a device on the computer locks it out', async (t) => {
  const s = await setup(t);
  const { token, paired } = await pair(s);
  await s.remote('GET', '/api/status', { token });
  const devices = (await s.local('GET', '/api/devices')).json;
  assert.equal(devices.length, 1);
  assert.ok(devices[0].last_seen_at > 0);
  assert.equal((await s.local('DELETE', `/api/devices/${paired.json.device.id}`, { body: {} })).status, 200);
  assert.equal((await s.remote('GET', '/api/status', { token })).status, 401);
});

test('pairing codes expire', async (t) => {
  const s = await setup(t, { ttl: 50 });
  const made = await s.local('POST', '/api/pairing', { body: {} });
  await new Promise((r) => setTimeout(r, 80));
  const res = await s.remote('POST', '/api/pair', { body: { code: made.json.links[0].url.split('#')[1], name: 'Late' } });
  assert.equal(res.status, 401);
  assert.match(res.json.error, /expired/);
});

test('the local listener still answers only to localhost and tells the app how to pair', async (t) => {
  const s = await setup(t);
  assert.equal((await s.local('GET', '/api/status', { headers: { Host: 'evil.example' } })).status, 403);
  const status = await s.local('GET', '/api/status');
  assert.equal(status.json.remote, false);
  assert.match(status.json.network.urls[0], /^https:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await s.local('POST', '/api/pair', { body: { code: 'x' } })).status, 404, 'pairing is only on the network listener');
});

test('certificates: renewed for new addresses, signed by the same CA, keys private', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-tls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = ensureCertificates(dir, ['localhost', '127.0.0.1', 'box.local']);
  const cert = new crypto.X509Certificate(first.cert);
  const custom = JSON.parse(nativePairingPayload({ tls: { cert: first.cert } }, 'https://localhost:4568', 'x'.repeat(22), Date.now() + 60_000));
  assert.equal(custom.trust.kind, 'certificate');
  assert.deepEqual(Buffer.from(custom.trust.certificate, 'base64'), cert.raw);
  assert.equal(custom.trust.sha256, crypto.createHash('sha256').update(cert.raw).digest('hex'));
  assert.equal(cert.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1, DNS:box.local');
  assert.ok(cert.checkIssued(new crypto.X509Certificate(first.ca)));
  assert.ok(Date.parse(cert.validTo) - Date.now() <= 398 * 86_400_000);

  assert.equal(ensureCertificates(dir, ['localhost', '127.0.0.1', 'box.local']).cert, first.cert, 'reused while it covers the names');
  const moved = ensureCertificates(dir, ['localhost', '127.0.0.1', '10.0.0.7']);
  assert.notEqual(moved.cert, first.cert);
  assert.equal(moved.ca, first.ca, 'a phone that trusts the CA keeps trusting Photobox');
  assert.equal(moved.fingerprint, first.fingerprint);
  for (const key of ['ca-key.pem', 'server-key.pem']) assert.equal((await fs.stat(path.join(dir, key))).mode & 0o777, 0o600, key);
});
