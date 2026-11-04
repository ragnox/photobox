import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { quickHash, digestFile } from '../src/files.js';
import { exportLibrary } from '../src/export.js';
import { thumbPath } from '../src/thumbs.js';
import { startPhotobox } from '../src/app.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jpeg = () => sharp({ create: { width: 16, height: 12, channels: 3, background: '#3070aa' } }).jpeg().toBuffer();
const meta = (values) => Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',');

async function temporary(t, prefix) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

function request(base, ca, method, route, { token, body, headers = {} } = {}) {
  const url = new URL(route, base);
  const secure = url.protocol === 'https:';
  const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      host: '127.0.0.1', port: url.port, path: `${url.pathname}${url.search}`, method,
      ca, servername: 'localhost', agent: false,
      headers: { Host: `localhost:${url.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bytes ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/offset+octet-stream' : 'application/json', 'Content-Length': bytes.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch { /* tus has plain text errors */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('Test request timed out')));
    req.end(bytes);
  });
}

async function host(t, { configured = true } = {}) {
  const tmp = await temporary(t, 'photobox-backup-');
  const dataDir = path.join(tmp, 'data');
  const dest = path.join(tmp, 'photos');
  await fs.mkdir(dest);
  let app;
  let ca;
  async function boot() {
    app = await startPhotobox({ dataDir, port: 0, listen: '127.0.0.1', remotePort: 0, backupDir: configured ? dest : undefined });
    ca = await fs.readFile(path.join(dataDir, 'tls', 'ca.pem'));
  }
  await boot();
  t.after(() => app.close());
  const local = (method, route, options) => request(app.url, null, method, route, options);
  const remote = (method, route, options) => request(app.network.urls[0], ca, method, route, options);
  const made = await local('POST', '/api/pairing', { body: {} });
  const paired = await remote('POST', '/api/pair', { body: { code: made.json.links[0].url.split('#')[1], name: 'Backup test' } });
  const token = paired.json.token;
  return {
    tmp, dataDir, dest, token, local, remote,
    get app() { return app; },
    get library() { return app.backup.library; },
    async restart() { await app.close(); await boot(); },
    async upload(bytes, filename = 'PXL_original.jpg', capturedAt = '2024-01-01T03:00:00+09:00') {
      const made = await remote('POST', '/api/uploads', { token, body: bytes, headers: {
        'Tus-Resumable': '1.0.0', 'Upload-Length': bytes.length,
        'Upload-Metadata': meta({ filename, sha256: sha(bytes), capturedAt }),
      } });
      assert.equal(made.status, 201, made.raw);
      return made.headers.location.split('/').pop();
    },
    async check(bytes) {
      const result = await remote('POST', '/api/assets/check', { token, body: { sha256: [sha(bytes)] } });
      assert.equal(result.status, 200, result.raw);
      return result.json.assets[0];
    },
    receipt(id) { return app.backup.library.q('SELECT * FROM backup_exports WHERE upload_id = ?').get(id); },
  };
}

test('sample collisions stay distinct through indexing, export, and renamed manifest re-import', async (t) => {
  const tmp = await temporary(t, 'photobox-collision-');
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  const first = Buffer.concat([await jpeg(), Buffer.alloc(200_000)]);
  const second = Buffer.from(first);
  second[100_000] = 1;
  const source = library.addSource(path.join(tmp, 'source'));
  for (const [dir, bytes] of [['a', first], ['b', second]]) {
    await fs.mkdir(path.join(source.path, dir), { recursive: true });
    await fs.writeFile(path.join(source.path, dir, 'photo.jpg'), bytes);
  }
  const a = path.join(source.path, 'a/photo.jpg');
  const b = path.join(source.path, 'b/photo.jpg');
  assert.equal(await quickHash(a, first.length), await quickHash(b, second.length));
  const indexer = new Indexer(library, config);
  await indexer.scanSource(source);
  assert.deepEqual(indexer.status.errors, []);
  const media = library.exportItems();
  assert.equal(media.length, 2);
  assert.equal(new Set(media.map((m) => m.sha256)).size, 2);
  assert.equal(new Set(media.map((m) => m.hash)).size, 2, 'independent thumbnail keys');
  library.setFavorite(library.mediaBySha256(sha(first)).id, true);
  const dest = path.join(tmp, 'photos');
  const result = await exportLibrary(library, dest);
  assert.equal(result.copied, 2);
  assert.deepEqual(result.skipped, []);
  const manifest = JSON.parse(await fs.readFile(path.join(dest, 'photobox-export.json'), 'utf8'));
  assert.equal(new Set(Object.values(manifest.items).map((m) => m.sha256)).size, 2);
  await fs.mkdir(path.join(dest, 'moved'));
  for (const [i, rel] of Object.keys(manifest.items).entries()) await fs.rename(path.join(dest, rel), path.join(dest, 'moved', `${i}.jpg`));
  const backConfig = loadConfig({ dataDir: path.join(tmp, 'back') });
  const back = new Library(backConfig.dbPath);
  t.after(() => back.close());
  await new Indexer(back, backConfig).scanSource(back.addSource(dest));
  assert.equal(back.stats().photos, 2);
  assert.equal(back.mediaBySha256(sha(first)).favorite, 1);
  assert.equal(back.mediaBySha256(sha(second)).favorite, 0);
});

test('legacy schema and sampled collisions upgrade without replacing old IDs or cache keys', async (t) => {
  const tmp = await temporary(t, 'photobox-legacy-sha-');
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  let library = new Library(config.dbPath);
  const source = library.addSource(path.join(tmp, 'source'));
  await fs.mkdir(source.path);
  const first = Buffer.concat([await jpeg(), Buffer.alloc(200_000)]);
  const second = Buffer.from(first);
  second[100_000] = 2;
  const a = path.join(source.path, 'a.jpg');
  const b = path.join(source.path, 'b.jpg');
  await fs.writeFile(a, first);
  await fs.writeFile(b, second);
  const quick = await quickHash(a, first.length);
  const id = library.insertMedia({ hash: quick, kind: 'image', filename: 'a.jpg', takenAt: 0, localTime: '1970-01-01 00:00:00', dateSource: 'file', favorite: true, bytes: first.length });
  for (const file of [a, b]) {
    const stat = await fs.stat(file);
    library.upsertFile({ path: file, sourceId: source.id, mediaId: id, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
  }
  const cached = thumbPath(config, quick);
  await fs.mkdir(path.dirname(cached), { recursive: true });
  await fs.writeFile(cached, 'old cache');
  library.db.exec(`DROP INDEX media_sha256; DROP INDEX media_quick_hash;
    ALTER TABLE media DROP COLUMN sha256; ALTER TABLE media DROP COLUMN quick_hash;
    ALTER TABLE files DROP COLUMN sha256; ALTER TABLE files DROP COLUMN mtime_ns; ALTER TABLE files DROP COLUMN ctime_ns;
    ALTER TABLE sources DROP COLUMN managed;`);
  library.close();
  library = new Library(config.dbPath);
  t.after(() => library.close());
  const indexer = new Indexer(library, config);
  await indexer.scanSource(library.source(source.id));
  assert.equal(library.stats().photos, 2);
  assert.equal(library.media(id).hash, quick);
  assert.equal(library.media(id).sha256, sha(first));
  assert.equal(await fs.readFile(cached, 'utf8'), 'old cache');
  assert.equal(library.mediaBySha256(sha(second)).favorite, 1, 'annotations on a previously merged item survive splitting');
  assert.equal(library.fileByPath(a).sha256, sha(first));
  assert.equal(library.fileByPath(b).sha256, sha(second));
  assert.equal((await exportLibrary(library, path.join(tmp, 'export'))).copied, 2);
  assert.equal((await indexer.scanSource(library.source(source.id))).added, 0);
});

test('ordinary parent-folder scans cannot admit unverified inbox files or cache images', async (t) => {
  const tmp = await temporary(t, 'photobox-managed-scan-');
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  const original = path.join(tmp, 'original.jpg');
  const unverified = path.join(config.inboxDir, 'unverified.jpg');
  await fs.writeFile(original, await jpeg());
  await fs.writeFile(unverified, await jpeg());
  await fs.writeFile(path.join(config.thumbsDir, 'cache.jpg'), await jpeg());
  await new Indexer(library, config).scanSource(library.addSource(tmp));
  assert.equal(library.stats().photos, 1);
  assert.ok(library.fileByPath(original));
  assert.equal(library.fileByPath(unverified), undefined);
  assert.equal(library.stats().files, 1);
});

test('phone originals are indexed with capture metadata and automatically exported with fresh proof', async (t) => {
  const s = await host(t);
  const bytes = await jpeg();
  const id = await s.upload(bytes);
  await s.app.backup.flush();
  assert.deepEqual(await s.check(bytes), { sha256: sha(bytes), received: true, indexed: true, exported: true, deleted: false });
  const receipt = s.receipt(id);
  assert.equal(receipt.relative_path, '2024/01/PXL_original.jpg', 'capture-local month, not inbox UTC month');
  assert.deepEqual(await fs.readFile(path.join(s.dest, receipt.relative_path)), bytes);
  const photo = s.library.mediaBySha256(sha(bytes));
  assert.equal(photo.local_time, '2024-01-01 03:00:00');
  assert.equal(photo.date_source, 'capture');
  assert.equal(photo.filename, 'PXL_original.jpg');
  const managed = s.library.sources().find((source) => source.managed === 'backup');
  assert.ok(managed);
  assert.equal((await s.local('DELETE', `/api/sources/${managed.id}`, { body: {} })).status, 409);
  assert.equal((await s.remote('POST', `/api/media/${photo.id}/favorite`, { token: s.token, body: { favorite: true } })).status, 200);
  await s.app.backup.flush();
  const manifest = JSON.parse(await fs.readFile(path.join(s.dest, 'photobox-export.json'), 'utf8'));
  assert.equal(manifest.items[receipt.relative_path].favorite, true);
  await s.restart();
  await s.app.backup.flush();
  assert.equal(s.receipt(id).relative_path, receipt.relative_path);
  assert.equal((await s.check(bytes)).exported, true);
  assert.equal(s.app.backup.status.failed, 0);
});

test('corrupt, moved, and deleted exports invalidate proof and are recovered without overwriting files', async (t) => {
  const s = await host(t);
  const bytes = Buffer.concat([await jpeg(), Buffer.alloc(200_000)]);
  const id = await s.upload(bytes);
  await s.app.backup.flush();
  const original = s.receipt(id).relative_path;
  const wrong = Buffer.from(bytes);
  wrong[100_000] = 42;
  await fs.writeFile(path.join(s.dest, original), wrong);
  assert.equal((await s.check(bytes)).exported, false);
  await s.app.backup.flush();
  const repaired = s.receipt(id).relative_path;
  assert.notEqual(repaired, original);
  assert.deepEqual(await fs.readFile(path.join(s.dest, original)), wrong, 'unrecognized bytes are preserved');
  assert.equal((await s.check(bytes)).exported, true);
  await fs.mkdir(path.join(s.dest, 'favorites'));
  await fs.rename(path.join(s.dest, repaired), path.join(s.dest, 'favorites/renamed.jpg'));
  assert.equal((await s.check(bytes)).exported, false);
  await s.app.backup.flush();
  assert.equal(s.receipt(id).relative_path, 'favorites/renamed.jpg');
  assert.equal((await s.check(bytes)).exported, true);
  await fs.rm(path.join(s.dest, 'favorites/renamed.jpg'));
  assert.equal((await s.check(bytes)).exported, false);
  await s.app.backup.flush();
  assert.equal((await s.check(bytes)).exported, true);
});

test('an absent or replaced destination is not initialized again or treated as verified', async (t) => {
  const s = await host(t);
  const bytes = await jpeg();
  await s.upload(bytes);
  await s.app.backup.flush();
  const away = `${s.dest}-offline`;
  await fs.rename(s.dest, away);
  assert.equal((await s.check(bytes)).exported, false);
  await s.app.backup.flush();
  await assert.rejects(fs.stat(s.dest), { code: 'ENOENT' });
  await fs.mkdir(s.dest); // An unplugged mount point can still be a readable directory.
  await s.app.backup.flush();
  assert.deepEqual(await fs.readdir(s.dest), []);
  assert.equal((await s.check(bytes)).exported, false);
  assert.ok(s.app.backup.status.failed > 0);
  await fs.rmdir(s.dest);
  await fs.rename(away, s.dest);
  await s.app.backup.flush();
  assert.equal((await s.check(bytes)).exported, true);
});

test('a publication that outlives its receipt commit is reused after restart', async (t) => {
  const s = await host(t);
  const bytes = await jpeg();
  const id = await s.upload(bytes);
  const original = s.library.q.bind(s.library);
  s.library.q = (sql) => sql.startsWith('INSERT INTO backup_exports')
    ? { run() { throw new Error('Simulated export receipt failure'); } } : original(sql);
  await s.app.backup.flush();
  assert.equal(s.receipt(id), undefined);
  assert.equal((await s.check(bytes)).exported, false);
  assert.ok(s.app.backup.status.failed > 0);
  s.library.q = original;
  await s.restart();
  await s.app.backup.flush();
  assert.equal((await s.check(bytes)).exported, true);
  assert.equal(s.receipt(id).relative_path, '2024/01/PXL_original.jpg');
  assert.deepEqual(await fs.readdir(path.join(s.dest, '2024/01')), ['PXL_original.jpg']);
});

test('inbox corruption cannot retain indexed/exported cleanup proof, and failures remain visible', async (t) => {
  const s = await host(t);
  const bytes = await jpeg();
  const id = await s.upload(bytes);
  await s.app.backup.flush();
  const row = s.app.backup.uploads.row(id);
  await fs.writeFile(s.app.backup.uploads.destination(row), Buffer.alloc(bytes.length));
  assert.deepEqual(await s.check(bytes), { sha256: sha(bytes), received: false, indexed: false, exported: false, deleted: false });
  await s.app.backup.flush();
  assert.ok(s.app.backup.status.failed > 0);
  assert.match(s.app.backup.status.error, /SHA-256/);
  assert.match(s.app.backup.uploads.row(id).last_error, /SHA-256/);
});

test('export paths cannot use symlinks to claim inbox originals as independent exported files', async (t) => {
  const s = await host(t);
  const bytes = await jpeg();
  const id = await s.upload(bytes);
  await s.app.backup.flush();
  const receipt = s.receipt(id);
  const target = path.join(s.dest, receipt.relative_path);
  await fs.rm(target);
  await fs.symlink(s.app.backup.uploads.destination(s.app.backup.uploads.row(id)), target);
  assert.equal((await s.check(bytes)).exported, false);
  await s.app.backup.flush();
  assert.notEqual(s.receipt(id).relative_path, receipt.relative_path);
  assert.equal((await s.check(bytes)).exported, true);
  assert.ok((await fs.lstat(target)).isSymbolicLink());
});

test('a symlinked destination directory cannot redirect automatic copies outside the backup root', async (t) => {
  const s = await host(t);
  const elsewhere = path.join(s.tmp, 'elsewhere');
  await fs.mkdir(elsewhere);
  await fs.mkdir(path.join(s.dest, '2024'));
  await fs.symlink(elsewhere, path.join(s.dest, '2024/01'));
  const bytes = await jpeg();
  const id = await s.upload(bytes);
  await s.app.backup.flush();
  assert.equal((await s.check(bytes)).exported, false);
  assert.equal(s.receipt(id), undefined);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  assert.ok(s.app.backup.status.failed > 0);
  await fs.unlink(path.join(s.dest, '2024/01'));
  await s.app.backup.flush();
  assert.equal((await s.check(bytes)).exported, true);
});

test('source changes after export planning cannot publish a false copy', async (t) => {
  const tmp = await temporary(t, 'photobox-export-change-');
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  const source = library.addSource(path.join(tmp, 'source'));
  await fs.mkdir(source.path);
  const file = path.join(source.path, 'original.jpg');
  const bytes = await jpeg();
  await fs.writeFile(file, bytes);
  await new Indexer(library, config).scanSource(source);
  let calls = 0;
  const dest = path.join(tmp, 'photos');
  const result = await exportLibrary(library, dest, {
    async validateDestination() { if (++calls === 2) await fs.writeFile(file, Buffer.alloc(bytes.length)); },
  });
  assert.equal(result.copied, 0);
  assert.equal(result.verified.length, 0);
  assert.match(result.skipped[0].reason, /SHA-256/);
  const manifest = JSON.parse(await fs.readFile(path.join(dest, 'photobox-export.json'), 'utf8'));
  assert.deepEqual(manifest.items, {});
});

test('a file appearing after export planning is never overwritten by publication', async (t) => {
  const tmp = await temporary(t, 'photobox-export-race-');
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  const source = library.addSource(path.join(tmp, 'source'));
  await fs.mkdir(source.path);
  const file = path.join(source.path, 'original.jpg');
  await fs.writeFile(file, await jpeg());
  await new Indexer(library, config).scanSource(source);
  const photo = library.exportItems()[0];
  const dest = path.join(tmp, 'photos');
  const target = path.join(dest, photo.local_time.slice(0, 4), photo.local_time.slice(5, 7), 'original.jpg');
  let calls = 0;
  const result = await exportLibrary(library, dest, {
    async validateDestination() {
      if (++calls === 2) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, 'someone else wrote this');
      }
    },
  });
  assert.equal(result.copied, 0);
  assert.equal(result.verified.length, 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'someone else wrote this');
});

test('reception without an export destination still produces a visible, full-hash-indexed photo', async (t) => {
  const s = await host(t, { configured: false });
  const bytes = await jpeg();
  await s.upload(bytes);
  await s.app.backup.flush();
  assert.deepEqual(await s.check(bytes), { sha256: sha(bytes), received: true, indexed: true, exported: false, deleted: false });
  const status = await s.local('GET', '/api/status');
  assert.equal(status.json.backup.configured, false);
  assert.equal(status.json.backup.indexed, 1);
  assert.equal(status.json.stats.photos, 1);
  assert.equal((await digestFile(s.library.primaryPath(s.library.mediaBySha256(sha(bytes)).id))).sha256, sha(bytes));
});
