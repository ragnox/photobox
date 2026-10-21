// End-to-end: build a fake Takeout, index it, check what the library made of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeFakeTakeout } from '../scripts/make-fake-takeout.js';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';

const hasTools = process.platform === 'darwin' && (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let tmp, library, indexer, source, firstScan;

before(async () => {
  if (!hasTools) return;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-test-'));
  await makeFakeTakeout(path.join(tmp, 'export'), { bulk: 0 });
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  library = new Library(config.dbPath);
  indexer = new Indexer(library, config);
  source = library.addSource(path.join(tmp, 'export'));
  firstScan = await indexer.scanSource(source);
});

after(async () => {
  library?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

const byName = (name) => library.db.prepare('SELECT * FROM media WHERE filename = ?').get(name.normalize('NFC'));
const iso = (ms) => new Date(ms).toISOString().replace('.000', '');

test('imports every unique item once and skips trashed ones', { skip: !hasTools && 'needs macOS + ffmpeg' }, () => {
  assert.deepEqual(indexer.status.errors, []);
  assert.equal(byName('DSC_9999.JPG'), undefined, 'trashed photo must be skipped');
  // DSC_0001/0002 and the Japan album are copies of photos in year folders.
  assert.equal(library.db.prepare('SELECT count(*) AS n FROM files WHERE media_id = ?').get(byName('DSC_0001.JPG').id).n, 2);
  assert.equal(firstScan.files, firstScan.added + 11 + 1);
});

test('dates come from the right sidecar for every naming quirk', { skip: !hasTools && 'needs macOS + ffmpeg' }, () => {
  const cases = {
    'DSC_0001.JPG': '2019-07-13T08:15:00Z',
    'DSC_0002.JPG': '2019-07-14T10:00:00Z',
    'DSC_0003.JPG': '2019-08-01T12:00:00Z',
    'DSC_0003(1).JPG': '2019-08-02T15:30:00Z',
    'DSC_0004.JPG': '2019-08-05T09:00:00Z',
    'DSC_0004(1).JPG': '2019-08-06T09:00:00Z',
    'DSC_0005-edited.JPG': '2019-08-10T18:45:00Z',
    'DSC_0006-bearbeitet.JPG': '2019-08-11T07:20:00Z',
    'Screenshot_20200314-153000_Some Very Long Application Name.png': '2019-09-01T11:11:00Z',
    'Café Central.jpg': '2019-09-03T14:00:00Z',
    'DSC_1001.JPG': '2018-12-24T18:00:00Z',
    'IMG_1234.HEIC': '2019-09-20T17:30:00Z',
    'VID_20190820_183000.mp4': '2019-08-20T16:30:00Z',
  };
  for (const [name, expected] of Object.entries(cases)) {
    const m = byName(name);
    assert.ok(m, `${name} missing`);
    assert.equal(iso(m.taken_at), expected, name);
    assert.equal(m.date_source, 'takeout', name);
  }
});

test('wall clock follows the place a photo was taken', { skip: !hasTools && 'needs macOS + ffmpeg' }, () => {
  assert.equal(byName('DSC_3000.JPG').local_time, '2023-04-01 09:30:00'); // Tokyo, UTC+9
  assert.equal(byName('IMG_1234.HEIC').local_time, '2019-09-20 18:30:00'); // Lisbon, summer time
  assert.equal(byName('IMG_20250310_102000.jpg').local_time, '2025-03-10 10:20:00'); // EXIF as-is
  assert.equal(byName('IMG_20250310_102000.jpg').date_source, 'exif');
});

test('sidecar details, albums and live photos', { skip: !hasTools && 'needs macOS + ffmpeg' }, () => {
  const details = library.mediaDetails(byName('DSC_0001.JPG').id);
  assert.equal(details.description, 'Stephansdom at golden hour');
  assert.equal(details.favorite, 1);
  assert.deepEqual(details.people, ['Anna']);
  assert.deepEqual(details.albums, ['Summer in Vienna ☀️']);
  assert.ok(Math.abs(details.lat - 48.2082) < 1e-6);

  const albums = Object.fromEntries(library.albums().map((a) => [a.name, a.count]));
  assert.deepEqual(albums, { 'Japan 2023': 9, 'Summer in Vienna ☀️': 6 });

  const still = byName('IMG_1234.HEIC');
  assert.equal(byName('IMG_1234.MP4').live_of, still.id);
  assert.ok(still.thumb_w > 0, 'HEIC thumbnail via sips');
  const timelineIds = library.timeline({ limit: 1000 }).items.map((i) => i.id);
  assert.ok(!timelineIds.includes(byName('IMG_1234.MP4').id), 'live clip hidden from timeline');
});

test('rescans are incremental and deletions are picked up', { skip: !hasTools && 'needs macOS + ffmpeg' }, async () => {
  const again = await indexer.scanSource(source);
  assert.equal(again.added, 0);

  // An unplugged drive must not wipe the library.
  const count = () => library.db.prepare('SELECT count(*) AS n FROM media').get().n;
  const before = count();
  await fs.rename(path.join(tmp, 'export'), path.join(tmp, 'unplugged'));
  assert.equal((await indexer.scanSource(source)).offline, true);
  assert.equal(count(), before);
  await fs.rename(path.join(tmp, 'unplugged'), path.join(tmp, 'export'));
  indexer.status.errors = [];

  const file = path.join(tmp, 'export', 'Camera Roll', 'IMG_20250310_102000.jpg');
  await fs.rm(file);
  await indexer.scanSource(source);
  assert.equal(byName('IMG_20250310_102000.jpg'), undefined);
});
