import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/db.js';

test('libraries from before file_albums keep their albums', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-db-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'library.db');

  // Today's schema with the old single album_id column put back, filled the old way.
  let library = new Library(dbPath);
  library.db.exec(`
    ALTER TABLE files ADD COLUMN album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL;
    CREATE INDEX files_album ON files(album_id);`);
  const source = library.addSource('/photos');
  const mediaId = library.insertMedia({ hash: 'h1', kind: 'image', filename: 'a.jpg', takenAt: 0, localTime: '1970-01-01 01:00:00', dateSource: 'file' });
  const trip = library.albumId('Trip');
  const best = library.albumId('Best');
  library.db.exec(`
    INSERT INTO files (path, source_id, media_id, album_id, size, mtime) VALUES
      ('/photos/Trip/a.jpg', ${source.id}, ${mediaId}, ${trip}, 1, 0),
      ('/photos/Best/a.jpg', ${source.id}, ${mediaId}, ${best}, 1, 0),
      ('/photos/2019/a.jpg', ${source.id}, ${mediaId}, NULL, 1, 0);`);
  library.close();

  library = new Library(dbPath);
  t.after(() => library.close());
  assert.ok(!library.db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'album_id'));
  assert.deepEqual(library.mediaDetails(mediaId).albums, ['Best', 'Trip']);
  assert.deepEqual(library.albums().map((a) => [a.name, a.count]), [['Best', 1], ['Trip', 1]]);
  assert.equal(library.timeline({ albumId: trip }).items.length, 1);

  library.removeFiles(['/photos/Trip/a.jpg']);
  assert.deepEqual(library.albums().map((a) => a.name), ['Best'], 'an album with no files left is removed');
});

test('album counts and covers match what the album shows: no live-photo clips, nothing archived', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-db-'));
  const library = new Library(path.join(tmp, 'library.db'));
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const source = library.addSource('/photos');
  const trip = library.albumId('Trip');
  const add = (name, takenAt, extra = {}) => {
    const id = library.insertMedia({ hash: name, kind: name.endsWith('.mp4') ? 'video' : 'image', filename: name, takenAt, localTime: '2020-01-01 12:00:00', dateSource: 'file', ...extra });
    library.upsertFile({ path: `/photos/Trip/${name}`, sourceId: source.id, mediaId: id, albumIds: [trip], size: 1, mtime: 0 });
    return id;
  };
  const still = add('IMG_1.HEIC', 1000);
  const clip = add('IMG_1.mp4', 3000);
  library.db.prepare('UPDATE media SET live_of = ? WHERE id = ?').run(still, clip);
  add('old.jpg', 4000, { archived: true });
  add('IMG_2.jpg', 2000);

  const [album] = library.albums();
  assert.equal(album.count, 2, 'the still and IMG_2, as in the album view');
  assert.equal(library.timeline({ albumId: trip }).items.length, 2);
  assert.equal(library.media(album.cover).filename, 'IMG_2.jpg', 'the newest visible photo, not the archived one');
});

test('live photos pair up, including Pixel motion photos from Takeout ("X.MP.jpg" + "X.MP")', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-db-'));
  const library = new Library(path.join(tmp, 'library.db'));
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const source = library.addSource('/photos');
  const add = (name, kind, duration = null) => {
    const id = library.insertMedia({ hash: name, kind, filename: name, takenAt: 0, localTime: '2026-05-04 18:38:43', dateSource: 'file', duration });
    library.upsertFile({ path: `/photos/${name}`, sourceId: source.id, mediaId: id, size: 1, mtime: 0 });
    return id;
  };
  const pixel = add('PXL_20260504_163843948.MP.jpg', 'image');
  const motion = add('PXL_20260504_163843948.MP', 'video', 0.83);
  const iphone = add('IMG_1234.HEIC', 'image');
  const live = add('IMG_1234.MOV', 'video', 2.5);
  const movie = add('IMG_9999.MOV', 'video', 2.5);
  library.linkLivePhotos(source.id);
  assert.equal(library.media(motion).live_of, pixel);
  assert.equal(library.media(live).live_of, iphone);
  assert.equal(library.media(movie).live_of, null, 'a short video without a still stays a video');
  assert.deepEqual(library.timeline({}).items.map((i) => i.id).sort(), [pixel, iphone, movie].sort());
});

