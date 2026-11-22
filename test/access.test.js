// A folder macOS is still asking you about (Downloads, Desktop, Documents, a drive) must not freeze
// Photobox: its folders are read off the main thread first, and watched and scanned once that's back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { FolderAccess, openFolder } from '../src/access.js';
import { startPhotobox } from '../src/app.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jpeg = (background) => sharp({ create: { width: 16, height: 12, channels: 3, background } }).jpeg().toBuffer();
const mac = process.platform === 'darwin';

async function until(check, what, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(50);
  }
}

async function tmpDir(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-access-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

test('a folder whose read is still out is waiting, and readable once it comes back', async () => {
  let answer;
  const asking = new Promise((resolve) => { answer = resolve; });
  const opened = [];
  const access = new FolderAccess({ waitMs: 20, open: (dir) => { opened.push(dir); return dir === '/Downloads/trip' ? asking : Promise.resolve(); } });
  const events = [];
  for (const name of ['waiting', 'readable', 'refused']) access.on(name, (dir, more) => events.push([name, dir, more]));

  assert.equal(await access.readable('/Pictures'), true);
  assert.equal(await access.answer('/Downloads/trip'), null, 'still out after waitMs');
  assert.deepEqual(access.waiting(), ['/Downloads/trip']);
  assert.ok(access.pending('/Downloads/trip/2023/IMG_1.jpg'));
  assert.ok(!access.pending('/Downloads/trip-2/IMG_1.jpg'));
  assert.ok(!access.pending('/Pictures/IMG_1.jpg'));

  const check = access.readable('/Downloads/trip');
  answer();
  assert.equal(await check, true);
  assert.ok(!access.pending('/Downloads/trip/2023/IMG_1.jpg'));
  assert.deepEqual(access.waiting(), []);
  assert.deepEqual(events, [['readable', '/Pictures', false], ['waiting', '/Downloads/trip', undefined], ['readable', '/Downloads/trip', true]]);
  assert.deepEqual(opened, ['/Pictures', '/Downloads/trip'], 'each folder is read once');
});

test('a folder Photobox may not read is refused and read again when asked again; a missing one is for the caller', async (t) => {
  let code = 'EPERM';
  let opens = 0;
  const access = new FolderAccess({ retryMs: 0, open: async () => { opens++; if (code) throw Object.assign(new Error(code), { code }); } });
  const refused = [];
  access.on('refused', (dir, err) => refused.push([dir, err.code]));
  assert.equal(await access.readable('/Downloads/trip'), false);
  code = null;
  assert.equal(await access.readable('/Downloads/trip'), true, 'allowed in the meantime');
  assert.equal(opens, 2);
  assert.deepEqual(refused, [['/Downloads/trip', 'EPERM']]);
  const gone = new FolderAccess({ open: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } });
  assert.equal(await gone.readable('/Volumes/SD'), true);

  // The real read, of a folder this user may and may not open.
  const tmp = await tmpDir(t);
  const locked = path.join(tmp, 'locked');
  await fs.mkdir(locked, { mode: 0o000 });
  assert.equal(await new FolderAccess().readable(tmp), true);
  if (process.getuid?.() !== 0) assert.equal(await new FolderAccess().readable(locked), false);
});

