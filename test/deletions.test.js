// Deleting a photo from all devices: every copy on this computer goes to the Trash, its fingerprint stays on
// the Deleted list until that's cleared, a copy that turns up again is deleted too, and phones learn of it.
// Nothing here touches your real Trash: a stand-in moves files into the test's own folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { Deletions } from '../src/deletions.js';
import { exportLibrary } from '../src/export.js';
import { initArchive } from '../src/archive.js';
import { readHistory } from '../src/history.js';
import { MANIFEST, readManifest } from '../src/manifest.js';
import { thumbPath } from '../src/thumbs.js';
import { startPhotobox } from '../src/app.js';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const jpeg = (r, g, b) => sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const meta = (values) => Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',');
const exists = (file) => fs.stat(file).then(() => true, () => false);

async function tmpDir(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-delete-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

/** Stands in for the Trash: moves files into <tmp>/Trash and remembers where each came from. */
function fakeTrash(tmp) {
  const trashed = [];
  const trash = async (file) => {
    const dir = path.join(tmp, 'Trash');
    await fs.mkdir(dir, { recursive: true });
    const to = path.join(dir, `${trashed.length}-${path.basename(file)}`);
    await fs.rename(file, to);
    trashed.push({ from: file, to });
  };
  return Object.assign(trash, { trashed, async putBack(file) {
    const item = trashed.find((t) => t.from === file);
    await fs.rename(item.to, item.from);
    trashed.splice(trashed.indexOf(item), 1);
  } });
}

async function setup(t, { archive = false } = {}) {
  const tmp = await tmpDir(t);
  const put = async (rel, data) => {
    await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
    await fs.writeFile(path.join(tmp, rel), data);
    return path.join(tmp, rel);
  };
  const config = loadConfig({
    dataDir: path.join(tmp, 'data'), backupDir: archive ? undefined : path.join(tmp, 'Photos'),
    archive: archive ? initArchive(await fs.mkdir(path.join(tmp, 'Pictures'), { recursive: true }).then(() => path.join(tmp, 'Pictures')), { dataDir: path.join(tmp, 'data') }) : null,
  });
  const library = new Library(config.dbPath);
  if (config.archive) library.archiveSource(config.archive.root);
  const indexer = new Indexer(library, config);
  const trash = fakeTrash(tmp);
  const deletions = new Deletions(library, indexer, config, { trash });
  t.after(async () => {
    await deletions.close();
    await indexer.queue;
    library.close();
  });
  const shown = () => library.timeline({}).items.map((i) => i.id);
  return { tmp, put, config, library, indexer, trash, deletions, shown };
}

test('deleting a photo moves every copy on this computer to the Trash and keeps its fingerprint on the Deleted list', async (t) => {
  const { tmp, put, config, library, indexer, trash, deletions, shown } = await setup(t);
  const bytes = await jpeg(200, 40, 40);
  const other = await jpeg(40, 200, 40);
  const year = await put('Takeout/Google Photos/Photos from 2024/IMG_1.jpg', bytes);
  const album = await put('Takeout/Google Photos/Trip/IMG_1.jpg', bytes);
  const kept = await put('Takeout/Google Photos/Trip/IMG_2.jpg', other);
  await put('Takeout/Google Photos/Trip/metadata.json', JSON.stringify({ title: 'Trip' }));
  const source = library.addSource(path.join(tmp, 'Takeout'));
  await indexer.scanSource(source);
  await fs.mkdir(config.backupDir);
  await exportLibrary(library, config.backupDir);
  const photo = library.mediaBySha256(sha(bytes));
  const exported = path.join(config.backupDir, (await readManifest(config.backupDir)).items && Object.keys((await readManifest(config.backupDir)).items).find((rel) => rel.endsWith('IMG_1.jpg')));
  assert.ok(await exists(thumbPath(config, photo.hash)));

  const result = await deletions.delete(photo.id);
  assert.deepEqual(result, { files: 3, waiting: 0 });
  assert.deepEqual(trash.trashed.map((t) => t.from).sort(), [album, year, exported].sort());
  assert.ok(await exists(kept), 'the other photo stays');
  assert.deepEqual(shown(), [library.mediaBySha256(sha(other)).id]);
  assert.equal(library.mediaBySha256(sha(bytes)), undefined);
  assert.equal(await exists(thumbPath(config, photo.hash)), false, 'its thumbnail is gone too');
  assert.deepEqual(Object.keys((await readManifest(config.backupDir)).items).map((rel) => path.basename(rel)), ['IMG_2.jpg'], 'the export\'s manifest lists it no more');
  assert.deepEqual(library.albums().map((a) => [a.name, a.count]), [['Trip', 1]]);

  const [entry] = deletions.list();
  assert.equal(entry.photo, sha(bytes));
  assert.equal(entry.filename, 'IMG_1.jpg');
  assert.deepEqual(entry.contents.map((c) => c.sha256), [sha(bytes)]);
  assert.deepEqual(entry.contents[0].files.map((f) => [f.path, f.state]).sort(), [[album, 'deleted'], [exported, 'deleted'], [year, 'deleted']].sort());
  assert.deepEqual(deletions.counts(), { photos: 1, waiting: 0 });

  // Rescanning brings nothing back; another export doesn't copy it again.
  await indexer.scanSource(source);
  await exportLibrary(library, config.backupDir);
  assert.equal(shown().length, 1);
  assert.equal(await exists(exported), false);
  assert.equal(await deletions.delete(photo.id), null, 'it is gone');
});

test('a copy that turns up again is deleted too, until the photo is cleared from the Deleted list', async (t) => {
  const { tmp, put, library, indexer, trash, deletions, shown } = await setup(t);
  const bytes = await jpeg(10, 20, 200);
  const file = await put('Camera/IMG_1.jpg', bytes);
  const source = library.addSource(path.join(tmp, 'Camera'));
  await indexer.scanSource(source);
  await deletions.delete(shown()[0]);
  assert.deepEqual(trash.trashed.map((t) => t.from), [file]);

  // Put back from the Trash, and a copy in a new Takeout: both are deleted again.
  await trash.putBack(file);
  const again = await put('Takeout-2025/Google Photos/Photos from 2024/IMG_1(1).jpg', bytes);
  const takeout = library.addSource(path.join(tmp, 'Takeout-2025'));
  await indexer.scanSource(source);
  await indexer.scanSource(takeout);
  await deletions.sweep();
  assert.deepEqual(shown(), []);
  assert.deepEqual(trash.trashed.map((t) => t.from).sort(), [again, file].sort());
  assert.deepEqual(deletions.list()[0].contents[0].files.map((f) => f.state), ['deleted', 'deleted']);

  // A different file at a deleted copy's place stays, and is shown.
  const other = await jpeg(250, 250, 0);
  await trash.putBack(file);
  await fs.writeFile(file, other);
  library.deletedCopy(sha(bytes), file, source.path);
  await deletions.sweep();
  await indexer.queue;
  assert.ok(await exists(file));
  assert.deepEqual(shown(), [library.mediaBySha256(sha(other)).id]);

  // Cleared: forgotten, so a copy put back is a photo again.
  assert.equal(deletions.clear([sha(bytes)]), 1);
  assert.deepEqual(deletions.list(), []);
  await trash.putBack(again);
  await indexer.scanSource(takeout);
  assert.equal(shown().length, 2);
  assert.throws(() => deletions.clear(['not a fingerprint']), /fingerprints/);
});

test('several photos are deleted at once; one that can\'t be read yet stays, and one that is gone already is said so', async (t) => {
  const { tmp, put, library, indexer, trash, deletions, shown } = await setup(t);
  const one = await put('Folder/IMG_1.jpg', await jpeg(200, 0, 0));
  const two = await put('Folder/IMG_2.jpg', await jpeg(0, 200, 0));
  const kept = await put('Folder/IMG_3.jpg', await jpeg(0, 0, 200));
  const old = await put('Drive/IMG_4.jpg', await jpeg(200, 200, 0));
  await indexer.scanSource(library.addSource(path.join(tmp, 'Folder')));
  await indexer.scanSource(library.addSource(path.join(tmp, 'Drive')));
  const [a, b, k, o] = [one, two, kept, old].map((file) => library.q('SELECT media_id FROM files WHERE path = ?').get(file).media_id);
  // Indexed before Photobox kept fingerprints, on a drive that's unplugged now.
  library.q('UPDATE media SET sha256 = NULL WHERE id = ?').run(o);
  await fs.rename(path.join(tmp, 'Drive'), path.join(tmp, 'Unplugged'));

  const result = await deletions.deleteMany([a, b, o, a, 999_999]);
  assert.deepEqual({ ...result, failed: result.failed.map((f) => f.id) }, { deleted: [a, b], gone: [999_999], failed: [o], files: 2, waiting: 0 });
  assert.match(result.failed[0].error, /IMG_4\.jpg.*unplugged/);
  assert.deepEqual(trash.trashed.map((t) => t.from).sort(), [one, two].sort());
  assert.ok(shown().includes(k));
  assert.ok(library.media(o), 'the one it couldn\'t read is still there, to try again');
  assert.deepEqual(deletions.list().map((p) => p.filename).sort(), ['IMG_1.jpg', 'IMG_2.jpg']);
});

test('the web app deletes a selection in one request, given a list of photo ids', async (t) => {
  const tmp = await tmpDir(t);
  const folder = path.join(tmp, 'Folder');
  await fs.mkdir(folder);
  for (const n of [1, 2, 3]) await fs.writeFile(path.join(folder, `IMG_${n}.jpg`), await jpeg(n * 60, 20, 20));
  const trash = fakeTrash(tmp);
  let scanned;
  const done = new Promise((resolve) => (scanned = resolve));
  const app = await startPhotobox({ dataDir: path.join(tmp, 'data'), port: 0, folders: [folder], backupDir: path.join(tmp, 'Photos'), onScanned: () => scanned(), trash });
  t.after(() => app.close());
  await done;
  const local = (method, route, options) => request(app.url, null, method, route, options);
  const ids = (await local('GET', '/api/timeline')).json.items.map((i) => i.id);
  assert.equal(ids.length, 3);

  for (const body of [{}, { ids: [] }, { ids: [String(ids[0])] }, { ids: [-1] }]) {
    assert.equal((await local('POST', '/api/media/delete', { body })).status, 400, JSON.stringify(body));
  }
  const res = await local('POST', '/api/media/delete', { body: { ids: ids.slice(0, 2) } });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(res.json.deleted, ids.slice(0, 2));
  assert.equal(typeof res.json.version, 'number');
  assert.equal(trash.trashed.length, 2);
  assert.deepEqual((await local('GET', '/api/timeline')).json.items.map((i) => i.id), [ids[2]]);
});

test('a copy on an unplugged drive waits, and is deleted once the drive is back', async (t) => {
  const { tmp, put, library, indexer, trash, deletions, shown } = await setup(t);
  const bytes = await jpeg(90, 90, 90);
  const onDisk = await put('Inside/IMG_1.jpg', bytes);
  const onDrive = await put('Drive/DCIM/IMG_1.jpg', bytes);
  const inside = library.addSource(path.join(tmp, 'Inside'));
  const drive = library.addSource(path.join(tmp, 'Drive'));
  await indexer.scanSource(inside);
  await indexer.scanSource(drive);
  await fs.rename(path.join(tmp, 'Drive'), path.join(tmp, 'Unplugged'));

  assert.deepEqual(await deletions.delete(shown()[0]), { files: 2, waiting: 1 });
  assert.deepEqual(trash.trashed.map((t) => t.from), [onDisk]);
  const waiting = deletions.list()[0].contents[0].files.find((f) => f.path === onDrive);
  assert.equal(waiting.state, 'pending');
  assert.match(waiting.error, /not available/);
  assert.deepEqual(deletions.counts(), { photos: 1, waiting: 1 });

  await fs.rename(path.join(tmp, 'Unplugged'), path.join(tmp, 'Drive'));
  await indexer.scanSource(drive);
  await deletions.sweep();
  assert.deepEqual(trash.trashed.map((t) => t.from), [onDisk, onDrive]);
  assert.deepEqual(deletions.counts(), { photos: 1, waiting: 0 });
  assert.deepEqual(shown(), []);
});

test('a photo\'s other versions and its live photo\'s clip are deleted with it', async (t) => {
  const { tmp, put, library, indexer, trash, deletions, shown } = await setup(t);
  const small = await put('Second/IMG_1.jpg', await jpeg(1, 2, 3));
  const big = await put('Main/IMG_1.jpg', Buffer.concat([await jpeg(1, 2, 4), Buffer.alloc(1000)]));
  const clip = await put('Main/IMG_1.MOV', Buffer.from('not really a movie'));
  const main = library.addSource(path.join(tmp, 'Main'));
  const second = library.addSource(path.join(tmp, 'Second'));
  await indexer.scanSource(main);
  await indexer.scanSource(second);
  const smallId = library.fileByPath(small).media_id;
  const bigId = library.fileByPath(big).media_id;
  assert.equal(library.media(library.fileByPath(clip).media_id).live_of, bigId, 'the clip next to its still');
  // A version, as findVersions would find it.
  library.applyVersions(new Map([[smallId, bigId]]));
  assert.deepEqual(shown(), [bigId]);

  // Deleting the version deletes the photo it is a version of.
  await deletions.delete(smallId);
  assert.deepEqual(trash.trashed.map((t) => t.from).sort(), [big, clip, small].sort());
  assert.deepEqual(library.q('SELECT count(*) AS n FROM media').get().n, 0);
  const [entry] = deletions.list();
  assert.equal(entry.photo, library.q('SELECT photo FROM deletions LIMIT 1').get().photo);
  assert.equal(entry.contents.length, 3);
  assert.equal(entry.contents[0].sha256, entry.photo, 'the photo itself first');
});

test('deleting from an archive takes it out of the manifest and records it in the history', async (t) => {
  const { tmp, put, config, library, indexer, trash, deletions, shown } = await setup(t, { archive: true });
  const root = config.archive.root;
  const bytes = await jpeg(120, 60, 30);
  await put('Takeout/Google Photos/Photos from 2024/IMG_1.jpg', bytes);
  await put('Takeout/Google Photos/Photos from 2024/IMG_2.jpg', await jpeg(30, 60, 120));
  const takeout = library.addSource(path.join(tmp, 'Takeout'));
  await indexer.scanSource(takeout);
  await exportLibrary(library, root);
  const archive = library.sources().find((s) => s.managed === 'archive');
  await indexer.scanSource(archive);
  const id = library.mediaBySha256(sha(bytes)).id;
  const rel = Object.entries((await readManifest(root)).items).find(([, e]) => e.sha256 === sha(bytes))[0];

  await deletions.delete(id);
  assert.ok(trash.trashed.some((t) => t.from === path.join(root, ...rel.split('/'))));
  assert.equal((await readManifest(root)).items[rel], undefined);
  assert.equal(Object.keys((await readManifest(root)).items).length, 1);
  const events = (await readHistory(root)).filter((e) => e.event === 'file-deleted');
  assert.deepEqual(events.map((e) => [e.path, e.sha256]), [[rel, sha(bytes)]]);
  await indexer.scanSource(archive);
  assert.equal(shown().length, 1);
  assert.ok(await exists(path.join(root, MANIFEST)));
});

// --- phones, over the paired HTTPS listener ------------------------------------------

function request(base, ca, method, route, { token, body, headers = {} } = {}) {
  const url = new URL(route, base);
  const secure = url.protocol === 'https:';
  const bytes = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request({
      host: '127.0.0.1', port: url.port, path: `${url.pathname}${url.search}`, method, ca, servername: 'localhost', agent: false,
      headers: { Host: `localhost:${url.port}`, ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(bytes ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/offset+octet-stream' : 'application/json', 'Content-Length': bytes.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(raw); } catch { /* tus answers in plain text */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

test('phones: deleted photos are not uploaded again, the feed tells them, and the Deleted list shows what they did', async (t) => {
  const tmp = await tmpDir(t);
  const dest = path.join(tmp, 'Photos');
  await fs.mkdir(dest);
  const trash = fakeTrash(tmp);
  const app = await startPhotobox({ dataDir: path.join(tmp, 'data'), port: 0, listen: '127.0.0.1', remotePort: 0, backupDir: dest, trash });
  t.after(() => app.close());
  const ca = await fs.readFile(path.join(tmp, 'data', 'tls', 'ca.pem'));
  const local = (method, route, options) => request(app.url, null, method, route, options);
  const remote = (method, route, options) => request(app.network.urls[0], ca, method, route, options);
  const code = (await local('POST', '/api/pairing', { body: {} })).json.links[0].url.split('#')[1];
  const { token } = (await remote('POST', '/api/pair', { body: { code, name: 'Pixel' } })).json;
  const bytes = await jpeg(5, 150, 220);
  const upload = () => remote('POST', '/api/uploads', { token, body: bytes, headers: {
    'Tus-Resumable': '1.0.0', 'Upload-Length': bytes.length, 'Upload-Metadata': meta({ filename: 'PXL_1.jpg', sha256: sha(bytes) }) } });
  const check = async () => (await remote('POST', '/api/assets/check', { token, body: { sha256: [sha(bytes)] } })).json.assets[0];

  assert.equal((await upload()).status, 201);
  await app.backup.flush();
  assert.deepEqual(await check(), { sha256: sha(bytes), received: true, indexed: true, exported: true, deleted: false });
  const id = app.backup.library.mediaBySha256(sha(bytes)).id;
  const inbox = app.backup.library.q('SELECT path FROM files WHERE media_id = ?').get(id).path;

  // A paired phone's browser may delete; the computer's files go to the Trash.
  const deleted = await remote('DELETE', `/api/media/${id}`, { token, body: {} });
  assert.equal(deleted.status, 200, deleted.raw);
  const trashed = trash.trashed.map((t) => t.from);
  assert.equal(trashed.length, 2);
  assert.ok(trashed.includes(inbox), 'the phone backup\'s original');
  assert.ok(trashed.some((f) => f.startsWith(dest + path.sep) && f.endsWith('PXL_1.jpg')), 'and its export');
  assert.deepEqual(Object.keys((await readManifest(dest)).items), []);
  assert.deepEqual(await check(), { sha256: sha(bytes), received: false, indexed: false, exported: false, deleted: true });
  const again = await upload();
  assert.equal(again.status, 410, again.raw);
  await app.backup.flush();
  assert.equal(app.backup.status.failed, 0);

  const feed = await remote('GET', '/api/backup/deletions?after=0', { token });
  assert.deepEqual(feed.json, { deletions: [{ seq: 1, sha256: sha(bytes), deleted: true }], more: false });
  assert.equal((await remote('GET', '/api/backup/deletions?after=1', { token })).json.deletions.length, 0);
  assert.equal((await remote('GET', '/api/backup/deletions')).status, 401, 'only a paired phone\'s token');
  assert.equal((await local('GET', '/api/backup/deletions')).status, 403);

  const [entry] = (await local('GET', '/api/deletions')).json;
  assert.deepEqual(entry.contents[0].devices.map((d) => [d.name, d.state]), [['Pixel', 'waiting']]);
  assert.equal((await remote('POST', '/api/backup/deletions/report', { token, body: { items: [{ sha256: sha(bytes), state: 'gone' }] } })).status, 400);
  assert.equal((await remote('POST', '/api/backup/deletions/report', { token, body: { items: [{ sha256: sha(bytes), state: 'trashed' }] } })).status, 200);
  assert.deepEqual((await local('GET', '/api/deletions')).json[0].contents[0].devices.map((d) => [d.name, d.state]), [['Pixel', 'trashed']]);
  assert.deepEqual((await local('GET', '/api/status')).json.deleted, { photos: 1, waiting: 0 });

  // Clearing stays on the computer; afterwards the phone may back the photo up again.
  assert.equal((await remote('POST', '/api/deletions/clear', { token, body: { all: true } })).status, 403);
  assert.equal((await local('POST', '/api/deletions/clear', { body: { all: true } })).json.cleared, 1);
  assert.deepEqual((await remote('GET', '/api/backup/deletions?after=1', { token })).json.deletions, [{ seq: 2, sha256: sha(bytes), deleted: false }]);
  assert.deepEqual((await local('GET', '/api/deletions')).json, []);
  assert.equal((await upload()).status, 201);
});
