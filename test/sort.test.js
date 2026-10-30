// `photobox sort`: what is already in an archive moves into YYYY/MM, and can be put back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { initArchive } from '../src/archive.js';
import { folderAlbum, sortArchive, undoSort } from '../src/sort.js';
import { MANIFEST } from '../src/manifest.js';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { exportLibrary } from '../src/export.js';

const photo = (rgb, when = null) => {
  const image = sharp({ create: { width: 32, height: 24, channels: 3, background: rgb } });
  return (when ? image.withExif({ IFD0: { Make: 'Canon', Model: 'EOS' }, IFD2: { DateTimeOriginal: when } }) : image).jpeg().toBuffer();
};

/** Every file under `dir` (hidden ones too), relative, sorted. */
async function listing(dir) {
  const out = [];
  const visit = async (d) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) await visit(file);
      else out.push(path.relative(dir, file).split(path.sep).join('/'));
    }
  };
  await visit(dir);
  return out.sort();
}

async function setup(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-sort-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'Pictures');
  const put = async (rel, data) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), data);
  };
  const boat = await photo({ r: 0, g: 90, b: 200 }, '2017:03:10 12:00:00');
  await put('BVI 2017/IMG_1.jpg', boat);
  await put('Google/IMG_1.jpg', boat); // the same bytes in another folder
  await put('Trip/IMG_1.jpg', await photo({ r: 200, g: 0, b: 0 }, '2017:03:22 08:30:00')); // same name, same month
  await put('BVI 2017/GoPro/GOPR1.jpg', await photo({ r: 0, g: 200, b: 0 }, '2017:03:11 09:00:00'));
  await put('BVI 2017/notes.txt', 'not a photo');
  await put('20140419_184522.jpg', await photo({ r: 9, g: 9, b: 9 }));
  await put('Canon/DCIM/100CANON/IMG_9.jpg', await photo({ r: 90, g: 90, b: 0 }, '2012:07:01 10:00:00'));
  await put('Canon/DCIM/100CANON/.DS_Store', 'finder');
  await put('Trip/IMG_5.jpg', await photo({ r: 0, g: 0, b: 90 }, '2019:08:02 18:00:00'));
  await put('Trip/IMG_5.MOV', 'the clip of a live photo');
  await put('Camera/.stfolder/.keep', '');
  await put('Camera/PXL_1.jpg', await photo({ r: 1, g: 2, b: 3 }, '2024:01:01 10:00:00'));
  await put('Photos Library.photoslibrary/originals/A/IMG_x.jpg', await photo({ r: 3, g: 2, b: 1 }));
  await put('Kept/IMG_k.jpg', await photo({ r: 7, g: 7, b: 7 }, '2010:01:01 10:00:00'));
  await put('2016/01/old.jpg', await photo({ r: 5, g: 5, b: 5 }, '2016:01:05 10:00:00'));
  const dataDir = path.join(tmp, 'data');
  initArchive(root, { dataDir });
  return { tmp, root, put, dataDir, boat };
}

test('folder names make albums, but DCIM, camera folders and Takeout folders do not', () => {
  assert.equal(folderAlbum('BVI 2017'), 'BVI 2017');
  assert.equal(folderAlbum('BVI 2017/GoPro'), 'BVI 2017 / GoPro');
  assert.equal(folderAlbum('Canon/DCIM/100CANON'), 'Canon');
  assert.equal(folderAlbum('Google/Takeout/Google Photos/Photos from 2019'), 'Google');
  assert.equal(folderAlbum('WhatsApp Images/Sent'), 'WhatsApp Images');
  assert.equal(folderAlbum(''), null);
});

