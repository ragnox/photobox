// Exercise the native backup protocol over real, certificate-verified HTTPS.
// Synthetic originals deliberately need no decoder: reception is byte preservation.
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
import { networkAccess } from '../src/remote.js';
import { Uploads } from '../src/uploads.js';
import { startPhotobox } from '../src/app.js';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const metadata = (values) => Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',');
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));

function client(server, tls) {
  return (method, url, { token, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = (tls ? https : http).request({
      host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: tls?.ca,
      path: url, method, agent: false,
      headers: {
        Host: `localhost:${server.address().port}`, 'Tus-Resumable': '1.0.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bytes ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/offset+octet-stream' : 'application/json', 'Content-Length': bytes.length } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch { /* tus errors are plain text */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Test request timed out')));
    req.on('error', reject);
    req.end(bytes);
  });
}

async function setup(t, overrides = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-uploads-'));
  const config = loadConfig({ dataDir: path.join(tmp, 'data'), uploadMinFreeBytes: 0, ...overrides });
  let s;
  async function boot() {
    const library = new Library(config.dbPath);
    const indexer = new Indexer(library, config);
    const network = networkAccess(config, library, { address: '127.0.0.1' });
    const uploads = new Uploads(library, config);
    const deps = { library, indexer, config, network, uploads, watcher: {} };
    const localServer = await listen(http.createServer(createApp(deps)));
    const remoteServer = await listen(https.createServer(network.tls, createApp(deps, { remote: true })));
    network.port = remoteServer.address().port;
    s = {
      library, uploads, config, localServer, remoteServer, tls: network.tls,
      local: client(localServer), remote: client(remoteServer, network.tls),
    };
    return s;
  }
  async function restart() {
    await stop();
    const next = await boot();
    next.restart = restart;
    return next;
  }
  async function stop() {
    for (const server of [s.localServer, s.remoteServer]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await s.uploads.close();
    s.library.close();
  }
  t.after(async () => {
    await stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  await boot();
  s.restart = restart;
  return s;
}

async function pair(s, name = 'Synthetic phone') {
  const made = await s.local('POST', '/api/pairing', { body: {} });
  const code = made.json.links[0].url.split('#')[1];
  const paired = await s.remote('POST', '/api/pair', { body: { code, name } });
  assert.equal(paired.status, 200);
  return { token: paired.json.token, device: paired.json.device, cookie: paired.headers['set-cookie'][0].split(';')[0] };
}

const begin = (s, token, bytes, extra = {}, headers = {}) => s.remote('POST', '/api/uploads', {
  token, headers: { 'Upload-Length': bytes.length, 'Upload-Metadata': metadata({ filename: 'PXL_original.jpg', sha256: hash(bytes), ...extra }), ...headers },
});
const patch = (s, token, url, offset, body) => s.remote('PATCH', url, { token, body, headers: { 'Upload-Offset': offset } });
const check = (s, token, hashes) => s.remote('POST', '/api/assets/check', { token, body: { sha256: hashes } });

test('tus creation-with-upload verifies the POST body before returning a receipt', async (t) => {
  const s = await setup(t);
  const { token } = await pair(s);
  const bytes = crypto.randomBytes(80_000);
  const made = await s.remote('POST', '/api/uploads', {
    token, body: bytes,
    headers: { 'Upload-Length': bytes.length, 'Upload-Metadata': metadata({ filename: 'original.mp4', sha256: hash(bytes) }) },
  });
  assert.equal(made.status, 201, made.raw);
  assert.equal(made.headers['upload-offset'], String(bytes.length));
  assert.match(made.headers.location, /^\/api\/uploads\/[a-f0-9]{32}$/);
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, true);
});

test('resume across a host restart, preserve every byte and issue reception-only receipts', async (t) => {
  let s = await setup(t);
  const { token } = await pair(s);
  const bytes = crypto.randomBytes(300_000);
  const created = await begin(s, token, bytes, { filename: 'Café.MP.jpg', capturedAt: '2025-03-01T01:30:00+09:00', mediaStoreId: 'images/42' });
  assert.equal(created.status, 201, created.raw);
  const url = created.headers.location;
  assert.match(url, /^\/api\/uploads\/[a-f0-9]{32}$/);
  assert.equal((await patch(s, token, url, 0, bytes.subarray(0, 100_000))).status, 204);
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, false);
  s = await s.restart();
  const head = await s.remote('HEAD', url, { token });
  assert.equal(head.status, 200);
  assert.equal(head.headers['upload-offset'], '100000');
  assert.equal((await patch(s, token, url, 100_000, bytes.subarray(100_000))).status, 204);
  const receipt = await check(s, token, [hash(bytes)]);
  assert.deepEqual(receipt.json.assets, [{ sha256: hash(bytes), received: true, indexed: false, exported: false }]);
  const row = s.uploads.row(url.split('/').pop());
  const target = s.uploads.destination(row);
  assert.ok(target.endsWith(`/2025/02/${row.id}/Café.MP.jpg`));
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(s.library.q('SELECT count(*) AS n FROM media').get().n, 0);
  assert.equal((await s.remote('HEAD', url, { token })).headers['upload-offset'], String(bytes.length));
  assert.equal((await s.remote('DELETE', url, { token })).status, 409);
  assert.equal((await patch(s, token, url, bytes.length, Buffer.alloc(0))).status, 409);
  assert.deepEqual(await fs.readFile(target), bytes);
});

test('uploads and receipts require bearer authentication and are isolated across devices and revocation', async (t) => {
  const s = await setup(t);
  const first = await pair(s);
  const second = await pair(s, 'Other phone');
  const bytes = Buffer.from('synthetic original');
  assert.equal((await s.remote('GET', '/api/backup/capabilities')).status, 401);
  assert.equal((await s.remote('GET', '/api/backup/capabilities', { headers: { Cookie: first.cookie } })).status, 401);
  const capabilities = await s.remote('GET', '/api/backup/capabilities', { token: first.token });
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.json.version, 1);
  assert.ok(capabilities.json.extensions.includes('.dng'));
  assert.ok(capabilities.json.maxFileBytes > 0);
  assert.equal((await begin(s, undefined, bytes)).status, 401);
  assert.equal((await begin(s, undefined, bytes, {}, { Cookie: first.cookie })).status, 401);
  assert.equal((await s.local('POST', '/api/uploads')).status, 403);
  const created = await begin(s, first.token, bytes);
  const url = created.headers.location;
  for (const method of ['HEAD', 'PATCH', 'DELETE']) {
    assert.equal((await s.remote(method, url, { token: second.token })).status, 404);
  }
  assert.equal((await patch(s, first.token, url, 0, bytes)).status, 204);
  assert.equal((await check(s, second.token, [hash(bytes)])).json.assets[0].received, false);
  assert.equal((await s.remote('POST', '/api/assets/check', { headers: { Cookie: first.cookie }, body: { sha256: [hash(bytes)] } })).status, 401);
  assert.equal((await s.local('DELETE', `/api/devices/${first.device.id}`, { body: {} })).status, 200);
  assert.equal((await s.remote('HEAD', url, { token: first.token })).status, 401);
  assert.equal((await check(s, first.token, [hash(bytes)])).status, 401);
  // Device IDs can be reused after deletion: token-hash ownership must still isolate originals.
  await s.local('DELETE', `/api/devices/${second.device.id}`, { body: {} });
  const replacement = await pair(s, 'Replacement');
  assert.equal(replacement.device.id, first.device.id);
  assert.equal((await s.remote('HEAD', url, { token: replacement.token })).status, 404);
  assert.equal((await check(s, replacement.token, [hash(bytes)])).json.assets[0].received, false);
  assert.deepEqual(await fs.readFile(s.uploads.destination(s.uploads.row(url.split('/').pop()))), bytes);
});

test('invalid metadata, unsafe paths, deferred lengths, wrong offsets and oversized bodies are rejected', async (t) => {
  const s = await setup(t, { uploadMaxBytes: 1024 });
  const { token } = await pair(s);
  const bytes = Buffer.from('original');
  for (const extra of [
    { filename: '../escape.jpg' }, { filename: '..\\escape.jpg' }, { filename: '.hidden.jpg' },
    { filename: 'not-media.exe' }, { filename: 'bad\u0000.jpg' }, { filename: `${'x'.repeat(240)}.jpg` },
    { filename: 'photo.jpg:stream.mp4' },
    { sha256: 'quick-fingerprint' }, { capturedAt: 'yesterday' }, { capturedAt: '2026-01-01T12:00:00' }, { capturedAt: '2026-02-30T12:00:00Z' },
    { mediaStoreId: 'x'.repeat(129) }, { owner: 'another device' },
  ]) {
    assert.equal((await begin(s, token, bytes, extra)).status, 400, JSON.stringify(extra));
  }
  assert.equal((await begin(s, token, Buffer.alloc(0))).status, 400);
  assert.equal((await begin(s, token, bytes, {}, { 'Upload-Length': '9007199254740992' })).status, 413);
  assert.equal((await s.remote('POST', '/api/uploads', { token, headers: { 'Upload-Defer-Length': '1' } })).status, 501);
  assert.equal((await begin(s, token, Buffer.alloc(1025))).status, 413);
  assert.equal((await check(s, token, ['not-a-hash'])).status, 400);
  assert.equal((await check(s, token, Array(101).fill(hash(bytes)))).status, 400);
  const created = await begin(s, token, bytes);
  const url = created.headers.location;
  assert.equal((await patch(s, token, url, 1, bytes)).status, 409);
  assert.equal((await patch(s, token, url, 0, Buffer.alloc(bytes.length + 1))).status, 413);
  assert.equal((await s.remote('HEAD', url, { token })).headers['upload-offset'], '0');
  assert.equal((await patch(s, token, url, 0, bytes)).status, 204);
  assert.equal((await s.remote('POST', '/api/sources', { token, body: bytes })).status, 415, 'binary exception is confined to uploads');
});

test('SHA-256 mismatch never publishes a receipt; cancellation releases the reserved quota', async (t) => {
  const bytes = Buffer.from('original');
  const s = await setup(t, { uploadDeviceQuotaBytes: bytes.length });
  const { token } = await pair(s);
  const created = await begin(s, token, bytes);
  const url = created.headers.location;
  const wrong = Buffer.from('corrupt!');
  assert.equal(wrong.length, bytes.length);
  const failed = await patch(s, token, url, 0, wrong);
  assert.equal(failed.status, 422, failed.raw);
  assert.equal((await check(s, token, [hash(bytes), hash(wrong)])).json.assets.some((a) => a.received), false);
  const row = s.uploads.row(url.split('/').pop());
  await assert.rejects(fs.stat(s.uploads.destination(row)), { code: 'ENOENT' });
  assert.equal((await begin(s, token, bytes)).status, 413);
  assert.equal((await s.remote('DELETE', url, { token })).status, 204);
  assert.equal((await s.remote('HEAD', url, { token })).status, 404);
  assert.equal((await begin(s, token, bytes)).status, 201);
});

test('concurrent reservations respect quota and concurrent writes cannot overwrite bytes', async (t) => {
  const s = await setup(t, { uploadDeviceQuotaBytes: 10 });
  const { token } = await pair(s);
  const bytes = Buffer.from('12345678');
  const reservations = await Promise.all([begin(s, token, bytes), begin(s, token, bytes)]);
  assert.deepEqual(reservations.map((r) => r.status).sort(), [201, 413]);
  const url = reservations.find((r) => r.status === 201).headers.location;
  const writes = await Promise.all([patch(s, token, url, 0, bytes.subarray(0, 4)), patch(s, token, url, 0, bytes.subarray(0, 4))]);
  assert.deepEqual(writes.map((r) => r.status).sort(), [204, 409]);
  assert.equal((await patch(s, token, url, 4, bytes.subarray(4))).status, 204);
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, true);
});

test('disk reserve is checked at creation and again before receiving a chunk', async (t) => {
  const s = await setup(t);
  const { token } = await pair(s);
  const bytes = Buffer.from('original');
  s.config.uploadMinFreeBytes = Number.MAX_SAFE_INTEGER;
  assert.equal((await begin(s, token, bytes)).status, 507);
  s.config.uploadMinFreeBytes = 0;
  const created = await begin(s, token, bytes);
  s.config.uploadMinFreeBytes = Number.MAX_SAFE_INTEGER;
  assert.equal((await patch(s, token, created.headers.location, 0, bytes)).status, 507);
  assert.equal((await s.remote('HEAD', created.headers.location, { token })).headers['upload-offset'], '0');
});

test('receipt checks detect changed middle bytes, truncation and missing originals', async (t) => {
  const s = await setup(t);
  const { token } = await pair(s);
  const first = Buffer.alloc(200_000, 1);
  const second = Buffer.from(first);
  second[100_000] = 2; // Identical length and first/last 64 KB, different full content.
  const targets = [];
  for (const bytes of [first, second]) {
    const created = await begin(s, token, bytes);
    assert.equal((await patch(s, token, created.headers.location, 0, bytes)).status, 204);
    targets.push(s.uploads.destination(s.uploads.row(created.headers.location.split('/').pop())));
  }
  assert.equal((await check(s, token, [hash(first), hash(second)])).json.assets.every((a) => a.received), true);
  await fs.writeFile(targets[0], second);
  assert.deepEqual((await check(s, token, [hash(first), hash(second)])).json.assets.map((a) => a.received), [false, true]);
  await fs.truncate(targets[1], 10);
  assert.equal((await check(s, token, [hash(second)])).json.assets[0].received, false);
  await fs.rm(targets[1]);
  assert.equal((await check(s, token, [hash(second)])).json.assets[0].received, false);
});

test('restart recovers complete staged bytes and publication interrupted before receipt commit', async (t) => {
  let s = await setup(t);
  const { token } = await pair(s);
  const bytes = Buffer.from('full bytes written before process exit');
  const staged = await begin(s, token, bytes);
  const stagedId = staged.headers.location.split('/').pop();
  await fs.writeFile(path.join(s.config.uploadsDir, stagedId), bytes);
  s = await s.restart();
  assert.equal((await s.remote('HEAD', staged.headers.location, { token })).headers['upload-offset'], String(bytes.length));
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, true);

  const other = Buffer.from('rename committed but receipt not committed');
  const created = await begin(s, token, other);
  const id = created.headers.location.split('/').pop();
  const originalQ = s.library.q.bind(s.library);
  s.library.q = (sql) => sql.startsWith("UPDATE backup_uploads SET state = 'received'")
    ? { run() { throw new Error('Simulated receipt commit failure'); } } : originalQ(sql);
  const failed = await patch(s, token, created.headers.location, 0, other);
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.raw, /Simulated|\/Users\/|node_modules/);
  s.library.q = originalQ;
  assert.equal(s.uploads.row(id).state, 'uploading');
  await assert.rejects(fs.stat(path.join(s.config.uploadsDir, id)), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(s.uploads.destination(s.uploads.row(id))), other);
  s = await s.restart();
  assert.equal((await s.remote('HEAD', created.headers.location, { token })).status, 200);
  assert.equal((await check(s, token, [hash(other)])).json.assets[0].received, true);
});

