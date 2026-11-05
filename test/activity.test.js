// The activity log behind the app's status bar: what Photobox does itself, phones backing up, and
// what other programs on this computer report with `photobox activity`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Activity, backupNow, indexingNow } from '../src/activity.js';
import { startPhotobox } from '../src/app.js';

const CLI = fileURLToPath(new URL('../bin/photobox.js', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tmpDir(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-activity-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

test('what goes on is shown until it ends, then kept in a log that the same thing again only counts', () => {
  let now = 1000;
  const activity = new Activity(null, { now: () => now });
  activity.start('ssd', 'Copying to the backup drive', { done: 1, total: 4 });
  now = 2000;
  activity.start('ssd', 'Copying to the backup drive', { done: 3, total: 4 });
  assert.deepEqual(activity.snapshot().now, [{ id: 'ssd', text: 'Copying to the backup drive', done: 3, total: 4, since: 1000 }]);

  activity.end('ssd', 'Backup drive up to date');
  activity.end('nothing', null);
  now = 3000;
  activity.add('Phone backed up: nothing new');
  now = 4000;
  activity.add('Phone backed up: nothing new');
  activity.add('Export failed: disk full', { failed: true });
  const { now: going, recent } = activity.snapshot([{ id: 'index', text: 'Importing from Camera' }]);
  assert.deepEqual(going.map((i) => i.text), ['Importing from Camera'], "what the caller does itself comes first; ssd ended");
  assert.deepEqual(recent, [
    { at: 4000, text: 'Export failed: disk full', failed: true },
    { at: 4000, text: 'Phone backed up: nothing new', times: 2, since: 3000 },
    { at: 2000, text: 'Backup drive up to date' },
  ]);
});

test('a phone backing up is one entry: what it sent, once it has stopped asking', async () => {
  const activity = new Activity(null, { phoneIdleMs: 50 });
  const phone = { id: 7, name: 'Test phone' };
  activity.phone(phone);
  assert.deepEqual(activity.snapshot().now.map((i) => i.text), ['Test phone is backing up']);
  activity.phone(phone, true);
  activity.phone(phone, true);
  assert.deepEqual(activity.snapshot().now.map((i) => i.text), ['Receiving photos from Test phone · 2 so far']);
  await wait(120);
  assert.deepEqual(activity.snapshot().now, []);
  assert.equal(activity.snapshot().recent[0].text, 'Received 2 photos from Test phone');

  activity.phone(phone);
  await wait(120);
  assert.equal(activity.snapshot().recent[0].text, 'Test phone backed up: nothing new');
});

test('another program that stops saying how it is going ends as failed; the log survives a restart', async (t) => {
  const file = path.join(await tmpDir(t), 'activity.json');
  let now = 0;
  const activity = new Activity(file, { now: () => now });
  activity.start('ext:ssd', 'Copying to the backup drive', { staleMs: 1000 });
  now = 1001;
  assert.deepEqual(activity.snapshot().now, []);
  assert.deepEqual(activity.snapshot().recent, [{ at: 1001, text: 'Copying to the backup drive: stopped without saying it finished', failed: true }]);
  activity.close();
  assert.deepEqual(new Activity(file).snapshot().recent, activity.snapshot().recent);
  await fs.writeFile(file, 'not json');
  assert.deepEqual(new Activity(file).snapshot().recent, [], 'a damaged log starts over');
});

test('imports, phones sending photos and exports of phone photos read as sentences', () => {
  assert.deepEqual(indexingNow({ running: false }, () => ''), []);
  assert.deepEqual(indexingNow({ running: true, phase: 'indexing', source: '/x/Camera', done: 1200, total: 15000 }, () => 'Phone'),
    [{ id: 'index', text: 'Importing from Phone · 1,200 of 15,000', done: 1200, total: 15000 }]);
  assert.equal(indexingNow({ running: true, phase: 'scanning', source: '/x/Camera', done: 0, total: 0 }, () => 'Phone')[0].text, 'Looking for new photos in Phone');
  const uploads = { transfers: [
    { id: 'a', filename: 'PXL_1.jpg', deviceId: 3, phase: 'uploading', bytesDone: 5, totalBytes: 10, active: true },
    { id: 'b', filename: 'PXL_0.jpg', deviceId: 3, phase: 'uploading', active: false },
  ] };
  assert.deepEqual(backupNow(uploads, { running: true, done: 1, total: 3 }, () => 'Test phone', path.join(os.homedir(), 'Pictures')), [
    { id: 'upload:a', text: 'Receiving PXL_1.jpg from Test phone', done: 5, total: 10 },
    { id: 'backup', text: 'Exporting phone photos into ~/Pictures · 1 of 3', done: 1, total: 3 },
  ]);
});

test('the app is told what goes on and what happened; other programs report through photobox activity', async (t) => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-activity-')));
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const folder = path.join(tmp, 'Camera');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'IMG_1.jpg'), await sharp({ create: { width: 16, height: 12, channels: 3, background: '#468' } }).jpeg().toBuffer());
  const dataDir = path.join(tmp, 'data');
  let scanned;
  const done = new Promise((resolve) => { scanned = resolve; });
  app = await startPhotobox({ dataDir, port: 0, folders: [folder], onScanned: () => scanned() });
  await done;
  const status = async () => (await (await fetch(`${app.url}/api/status`)).json()).activity;
  const post = (body) => fetch(`${app.url}/api/activity`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const cli = (...args) => promisify(execFile)(process.execPath, [CLI, ...args, '--data', dataDir], { cwd: tmp });

  await wait(50);
  assert.equal((await status()).recent[0].text, 'Imported 1 new photo from Camera');

  for (const bad of [{}, { id: 'x', state: 'maybe', text: 'Hi' }, { id: 'a b', state: 'running', text: 'Hi' }, { id: 'x', state: 'running', text: ' ' },
    { id: 'x', state: 'running', text: 'Hi', done: -1 }, { id: 'x', state: 'running', text: 'x'.repeat(301) }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }

  await cli('activity', 'running', 'Copying', 'to', 'the', 'backup', 'drive', '--id', 'ssd');
  assert.deepEqual((await status()).now.map((i) => [i.id, i.text]), [['ext:ssd', 'Copying to the backup drive']]);
  await cli('activity', 'done', 'Backup drive up to date: 2 files', '--id', 'ssd');
  let activity = await status();
  assert.deepEqual(activity.now, []);
  assert.equal(activity.recent[0].text, 'Backup drive up to date: 2 files');

  // An export while Photobox runs shows in its status bar, and how it went in the log.
  const dest = path.join(tmp, 'Export');
  await fs.mkdir(dest);
  await cli('export', dest);
  activity = await status();
  assert.equal(activity.recent[0].text, `Exported 1 photo into ${dest}`);
  await cli('export', dest);
  assert.equal((await status()).recent[0].text, `Checked ${dest}: nothing new to export`);

  await app.close();
  const { stdout, stderr } = await cli('activity', 'done', 'Nobody listens');
  assert.equal(stdout + stderr, '', 'without a running Photobox there is no one to tell, and that is fine');
});
