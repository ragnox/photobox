// Scanning a plain folder (no Takeout, no ffmpeg needed): what gets indexed, and what must not be lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';

const jpeg = (r, g, b) => sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-indexer-'));
  const config = loadConfig({ dataDir: path.join(tmp, 'data') });
  const library = new Library(config.dbPath);
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const dir = path.join(tmp, 'photos');
  const put = async (rel, buf) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), buf);
  };
  return { tmp, dir, put, library, indexer: new Indexer(library, config), source: library.addSource(dir) };
}

test('hidden files and clutter folders (Synology @eaDir, recycle bins) are not photos', async (t) => {
  const { put, library, indexer, source } = await setup(t);
  await put('IMG_1.jpg', await jpeg(200, 0, 0));
  await put('@eaDir/IMG_1.jpg/SYNOPHOTO_THUMB_XL.jpg', await jpeg(0, 200, 0));
  await put('#recycle/IMG_0.jpg', await jpeg(0, 0, 200));
  await put('.hidden.jpg', await jpeg(9, 9, 9));
  assert.deepEqual(await indexer.scanSource(source), { files: 1, added: 1 });
  assert.equal(library.stats().photos, 1);
});

test('an empty or cut-off photo is listed without a thumbnail, and leaves no file open', async (t) => {
  const { put, indexer, source } = await setup(t);
  await put('IMG_1.jpg', await jpeg(200, 0, 0));
  await put('IMG_0.jpg', Buffer.alloc(0));
  await put('IMG_2.jpg', (await jpeg(0, 200, 0)).subarray(0, 40));
  assert.deepEqual(await indexer.scanSource(source), { files: 3, added: 3 });
  assert.deepEqual(indexer.status.errors.map((e) => path.basename(e.file)).sort(), ['IMG_0.jpg', 'IMG_2.jpg']);
  // A file handle left to the garbage collector ends the process on newer Node versions.
  globalThis.gc?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('a Takeout photo whose name has no extension ("30.12.11 - 1") is found by its content and dated by its sidecar', async (t) => {
  const { put, library, indexer, source } = await setup(t);
  const sidecar = { title: '30.12.11 - 1', photoTakenTime: { timestamp: '1325263615' } };
  await put('Photos from 2011/30.12.11 - 1', await jpeg(200, 0, 0));
  await put('Photos from 2011/30.12.11 - 1.supplemental-metadata.json', JSON.stringify(sidecar));
  // Google's edited copy: "-edited" went in front of what Google took for the extension.
  await put('Photos from 2011/30.12-edited.11 - 1', await jpeg(0, 200, 0));
  // Not photos: a text file without an extension, a JPEG under another extension.
  await put('Photos from 2011/README', 'just text');
  await put('Photos from 2011/scan.pdf', await jpeg(0, 0, 200));
  assert.deepEqual(await indexer.scanSource(source), { files: 2, added: 2 });
  assert.deepEqual(indexer.status.errors, []);
  const rows = library.db.prepare('SELECT filename, kind, taken_at, date_source FROM media ORDER BY filename').all();
  assert.deepEqual(rows.map((r) => [r.filename, r.kind, new Date(r.taken_at).toISOString(), r.date_source]), [
    ['30.12-edited.11 - 1', 'image', '2011-12-30T16:46:55.000Z', 'takeout'],
    ['30.12.11 - 1', 'image', '2011-12-30T16:46:55.000Z', 'takeout'],
  ]);
});

test('photo-app libraries and app bundles are not scanned', async (t) => {
  const { put, library, indexer, source } = await setup(t);
  await put('IMG_1.jpg', await jpeg(200, 0, 0));
  await put('Photos Library.photoslibrary/originals/A/IMG_1.jpg', await jpeg(0, 200, 0));
  await put('Photos Library.photoslibrary/resources/derivatives/thumb.jpg', await jpeg(0, 0, 200));
  await put('iPhoto Library.photolibrary/Masters/IMG_2.jpg', await jpeg(9, 9, 9));
  await put('Some.app/Contents/Resources/icon.jpg', await jpeg(90, 90, 90));
  assert.deepEqual(await indexer.scanSource(source), { files: 1, added: 1 });
  assert.equal(library.stats().photos, 1);
});

test('a folder that comes back empty is treated as unavailable, not as "everything was deleted"', async (t) => {
  const { tmp, dir, put, library, indexer, source } = await setup(t);
  await put('a.jpg', await jpeg(10, 20, 30));
  await put('b.jpg', await jpeg(30, 20, 10));
  await indexer.scanSource(source);
  assert.equal(library.stats().photos, 2);

  // What an unmounted drive's mount point looks like on Linux: there, readable, empty.
  await fs.rename(dir, path.join(tmp, 'elsewhere'));
  await fs.mkdir(dir);
  const result = await indexer.scanSource(source);
  assert.equal(result.offline, true);
  assert.equal(library.stats().photos, 2, 'nothing removed');
  assert.match(indexer.status.errors[0].message, /empty/);
  assert.equal(indexer.status.running, false);

  // Deleting some photos is still picked up.
  await fs.rm(dir, { recursive: true });
  await fs.rename(path.join(tmp, 'elsewhere'), dir);
  await fs.rm(path.join(dir, 'a.jpg'));
  await indexer.scanSource(source);
  assert.equal(library.stats().photos, 1);
});

test('albums with only a title, and albums Photobox learns about after the photos were indexed', async (t) => {
  const { put, library, indexer, source } = await setup(t);
  await put('Trip/IMG_1.jpg', await jpeg(1, 2, 3));
  await put('Trip/IMG_2.jpg', await jpeg(3, 2, 1));
  await put('Family/IMG_3.jpg', await jpeg(5, 5, 5));
  await indexer.scanSource(source);
  assert.deepEqual(library.albums(), []);

  // The album files arrive (or Photobox learns to read them): the next scan files the photos in, without re-importing.
  await put('Trip/metadata.json', Buffer.from(JSON.stringify({ title: 'Sailing 2024' })));
  await put('Family/metadata.json', Buffer.from(JSON.stringify({ title: '' })));
  const version = indexer.version;
  assert.equal((await indexer.scanSource(source)).added, 0);
  assert.deepEqual(library.albums().map((a) => [a.name, a.count]), [['Family', 1], ['Sailing 2024', 2]]);
  assert.ok(indexer.version > version, 'open apps are told to refresh');
});

/** A JPEG of a pattern, with the EXIF a phone writes; `quality` changes the bytes, not the picture. */
const photo = (pattern, quality, exif = {}) => {
  const [w, h] = [64, 48];
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.fill(pattern(x, y), (y * w + x) * 3, (y * w + x) * 3 + 3);
  return sharp(px, { raw: { width: w, height: h, channels: 3 } })
    .withExif({ IFD0: { Make: 'Google', Model: 'Pixel 5' }, IFD2: { DateTimeOriginal: '2024:03:07 14:15:44', SubSecTimeOriginal: '109', ...exif } })
    .jpeg({ quality }).toBuffer();
};
const gradient = (x, y) => (x * 4 + y) % 256;
const stripes = (x) => (x % 16 < 8 ? 30 : 220);

test('the same shot from two Google accounts: the bigger file is shown, the other kept as its version', async (t) => {
  const { tmp, put, library, indexer, source } = await setup(t);
  await put('PXL_1.jpg', await photo(gradient, 20));
  await indexer.scanSource(source);
  const second = path.join(tmp, 'second');
  await fs.mkdir(second);
  await fs.writeFile(path.join(second, 'PXL_1.jpg'), await photo(gradient, 95));
  // Same moment and camera, but another picture: a different photo, never a version.
  await fs.writeFile(path.join(second, 'PXL_1(1).jpg'), await photo(stripes, 95));
  const other = library.addSource(second, null, 'Google, second account');
  const version = indexer.version;
  await indexer.scanSource(other);

  assert.equal(library.stats().photos, 2);
  assert.equal(library.stats().versions, 1);
  assert.ok(indexer.version > version, 'open apps are told to refresh');
  const shown = library.timeline({}).items.map((i) => library.mediaDetails(i.id));
  const best = shown.find((m) => m.versions.length);
  assert.equal(best.files[0].path, path.join(second, 'PXL_1.jpg'), 'the bigger file is shown');
  assert.equal(best.versions[0].files[0].path, path.join(tmp, 'photos', 'PXL_1.jpg'));
  assert.match(best.shot_key, /^i\|2024:03:07 14:15:44\.109\|Google Pixel 5\|1\.33\|$/);

  // "Not the same photo": both are shown again, also after the next scan.
  await indexer.keepApart(best.id, best.versions[0].id);
  await indexer.scanSource(source);
  assert.equal(library.stats().photos, 3);
  assert.equal(library.stats().versions, 0);
});

test("a computer upload's or a Google collage's time gives way to the date in its name; a phone upload's doesn't", async (t) => {
  const { put, library, indexer, source } = await setup(t);
  const uploadTime = '1735398014'; // 2024-12-28 15:00:14 UTC, when the computer upload happened
  const photo = async (rel, color, googlePhotosOrigin) => {
    await put(rel, await jpeg(...color));
    await put(`${rel}.supplemental-metadata.json`, JSON.stringify({ title: path.basename(rel), photoTakenTime: { timestamp: uploadTime }, googlePhotosOrigin }));
  };
  await photo('Photos from 2024/WhatsApp Image 2024-11-20 at 21.16.25.jpeg', [200, 0, 0], { webUpload: { computerUpload: {} } });
  await photo('Photos from 2021/IMG_20200808_204646064_HDR-COLLAGE.jpg', [0, 200, 0], { composition: { type: 'AUTO' } });
  await photo('Photos from 2024/IMG_20240101_120000.jpg', [0, 0, 200], { mobileUpload: { deviceType: 'ANDROID_PHONE' } });
  await photo('Photos from 2024/scan.jpg', [200, 200, 0], { webUpload: { computerUpload: {} } });
  await indexer.scanSource(source);
  const dates = () => Object.fromEntries(library.db.prepare('SELECT filename, local_time, taken_at, date_source FROM media').all()
    .map((m) => [m.filename, m.date_source === 'filename' ? [m.local_time, m.date_source] : [m.taken_at, m.date_source]]));
  const expected = {
    'WhatsApp Image 2024-11-20 at 21.16.25.jpeg': ['2024-11-20 21:16:25', 'filename'],
    'IMG_20200808_204646064_HDR-COLLAGE.jpg': ['2020-08-08 20:46:46', 'filename'],
    'IMG_20240101_120000.jpg': [1735398014000, 'takeout'],
    'scan.jpg': [1735398014000, 'upload'],
  };
  assert.deepEqual(dates(), expected);

  // A library that took Google's guess for the capture time puts it right on the next scan, files unchanged.
  library.db.prepare("UPDATE media SET taken_at = ?, local_time = '2024-12-28 16:00:14', date_source = 'takeout'").run(1735398014000);
  await indexer.scanSource(source);
  assert.deepEqual(dates(), expected);
});

test('items indexed before versions existed get their shot key and thumbnail hash on the next scan', async (t) => {
  const { put, library, indexer, source } = await setup(t);
  await put('PXL_1.jpg', await photo(gradient, 50));
  await indexer.scanSource(source);
  library.db.exec('UPDATE media SET shot_key = NULL, dhash = NULL');
  await indexer.scanSource(source);
  const [m] = library.db.prepare('SELECT shot_key, dhash FROM media').all();
  assert.match(m.shot_key, /^i\|/);
  assert.match(m.dhash, /^[0-9a-f]{16}$/);
});