test('a dry run plans the sort and changes nothing', async (t) => {
  const { root } = await setup(t);
  const before = await listing(root);
  const plan = await sortArchive(root, { dryRun: true, keep: ['Kept'] });
  assert.deepEqual(await listing(root), before);

  const moves = Object.fromEntries(plan.moves.map((m) => [m.item.rel, m.to]));
  assert.deepEqual(moves, {
    '20140419_184522.jpg': '2014/04/20140419_184522.jpg',
    'BVI 2017/GoPro/GOPR1.jpg': '2017/03/GOPR1.jpg',
    'BVI 2017/IMG_1.jpg': '2017/03/IMG_1.jpg',
    'Canon/DCIM/100CANON/IMG_9.jpg': '2012/07/IMG_9.jpg',
    'Trip/IMG_1.jpg': '2017/03/IMG_1 (2).jpg',
    'Trip/IMG_5.jpg': '2019/08/IMG_5.jpg',
    'Trip/IMG_5.MOV': '2019/08/IMG_5.MOV',
  });
  assert.deepEqual(plan.duplicates.map((d) => [d.item.rel, d.to, d.sameAs]), [['Google/IMG_1.jpg', '.photobox/superseded/Google/IMG_1.jpg', '2017/03/IMG_1.jpg']]);
  assert.deepEqual(plan.moves.find((m) => m.to === '2017/03/IMG_1.jpg').item.albums, ['BVI 2017', 'Google']);
  assert.equal(plan.moves.find((m) => m.to === '2014/04/20140419_184522.jpg').item.meta.dateSource, 'filename');
  assert.deepEqual(plan.leftAlone.map((l) => [l.rel, l.reason]).sort(), [
    ['Camera', 'a sync folder (Syncthing)'],
    ['Kept', 'kept in place'],
    ['Photos Library.photoslibrary', 'an app library or system folder'],
  ]);
  assert.deepEqual([...plan.others], [['BVI 2017', 1]]);
  await assert.rejects(fs.access(path.join(root, '.photobox', 'settings.json')), 'a dry run remembers nothing');
});

