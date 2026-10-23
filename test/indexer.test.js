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
