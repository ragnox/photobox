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
