// Export: a small library built straight in the database (no ffmpeg needed),
// exported into YYYY/MM folders, exported again, and indexed back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { quickHash } from '../src/files.js';
import { exportLibrary, safeStem, withExportLock, WRITING } from '../src/export.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { MANIFEST } from '../src/manifest.js';
import { createHash } from 'node:crypto';

async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-export-'));
  const library = new Library(path.join(tmp, 'library.db'));
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Put a file in a source folder (tmp/src unless `root` says otherwise) and index it the way the indexer would. */
  async function add(file, { root = path.join(tmp, 'src'), content = file, taken, local, filename, album, liveOf, favorite, people, description, lat, lon } = {}) {
    const source = library.addSource(root);
    const full = path.join(root, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    const stat = await fs.stat(full);
    const hash = await quickHash(full, stat.size);
    let media = library.mediaByHash(hash);
    if (!media) {
      const id = library.insertMedia({
        hash, kind: /\.(mp4|mov)$/i.test(file) ? 'video' : 'image', filename: filename ?? path.basename(file),
        takenAt: Date.parse(taken), localTime: local, dateSource: 'takeout', favorite, people, description, lat, lon,
        bytes: stat.size,
      });
      if (liveOf) library.db.prepare('UPDATE media SET live_of = ? WHERE id = ?').run(liveOf.id, id);
      media = library.media(id);
    }
    library.upsertFile({
      path: full, sourceId: source.id, mediaId: media.id, albumIds: album ? [library.albumId(album)] : [],
      size: stat.size, mtime: Math.floor(stat.mtimeMs),
    });
    return { ...media, path: full };
  }

  const dest = path.join(tmp, 'library');
  const files = async (dir = dest, prefix = '') => {
    const out = [];
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await files(path.join(dir, e.name), rel)));
      else out.push(rel);
    }
    return out.sort();
  };
  const manifest = async () => JSON.parse(await fs.readFile(path.join(dest, MANIFEST), 'utf8'));
  return { tmp, library, add, dest, files, manifest };
}

/** A small, distinct JPEG without EXIF, so dates can only come from the manifest. */
const jpeg = (r, g, b) => sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

/** Index an exported folder in a fresh library, as `photobox scan <dest>` would. */
async function reimport(t, tmp, dest) {
  const config = loadConfig({ dataDir: path.join(tmp, 'reimport') });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  const indexer = new Indexer(library, config);
  const source = library.addSource(dest);
  await indexer.scanSource(source);
  const media = (name) => {
    const row = library.db.prepare('SELECT id FROM media WHERE filename = ?').get(name);
    return row ? library.mediaDetails(row.id) : null;
  };
  return { library, indexer, source, media };
}

test('copies each item once into YYYY/MM of the local date, dated when it was taken', async (t) => {
  const { library, add, dest, files, manifest } = await setup(t);
  const opts = { taken: '2019-07-13T08:15:00Z', local: '2019-07-13 10:15:00' };
  await add('Photos from 2019/DSC_0001.JPG', { ...opts, content: 'same', favorite: true, people: ['Anna'] });
  await add('Summer in Vienna/DSC_0001.JPG', { ...opts, content: 'same', album: 'Summer in Vienna' });
  // 23:30 UTC on 31 July was already 1 August in Vienna.
  await add('Photos from 2019/DSC_0002.JPG', { taken: '2019-07-31T23:30:00Z', local: '2019-08-01 01:30:00' });

  const result = await exportLibrary(library, dest);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.copied, 2);
  assert.deepEqual(await files(), ['2019/07/DSC_0001.JPG', '2019/08/DSC_0002.JPG', MANIFEST]);
  assert.equal(await fs.readFile(path.join(dest, '2019/07/DSC_0001.JPG'), 'utf8'), 'same');
  assert.equal((await fs.stat(path.join(dest, '2019/07/DSC_0001.JPG'))).mtime.toISOString(), '2019-07-13T08:15:00.000Z');

  const m = await manifest();
  assert.deepEqual(m.albums, { 'Summer in Vienna': ['2019/07/DSC_0001.JPG'] });
  const entry = m.items['2019/07/DSC_0001.JPG'];
  assert.equal(entry.takenAt, '2019-07-13T08:15:00.000Z');
  assert.equal(entry.localTime, '2019-07-13 10:15:00');
  assert.equal(entry.favorite, true);
  assert.deepEqual(entry.people, ['Anna']);
});