test("a folder macOS is still asking about doesn't hold up the host: other folders are scanned, its photos wait, and it's scanned and watched once allowed", async (t) => {
  const tmp = await tmpDir(t);
  const held = path.join(tmp, 'Downloads', 'trip');
  const camera = path.join(tmp, 'Camera');
  await fs.mkdir(held, { recursive: true });
  await fs.mkdir(camera);
  await fs.writeFile(path.join(held, 'IMG_HELD.jpg'), await jpeg('#a33'));
  await fs.writeFile(path.join(camera, 'IMG_CAM.jpg'), await jpeg('#36a'));
  const dataDir = path.join(tmp, 'data');

  // Indexed once while Photobox could read it...
  let app = await startPhotobox({ dataDir, port: 0, folders: [held] });
  await app.scanned;
  await app.indexer.queue;
  await app.close();

  // ...then a new build, which macOS asks you about again: the read of that folder waits for your answer.
  await fs.writeFile(path.join(held, 'IMG_NEW.jpg'), await jpeg('#3a3'));
  let allow;
  const answered = new Promise((resolve) => { allow = resolve; });
  const access = new FolderAccess({ waitMs: 50, open: (dir) => (dir === held ? answered.then(() => openFolder(dir)) : openFolder(dir)) });
  app = await startPhotobox({ dataDir, port: 0, folders: [camera], access });
  t.after(() => app.close());

  const get = async (url) => (await fetch(`${app.url}${url}`)).json();
  const shown = async () => Object.fromEntries(await Promise.all((await get('/api/timeline')).items
    .map(async (i) => [(await get(`/api/media/${i.id}`)).filename, i.id])));
  const waiting = async () => (await get('/api/status')).activity.now.filter((i) => i.id.startsWith('access:')).map((i) => i.text);

  // The waiting folder comes first, and Camera is scanned all the same.
  await until(async () => 'IMG_CAM.jpg' in await shown(), 'Camera to be scanned');
  let photos = await shown();
  assert.ok(!('IMG_NEW.jpg' in photos), 'not scanned while it waits');
  assert.deepEqual(await waiting(), [mac ? 'Waiting to read trip: if your Mac asks whether Photobox may, click Allow' : 'Waiting to read trip']);

  // Its photos aren't touched meanwhile: that read would wait too.
  assert.equal((await fetch(`${app.url}/api/media/${photos['IMG_HELD.jpg']}/full`)).status, 503);
  const files = await fetch(`${app.url}/api/media/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [photos['IMG_HELD.jpg'], photos['IMG_CAM.jpg']] }) });
  assert.deepEqual((await files.json()).files, [path.join(camera, 'IMG_CAM.jpg')]);

  allow();
  await app.scanned;
  await app.indexer.queue;
  photos = await shown();
  assert.ok('IMG_NEW.jpg' in photos, 'scanned once allowed');
  assert.equal((await fetch(`${app.url}/api/media/${photos['IMG_HELD.jpg']}/full`)).status, 200);
  assert.deepEqual(await waiting(), []);

  // And watched: a photo added now shows up by itself.
  await fs.writeFile(path.join(held, 'IMG_LATER.jpg'), await jpeg('#aa3'));
  await until(async () => 'IMG_LATER.jpg' in await shown(), 'the watcher to pick up a new photo');
});

test('a folder Photobox may not read is skipped, and the activity log says where to allow it', async (t) => {
  const tmp = await tmpDir(t);
  const refused = path.join(tmp, 'Downloads', 'holiday');
  const camera = path.join(tmp, 'Camera');
  await fs.mkdir(refused, { recursive: true });
  await fs.mkdir(camera);
  await fs.writeFile(path.join(refused, 'IMG_1.jpg'), await jpeg('#a33'));
  await fs.writeFile(path.join(camera, 'IMG_2.jpg'), await jpeg('#36a'));
  const no = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
  const access = new FolderAccess({ open: (dir) => (dir === refused ? Promise.reject(no) : openFolder(dir)) });
  const app = await startPhotobox({ dataDir: path.join(tmp, 'data'), port: 0, folders: [refused, camera], access });
  t.after(() => app.close());
  await app.scanned;
  await app.indexer.queue;

  const status = await (await fetch(`${app.url}/api/status`)).json();
  assert.equal((await (await fetch(`${app.url}/api/timeline`)).json()).items.length, 1, "Camera's photo only");
  const log = status.activity.recent.filter((e) => e.failed).map((e) => e.text);
  assert.deepEqual(log, [mac ? 'Photobox may not read holiday: allow it in System Settings › Privacy & Security › Files & Folders'
    : 'Photobox may not read holiday (EPERM)']);
});
