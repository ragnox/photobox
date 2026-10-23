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