test('same name in the same month gets a number; live clips keep their still’s name', async (t) => {
  const { library, add, dest, files, manifest } = await setup(t);
  const opts = { taken: '2020-05-01T10:00:00Z', local: '2020-05-01 12:00:00' };
  await add('cam1/IMG_0001.JPG', { ...opts, content: 'camera one' });
  await add('cam2/IMG_0001.JPG', { ...opts, content: 'camera two', taken: '2020-05-02T10:00:00Z', local: '2020-05-02 12:00:00' });
  await add('cam1/IMG_0001.HEIC', { ...opts, content: 'heic still', taken: '2020-05-03T10:00:00Z', local: '2020-05-03 12:00:00' });
  const still = await add('cam2/IMG_0001.heic', { content: 'other still', taken: '2020-05-04T10:00:00Z', local: '2020-05-04 12:00:00' });
  await add('cam2/IMG_0001.MOV', { content: 'motion', taken: '2020-05-04T10:00:00Z', local: '2020-05-04 12:00:00', liveOf: still });
  await add('Trip: day 1.jpg', { ...opts, filename: 'Trip: day 1/2.jpg' });

  await exportLibrary(library, dest);
  assert.deepEqual(await files(), [
    '2020/05/IMG_0001 (2).JPG',
    '2020/05/IMG_0001 (2).MOV',
    '2020/05/IMG_0001 (2).heic', // .HEIC and .heic are one name on a case-insensitive drive
    '2020/05/IMG_0001.HEIC',
    '2020/05/IMG_0001.JPG',
    '2020/05/Trip_ day 1_2.jpg',
    MANIFEST,
  ]);
  assert.equal(await fs.readFile(path.join(dest, '2020/05/IMG_0001 (2).MOV'), 'utf8'), 'motion');
  const m = await manifest();
  assert.equal(m.items['2020/05/IMG_0001 (2).MOV'].liveOf, '2020/05/IMG_0001 (2).heic');
  assert.equal(m.items['2020/05/Trip_ day 1_2.jpg'].originalName, 'Trip: day 1/2.jpg');
});

test('a Pixel motion photo is exported the way Google names it: "X.MP.jpg" and "X.MP"', async (t) => {
  const { library, add, dest, files, manifest } = await setup(t);
  const opts = { taken: '2026-05-04T16:38:43Z', local: '2026-05-04 18:38:43' };
  const still = await add('PXL_20260504_163843948.MP.jpg', opts);
  await add('PXL_20260504_163843948.MP', { ...opts, liveOf: still });
  await exportLibrary(library, dest);
  assert.deepEqual(await files(), ['2026/05/PXL_20260504_163843948.MP', '2026/05/PXL_20260504_163843948.MP.jpg', MANIFEST]);
  assert.equal((await manifest()).items['2026/05/PXL_20260504_163843948.MP'].liveOf, '2026/05/PXL_20260504_163843948.MP.jpg');
});

test('never overwrites, and running again copies only what is new or missing', async (t) => {
  const { library, add, dest, files } = await setup(t);
  const opts = { taken: '2021-01-10T10:00:00Z', local: '2021-01-10 11:00:00' };
  await add('a.jpg', opts);
  await add('b.jpg', opts);
  // Someone else's file is already sitting where b.jpg would go.
  await fs.mkdir(path.join(dest, '2021/01'), { recursive: true });
  await fs.writeFile(path.join(dest, '2021/01/b.jpg'), 'not ours');

  assert.equal((await exportLibrary(library, dest)).copied, 2);
  assert.equal(await fs.readFile(path.join(dest, '2021/01/b.jpg'), 'utf8'), 'not ours');
  assert.equal(await fs.readFile(path.join(dest, '2021/01/b (2).jpg'), 'utf8'), 'b.jpg');

  let again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present], [0, 2]);

  await add('c.jpg', opts);
  await fs.rm(path.join(dest, '2021/01/a.jpg'));
  again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present], [2, 1]);

  // Without the manifest, files that are already there are recognised by content.
  await fs.rm(path.join(dest, MANIFEST));
  again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present], [0, 3]);
  assert.deepEqual(await files(), ['2021/01/a.jpg', '2021/01/b (2).jpg', '2021/01/b.jpg', '2021/01/c.jpg', MANIFEST]);
});