test('an interrupted PATCH settles during shutdown and resumes the stored bytes after restart', async (t) => {
  let s = await setup(t);
  const { token } = await pair(s);
  const bytes = crypto.randomBytes(128_000);
  const created = await begin(s, token, bytes);
  const url = created.headers.location;
  const id = url.split('/').pop();
  const req = https.request({
    host: '127.0.0.1', port: s.remoteServer.address().port, path: url, method: 'PATCH',
    servername: 'localhost', ca: s.tls.ca, agent: false,
    headers: { Authorization: `Bearer ${token}`, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream', 'Content-Length': bytes.length },
  });
  req.on('error', () => {});
  req.write(bytes.subarray(0, 32_000));
  // Wait for actual persistence before breaking the connection; no timing assumption.
  let size = 0;
  for (let tries = 0; tries < 100 && size === 0; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    size = (await fs.stat(path.join(s.config.uploadsDir, id))).size;
  }
  assert.ok(size > 0 && size < bytes.length);
  const progress = (await s.local('GET', '/api/status')).json.uploads;
  assert.equal(progress.pending, 1);
  assert.ok(progress.transfers.some((item) => item.active && item.bytesDone > 0 && item.totalBytes === bytes.length));
  req.destroy();
  s = await s.restart();
  const head = await s.remote('HEAD', url, { token });
  const offset = Number(head.headers['upload-offset']);
  assert.ok(offset > 0 && offset < bytes.length);
  assert.equal((await patch(s, token, url, offset, bytes.subarray(offset))).status, 204);
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, true);
  assert.equal((await s.local('GET', '/api/status')).json.uploads.pending, 0);
});

test('startPhotobox wires uploads into the production HTTPS listener', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-upload-app-'));
  const app = await startPhotobox({ dataDir: tmp, port: 0, listen: '127.0.0.1', remotePort: 0 });
  t.after(async () => { await app.close(); await fs.rm(tmp, { recursive: true, force: true }); });
  const localPort = Number(new URL(app.url).port);
  const remotePort = Number(new URL(app.network.urls[0]).port);
  const ca = await fs.readFile(path.join(tmp, 'tls', 'ca.pem'));
  const s = { local: client({ address: () => ({ port: localPort }) }), remote: client({ address: () => ({ port: remotePort }) }, { ca }) };
  const { token } = await pair(s);
  const bytes = Buffer.from('production wiring');
  const made = await begin(s, token, bytes);
  assert.equal(made.status, 201, made.raw);
  assert.equal((await patch(s, token, made.headers.location, 0, bytes)).status, 204);
  assert.equal((await check(s, token, [hash(bytes)])).json.assets[0].received, true);
});
