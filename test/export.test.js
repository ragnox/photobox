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
import { Indexer, quickHash } from '../src/indexer.js';
import { exportLibrary, safeStem, MANIFEST } from '../src/export.js';

async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-export-'));
  const library = new Library(path.join(tmp, 'library.db'));
  const source = library.addSource(path.join(tmp, 'src'));
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Put a file in the source folder and index it the way the indexer would. */
  async function add(file, { content = file, taken, local, filename, album, liveOf, favorite, people, description, lat, lon } = {}) {
    const full = path.join(tmp, 'src', file);
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
});