test('albums are per source: a library from before is split by the source of each album\'s files', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-db-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'library.db');

  // Today's schema with the old albums table put back: one album per name, across sources.
  let library = new Library(dbPath);
  library.db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP INDEX albums_source_name; DROP TABLE albums;
    CREATE TABLE albums (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    PRAGMA foreign_keys = ON;`);
  const main = library.addSource('/google-main');
  const second = library.addSource('/google-second');
  const trip = Number(library.db.prepare("INSERT INTO albums (name) VALUES ('Trip')").run().lastInsertRowid);
  const solo = Number(library.db.prepare("INSERT INTO albums (name) VALUES ('Solo')").run().lastInsertRowid);
  library.db.prepare("INSERT INTO albums (name) VALUES ('Empty')").run();
  const add = (source, name, albumId) => {
    const id = library.insertMedia({ hash: name, kind: 'image', filename: name, takenAt: 0, localTime: '2020-01-01 12:00:00', dateSource: 'file' });
    library.db.prepare('INSERT INTO files (path, source_id, media_id, size, mtime) VALUES (?, ?, ?, 1, 0)').run(`${source.path}/${name}`, source.id, id);
    library.db.prepare('INSERT INTO file_albums (file_id, album_id) SELECT id, ? FROM files WHERE path = ?').run(albumId, `${source.path}/${name}`);
  };
  add(main, 'a.jpg', trip);
  add(main, 'b.jpg', trip);
  add(second, 'c.jpg', trip);
  add(second, 'd.jpg', solo);
  library.close();

  library = new Library(dbPath);
  t.after(() => library.close());
  const albums = library.albums().map((a) => [a.name, a.source_id, a.count]);
  assert.deepEqual(albums, [['Solo', second.id, 1], ['Trip', main.id, 2], ['Trip', second.id, 1]]);
  assert.equal(library.albums().find((a) => a.source_id === main.id).id, trip, 'the source with the most photos keeps the id (and links to it)');
  assert.equal(library.albumId('Trip', second.id), library.albums().find((a) => a.name === 'Trip' && a.source_id === second.id).id);
  assert.notEqual(library.albumId('Trip', main.id), library.albumId('Trip', second.id));
  assert.deepEqual(library.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a superseded version is shown as the version that replaced it: in albums, sources and favorites, but not in the timeline or export', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-db-'));
  const library = new Library(path.join(tmp, 'library.db'));
  t.after(async () => {
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const main = library.addSource('/google-main', null, 'Google, main');
  const second = library.addSource('/google-second');
  const add = (source, name, extra = {}, album = null) => {
    const id = library.insertMedia({ hash: `${source.id}${name}`, sha256: `${source.id}${name}`, kind: name.endsWith('.MP') ? 'video' : 'image', filename: name, takenAt: 1000, localTime: '2024-03-07 14:15:44', dateSource: 'exif', ...extra });
    library.upsertFile({ path: `${source.path}/${name}`, sourceId: source.id, mediaId: id, albumIds: album ? [library.albumId(album, source.id)] : [], size: 1, mtime: 0 });
    return id;
  };
  const small = add(main, 'PXL_1.MP.jpg', { bytes: 300, favorite: true, description: 'Lunch', lat: 47.1, lon: 11.2 }, 'Trip');
  const clip = add(main, 'PXL_1.MP', { duration: 1.2 });
  library.linkLivePhotos(main.id);
  const big = add(second, 'PXL_1.MP.jpg', { bytes: 1500 });

  assert.equal(library.applyVersions(new Map([[small, big]])), true);
  assert.equal(library.applyVersions(new Map([[small, big]])), false, 'nothing new the second time');
  assert.deepEqual(library.timeline({}).items.map((i) => i.id), [big]);
  assert.equal(library.media(clip).live_of, big, 'the clip moves to the version shown, which has none');
  assert.ok(library.timeline({}).items[0].live);
  const [trip] = library.albums();
  assert.deepEqual([trip.name, trip.count, trip.cover], ['Trip', 1, big]);
  assert.deepEqual(library.timeline({ albumId: trip.id }).items.map((i) => i.id), [big]);
  assert.deepEqual(library.timeline({ sourceId: main.id }).items.map((i) => i.id), [big]);
  assert.deepEqual(library.months({ sourceId: second.id }).map((m) => m.count), [1]);
  assert.deepEqual(library.exportItems().map((m) => m.id), [big, clip]);
  assert.deepEqual(library.exportItems()[0].albums, ['Trip']);
  assert.equal(library.stats().photos, 1);
  assert.equal(library.stats().versions, 1);

  const shown = library.mediaDetails(big);
  assert.deepEqual([shown.favorite, shown.description, shown.lat, shown.lon], [1, 'Lunch', 47.1, 11.2], 'what the old version knew carries over');
  assert.deepEqual(shown.sources.sort(), [main.id, second.id]);
  assert.deepEqual(shown.versions.map((v) => v.id), [small]);
  assert.equal(library.replacementOf(`${main.id}PXL_1.MP.jpg`), `${second.id}PXL_1.MP.jpg`);
  library.setFavorite(big, false);
  library.applyVersions(new Map([[small, big]]));
  assert.equal(library.media(big).favorite, 0, 'unfavoriting the shown version unfavorites its versions too');

  // Kept apart: both shown again.
  assert.ok(library.keepApart(big, small));
  assert.equal(library.separatePairs().size, 1);
  assert.equal(library.applyVersions(new Map()), true);
  assert.deepEqual(library.timeline({}).items.map((i) => i.id).sort(), [small, big].sort());
  assert.equal(library.sources().find((s) => s.id === main.id).name, 'Google, main');
});