test('an exported file that has not changed is not read again for a week; a changed one is read again at once', async (t) => {
  const { library, add, dest } = await setup(t);
  const opts = { taken: '2021-01-10T10:00:00Z', local: '2021-01-10 11:00:00' };
  await add('a.jpg', opts);
  await add('b.jpg', opts);
  await exportLibrary(library, dest);
  // Noted by real path, the same whether the export made the folder or found it (macOS: /var is /private/var).
  const [a, b] = ['a.jpg', 'b.jpg'].map((name) => path.join(dest, '2021/01', name));
  const real = await fs.realpath(dest);
  const checked = (file) => library.exportCheck(path.join(real, path.relative(dest, file)))?.checked_at;
  const first = { a: checked(a), b: checked(b) };
  assert.ok(first.a && first.b, 'the copies were checked when they were made');

  await new Promise((resolve) => setTimeout(resolve, 5));
  let again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present], [0, 2]);
  assert.deepEqual({ a: checked(a), b: checked(b) }, first, 'neither was read again');

  // Touched: its stamps changed, so it is read again. A week on, everything is.
  await fs.utimes(a, new Date(), new Date());
  await exportLibrary(library, dest);
  assert.ok(checked(a) > first.a, 'the touched file was read again');
  assert.equal(checked(b), first.b);
  library.db.prepare('UPDATE export_checks SET checked_at = checked_at - ?').run(8 * 24 * 3600_000);
  again = await exportLibrary(library, dest);
  assert.ok(checked(b) > first.b, 'a week-old check is done again');
  assert.deepEqual([again.copied, again.present], [0, 2]);
});

test('files moved or renamed inside the export are not copied again', async (t) => {
  const { library, add, dest, files, manifest } = await setup(t);
  const opts = { taken: '2021-01-10T10:00:00Z', local: '2021-01-10 11:00:00' };
  await add('Ski/a.jpg', { ...opts, album: 'Ski' });
  await add('b.jpg', opts);
  await add('c.jpg', opts);
  await exportLibrary(library, dest);

  await fs.mkdir(path.join(dest, 'Best of'));
  await fs.rename(path.join(dest, '2021/01/a.jpg'), path.join(dest, 'Best of/first run.jpg'));
  await fs.rename(path.join(dest, '2021/01/b.jpg'), path.join(dest, '2021/01/b renamed.jpg'));
  await fs.rm(path.join(dest, '2021/01/c.jpg'));
  // Same size as c.jpg, different content: not mistaken for it.
  await fs.writeFile(path.join(dest, 'Best of/x.jpg'), 'c.jpX');

  const again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present], [1, 2], 'only the deleted one is copied again');
  assert.deepEqual(await files(), ['2021/01/b renamed.jpg', '2021/01/c.jpg', 'Best of/first run.jpg', 'Best of/x.jpg', MANIFEST]);
  const m = await manifest();
  assert.deepEqual(Object.keys(m.items), ['2021/01/b renamed.jpg', '2021/01/c.jpg', 'Best of/first run.jpg']);
  assert.deepEqual(m.albums, { Ski: ['Best of/first run.jpg'] });
});

test('a Takeout unpacked inside the export folder is copied, not taken for the export', async (t) => {
  const { library, add, dest, files } = await setup(t);
  await add('Photos from 2018/IMG_1.jpg', { root: path.join(dest, 'Takeout'), taken: '2018-05-01T10:00:00Z', local: '2018-05-01 12:00:00' });
  assert.equal((await exportLibrary(library, dest)).copied, 1);
  assert.deepEqual(await files(), ['2018/05/IMG_1.jpg', 'Takeout/Photos from 2018/IMG_1.jpg', MANIFEST]);
});