test('sort moves files into YYYY/MM, records every move, and undo puts everything back', async (t) => {
  const { root } = await setup(t);
  const before = await listing(root);
  const result = await sortArchive(root, { keep: [path.join(root, 'Kept')] });
  assert.equal(result.sorted, 7);
  assert.equal(result.setAside, 1);
  assert.deepEqual(result.problems, []);

  assert.deepEqual((await listing(root)).filter((f) => !f.startsWith('.photobox/') && f !== MANIFEST), [
    '2012/07/IMG_9.jpg', '2014/04/20140419_184522.jpg', '2016/01/old.jpg',
    '2017/03/GOPR1.jpg', '2017/03/IMG_1 (2).jpg', '2017/03/IMG_1.jpg', '2019/08/IMG_5.MOV', '2019/08/IMG_5.jpg',
    'BVI 2017/notes.txt', 'Camera/.stfolder/.keep', 'Camera/PXL_1.jpg', 'Kept/IMG_k.jpg',
    'Photos Library.photoslibrary/originals/A/IMG_x.jpg',
  ]);
  await assert.rejects(fs.access(path.join(root, 'Canon')), 'emptied folders are removed');
  await fs.access(path.join(root, '.photobox', 'superseded', 'Google', 'IMG_1.jpg'));

  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  const entry = manifest.items['2017/03/IMG_1.jpg'];
  assert.deepEqual(entry.albums, ['BVI 2017', 'Google']);
  assert.equal(entry.sortedFrom, 'BVI 2017/IMG_1.jpg');
  assert.equal(entry.localTime, '2017-03-10 12:00:00');
  assert.equal(manifest.items['2019/08/IMG_5.MOV'].liveOf, '2019/08/IMG_5.jpg');
  assert.deepEqual(manifest.albums['BVI 2017 / GoPro'], ['2017/03/GOPR1.jpg']);
  assert.equal(manifest.superseded['.photobox/superseded/Google/IMG_1.jpg'].duplicateOf, '2017/03/IMG_1.jpg');
  const settings = JSON.parse(await fs.readFile(path.join(root, '.photobox', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.keepInPlace, ['Kept']);

  const history = (await fs.readFile(path.join(root, '.photobox', 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(history.map((e) => e.event), ['sort-started', ...Array(7).fill('file-sorted'), 'file-superseded', ...Array(6).fill('folder-removed'), 'sort-finished']);
  assert.deepEqual(history.filter((e) => e.event === 'folder-removed').map((e) => e.path).sort(),
    ['BVI 2017/GoPro', 'Canon', 'Canon/DCIM', 'Canon/DCIM/100CANON', 'Google', 'Trip']);

  const undo = await undoSort(root);
  assert.deepEqual(undo.problems, []);
  assert.equal(undo.restored, 8);
  const after = await listing(root);
  assert.deepEqual(after.filter((f) => !f.startsWith('.photobox/') && f !== MANIFEST),
    before.filter((f) => !f.startsWith('.photobox/') && !f.endsWith('.DS_Store')));
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8')).items), []);
  await assert.rejects(undoSort(root), /no sort to undo/);
});

test('undo leaves a file that changed since, and finishes once it is fixed', async (t) => {
  const { root } = await setup(t);
  await sortArchive(root, {});
  const sorted = path.join(root, '2017', '03', 'GOPR1.jpg');
  const original = await fs.readFile(sorted);
  await fs.writeFile(sorted, 'edited');

  const first = await undoSort(root);
  assert.deepEqual(first.problems, [{ rel: '2017/03/GOPR1.jpg', reason: 'changed since it was sorted' }]);
  assert.equal(first.restored, 8);
  await fs.access(path.join(root, 'BVI 2017', 'IMG_1.jpg'));

  await fs.writeFile(sorted, original);
  const second = await undoSort(root);
  assert.deepEqual(second.problems, []);
  assert.equal(second.restored, 1);
  await fs.access(path.join(root, 'BVI 2017', 'GoPro', 'GOPR1.jpg'));
});

test('a later sort sets new copies of sorted files aside, and adds their albums', async (t) => {
  const { root, put, boat } = await setup(t);
  await sortArchive(root, {});
  await put('Boat trip/IMG_1 copy.jpg', boat);
  const again = await sortArchive(root, {});
  assert.equal(again.sorted, 0);
  assert.deepEqual(again.duplicates.map((d) => [d.item.rel, d.sameAs]), [['Boat trip/IMG_1 copy.jpg', '2017/03/IMG_1.jpg']]);
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  assert.deepEqual(manifest.items['2017/03/IMG_1.jpg'].albums, ['BVI 2017', 'Boat trip', 'Google']);
  assert.deepEqual(again.leftAlone.map((l) => l.rel).sort(), ['Camera', 'Photos Library.photoslibrary']);
});

test('an export into a sorted archive finds the photos there and keeps their folder albums', async (t) => {
  const { tmp, root, dataDir, boat } = await setup(t);
  await sortArchive(root, {});
  const takeout = path.join(tmp, 'Takeout');
  await fs.mkdir(takeout);
  await fs.writeFile(path.join(takeout, 'IMG_1.jpg'), boat);
  await fs.writeFile(path.join(takeout, 'new.jpg'), await photo({ r: 250, g: 250, b: 0 }, '2020:05:05 05:05:05'));
  const config = loadConfig({ dataDir });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  await new Indexer(library, config).scanSource(library.addSource(takeout));

  const result = await exportLibrary(library, root);
  assert.equal(result.copied, 1);
  assert.equal(result.present, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  assert.deepEqual(manifest.items['2017/03/IMG_1.jpg'].albums, ['BVI 2017', 'Google']);
  assert.equal(manifest.items['2017/03/IMG_1.jpg'].sortedFrom, 'BVI 2017/IMG_1.jpg');
  assert.ok(manifest.items['2020/05/new.jpg']);
});
