// Export: a small library built straight in the database (no ffmpeg needed),
// exported into YYYY/MM folders and exported again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/db.js';
import { quickHash } from '../src/indexer.js';
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
  async function add(file, { content = file, taken, local, filename, album, liveOf, favorite, people } = {}) {
    const full = path.join(tmp, 'src', file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    const stat = await fs.stat(full);
    const hash = await quickHash(full, stat.size);
    let media = library.mediaByHash(hash);
    if (!media) {
      const id = library.insertMedia({
        hash, kind: /\.(mp4|mov)$/i.test(file) ? 'video' : 'image', filename: filename ?? path.basename(file),
        takenAt: Date.parse(taken), localTime: local, dateSource: 'takeout', favorite, people, bytes: stat.size,
      });
      if (liveOf) library.db.prepare('UPDATE media SET live_of = ? WHERE id = ?').run(liveOf.id, id);
      media = library.media(id);
    }
    library.upsertFile({
      path: full, sourceId: source.id, mediaId: media.id, albumId: album ? library.albumId(album) : null,
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