test('skips sources that are gone or changed since the scan; dry run writes nothing', async (t) => {
  const { library, add, dest, files } = await setup(t);
  const opts = { taken: '2022-03-01T10:00:00Z', local: '2022-03-01 11:00:00' };
  const gone = await add('gone.jpg', opts);
  const edited = await add('edited.jpg', opts);
  await add('fine.jpg', opts);
  await fs.rm(gone.path);
  await fs.writeFile(edited.path, 'edited after the scan');

  const dry = await exportLibrary(library, dest, { dryRun: true });
  assert.deepEqual(dry.planned.map((p) => p.rel), ['2022/03/fine.jpg']);
  assert.deepEqual(await files(), []);

  const result = await exportLibrary(library, dest);
  assert.equal(result.copied, 1);
  assert.deepEqual(result.skipped.map((s) => s.name).sort(), ['edited.jpg', 'gone.jpg']);
  assert.match(result.skipped.find((s) => s.name === 'edited.jpg').reason, /changed/);
  assert.deepEqual(await files(), ['2022/03/fine.jpg', MANIFEST]);
});

test('a photo whose name has no extension is exported with the one its content shows', async (t) => {
  const { add, library, dest, files } = await setup(t);
  await add('Photos from 2011/30.12.11 - 1', { content: await jpeg(200, 0, 0), taken: '2011-12-30T16:46:55Z', local: '2011-12-30 17:46:55' });
  await exportLibrary(library, dest);
  assert.deepEqual(await files(), ['2011/12/30.12.11 - 1.jpg', MANIFEST]);
});

test('safeStem keeps real names and makes them safe for any drive', () => {
  assert.equal(safeStem('Café Central.jpg'), 'Café Central');
  assert.equal(safeStem('a<b>c:d"e|f?g*h.png'), 'a_b_c_d_e_f_g_h');
  assert.equal(safeStem('.hidden.jpg'), 'hidden');
  assert.equal(safeStem('notes. '), 'notes');
  assert.equal(safeStem('IMG_1.jpg.unknown'), 'IMG_1.jpg.unknown');
  assert.ok(Buffer.byteLength(safeStem(`${'日本'.repeat(80)}.jpg`)) <= 200);
});

test('an exported folder added back keeps its albums, favorites, descriptions, people and dates', async (t) => {
  const { tmp, library, add, dest } = await setup(t);
  const vienna = { taken: '2019-07-13T08:15:00Z', local: '2019-07-13 10:15:00' };
  const dom = await jpeg(200, 40, 40);
  const details = { favorite: true, people: ['Anna'], description: 'Stephansdom at golden hour', lat: 48.2082, lon: 16.3738 };
  await add('Photos from 2019/DSC_0001.JPG', { ...vienna, ...details, content: dom });
  await add('Vienna/DSC_0001.JPG', { ...vienna, content: dom, album: 'Vienna' });
  await add('Best of 2019/DSC_0001.JPG', { ...vienna, content: dom, album: 'Best of 2019' });
  // No GPS and no EXIF: only the manifest knows this was 9:30 in Tokyo.
  const tokyo = { taken: '2023-04-01T00:30:00Z', local: '2023-04-01 09:30:00' };
  await add('Vienna/Trip day 1.jpg', { ...tokyo, content: await jpeg(40, 200, 40), filename: 'Trip: day 1/2.jpg', album: 'Vienna' });
  await exportLibrary(library, dest);

  const back = await reimport(t, tmp, dest);
  assert.deepEqual(back.indexer.status.errors, []);
  assert.deepEqual(Object.fromEntries(back.library.albums().map((a) => [a.name, a.count])), { 'Best of 2019': 1, Vienna: 2 });
  const photo = back.media('DSC_0001.JPG');
  assert.deepEqual(photo.albums, ['Best of 2019', 'Vienna'], 'one file, two albums');
  assert.equal(photo.favorite, 1);
  assert.deepEqual(photo.people, ['Anna']);
  assert.equal(photo.description, 'Stephansdom at golden hour');
  assert.ok(Math.abs(photo.lat - 48.2082) < 1e-9 && Math.abs(photo.lon - 16.3738) < 1e-9);
  assert.equal(new Date(photo.taken_at).toISOString(), '2019-07-13T08:15:00.000Z');
  assert.equal(photo.local_time, '2019-07-13 10:15:00');

  const trip = back.media('Trip: day 1/2.jpg');
  assert.ok(trip, 'the real name comes back, not the drive-safe file name');
  assert.equal(trip.local_time, '2023-04-01 09:30:00');
  assert.equal(trip.date_source, 'takeout');
});

test('a re-export updates an indexed export, also when only one folder is rescanned', async (t) => {
  const { tmp, library, add, dest } = await setup(t);
  const opts = { taken: '2020-01-05T10:00:00Z', local: '2020-01-05 11:00:00' };
  const ski = await jpeg(10, 10, 200);
  await add('Ski/a.jpg', { ...opts, content: ski, album: 'Ski' });
  const b = await add('Ski/b.jpg', { ...opts, content: await jpeg(10, 200, 200) });
  await exportLibrary(library, dest);
  const back = await reimport(t, tmp, dest);
  assert.equal(back.media('b.jpg').favorite, 0);

  await add('Best of 2020/a.jpg', { ...opts, content: ski, album: 'Best of 2020' });
  library.setFavorite(b.id, true);
  await add('Ski/c.jpg', { taken: '2020-02-01T10:00:00Z', local: '2020-02-01 11:00:00', content: await jpeg(200, 200, 10), album: 'Ski' });
  await exportLibrary(library, dest);

  // The watcher rescans just the folder a new photo landed in; its manifest is two levels up.
  await back.indexer.scanFolders(back.source, [path.join(dest, '2020', '02')]);
  assert.deepEqual(back.media('c.jpg').albums, ['Ski']);
  assert.equal(back.media('c.jpg').local_time, '2020-02-01 11:00:00');

  // A changed manifest makes the watcher rescan the whole export.
  await back.indexer.scanSource(back.source);
  assert.deepEqual(back.media('a.jpg').albums, ['Best of 2020', 'Ski']);
  assert.equal(back.media('b.jpg').favorite, 1);
  assert.deepEqual(back.indexer.status.errors, []);
});

test('files moved or renamed inside an export keep their details', async (t) => {
  const { tmp, library, add, dest } = await setup(t);
  await add('Ski/a.jpg', { taken: '2020-01-05T10:00:00Z', local: '2020-01-05 11:00:00', content: await jpeg(90, 90, 90), album: 'Ski', favorite: true });
  await exportLibrary(library, dest);
  const back = await reimport(t, tmp, dest);

  await fs.mkdir(path.join(dest, 'Best'));
  await fs.rename(path.join(dest, '2020/01/a.jpg'), path.join(dest, 'Best/first run.jpg'));
  await back.indexer.scanSource(back.source);
  assert.equal(back.media('a.jpg'), null);
  const moved = back.media('first run.jpg');
  assert.deepEqual(moved.albums, ['Ski']);
  assert.equal(moved.favorite, 1);
  assert.equal(moved.local_time, '2020-01-05 11:00:00');
  assert.equal((await back.indexer.scanSource(back.source)).added, 0);

  // Exporting the re-indexed library into its own folder doesn't copy the moved photo back either.
  const again = await exportLibrary(back.library, dest);
  assert.deepEqual([again.copied, again.present], [0, 1]);
});

test('a better version of an exported photo: it is copied under a new name, the old file moves to .photobox/superseded', async (t) => {
  const { tmp, library, add, dest, files, manifest } = await setup(t);
  const at = { taken: '2024-03-07T13:15:44Z', local: '2024-03-07 14:15:44' };
  const withSha = async (m) => {
    const sha256 = createHash('sha256').update(await fs.readFile(m.path)).digest('hex');
    library.db.prepare('UPDATE media SET sha256 = ? WHERE id = ?').run(sha256, m.id);
    return { ...m, sha256 };
  };
  const old = await withSha(await add('Takeout/PXL_1.jpg', { ...at, content: 'recompressed', album: 'Trip' }));
  await exportLibrary(library, dest);
  assert.deepEqual(await files(), ['2024/03/PXL_1.jpg', MANIFEST]);

  const better = await withSha(await add('PXL_1.jpg', { ...at, root: path.join(tmp, 'second'), content: 'the original, bigger' }));
  library.applyVersions(new Map([[old.id, better.id]]));
  const preview = await exportLibrary(library, dest, { dryRun: true });
  assert.deepEqual([preview.planned.length, preview.superseded, preview.aside], [1, 0, ['2024/03/PXL_1.jpg']], 'a dry run says what would move, and moves nothing');
  const result = await exportLibrary(library, dest);
  assert.deepEqual([result.copied, result.superseded, result.total], [1, 1, 1]);
  // The SSD copy only adds files: a new name reaches it, a replaced file under the old name never would.
  assert.deepEqual(await files(), ['.photobox/superseded/2024/03/PXL_1.jpg', '2024/03/PXL_1 (2).jpg', MANIFEST]);
  assert.equal(await fs.readFile(path.join(dest, '.photobox/superseded/2024/03/PXL_1.jpg'), 'utf8'), 'recompressed');
  const m = await manifest();
  assert.deepEqual(Object.keys(m.items), ['2024/03/PXL_1 (2).jpg']);
  assert.deepEqual(m.items['2024/03/PXL_1 (2).jpg'].albums, ['Trip'], 'the old version\'s album comes along');
  assert.deepEqual(m.superseded['.photobox/superseded/2024/03/PXL_1.jpg'],
    { ...m.superseded['.photobox/superseded/2024/03/PXL_1.jpg'], sha256: old.sha256, supersededBy: better.sha256, exportedAs: '2024/03/PXL_1.jpg' });

  const again = await exportLibrary(library, dest);
  assert.deepEqual([again.copied, again.present, again.superseded], [0, 1, 0]);
  assert.ok((await manifest()).superseded['.photobox/superseded/2024/03/PXL_1.jpg'], 'remembered across exports');
});

test('an exported photo whose better version can\'t be copied stays where it is', async (t) => {
  const { tmp, library, add, dest, files } = await setup(t);
  const at = { taken: '2024-03-07T13:15:44Z', local: '2024-03-07 14:15:44' };
  const old = await add('PXL_1.jpg', { ...at, content: 'recompressed' });
  library.db.prepare('UPDATE media SET sha256 = ? WHERE id = ?').run(createHash('sha256').update('recompressed').digest('hex'), old.id);
  await exportLibrary(library, dest);
  const better = await add('PXL_1.jpg', { ...at, root: path.join(tmp, 'second'), content: 'the original, bigger' });
  library.db.prepare('UPDATE media SET sha256 = ? WHERE id = ?').run(createHash('sha256').update('the original, bigger').digest('hex'), better.id);
  library.applyVersions(new Map([[old.id, better.id]]));
  await fs.rm(better.path); // the second account's folder went offline
  const result = await exportLibrary(library, dest);
  assert.deepEqual([result.copied, result.superseded, result.skipped.length], [0, 0, 1]);
  assert.deepEqual(await files(), ['2024/03/PXL_1.jpg', MANIFEST]);
});

test('a Photobox in another process waits while one writes to the folder; a lock left by a process that is gone is taken over', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-lock-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.after(() => other.kill());
  const lock = path.join(tmp, WRITING);
  await fs.writeFile(lock, JSON.stringify({ pid: other.pid, since: new Date().toISOString() }));

  await assert.rejects(withExportLock(tmp, async () => 'wrote', { wait: 300 }), new RegExp(`Another Photobox \\(process ${other.pid}\\) is writing`));
  const waiting = withExportLock(tmp, async () => 'wrote', { wait: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await fs.rm(lock);
  assert.equal(await waiting, 'wrote', 'it goes ahead once the other is done');

  await fs.writeFile(lock, JSON.stringify({ pid: other.pid, since: new Date().toISOString() }));
  other.kill();
  await once(other, 'exit');
  const held = await withExportLock(tmp, async () => JSON.parse(await fs.readFile(lock, 'utf8')).pid);
  assert.equal(held, process.pid, 'the lock of a process that is gone is taken over');
  assert.deepEqual(await fs.readdir(tmp), [], 'and let go of afterwards');
});
