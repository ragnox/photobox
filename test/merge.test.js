// `photobox merge`: an export folder comes into an archive once, and can be taken out again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { initArchive } from '../src/archive.js';
import { sortArchive, undoSort } from '../src/sort.js';
import { mergeInto, undoMerge } from '../src/merge.js';
import { MANIFEST } from '../src/manifest.js';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { exportLibrary } from '../src/export.js';

const CLI = fileURLToPath(new URL('../bin/photobox.js', import.meta.url));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const photo = (rgb, when) => sharp({ create: { width: 32, height: 24, channels: 3, background: rgb } })
  .withExif({ IFD0: { Make: 'Google', Model: 'Pixel' }, IFD2: { DateTimeOriginal: when } }).jpeg().toBuffer();
const readJsonFile = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

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

const put = async (root, rel, data) => {
  await fs.mkdir(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
  await fs.writeFile(path.join(root, ...rel.split('/')), data);
};

/** What `photobox export` writes for a file. */
const entry = (data, localTime, extra = {}) => ({
  hash: sha256(data).slice(0, 40), sha256: sha256(data), bytes: data.length, kind: extra.kind ?? 'image',
  takenAt: `${localTime.replace(' ', 'T')}.000Z`, localTime, dateSource: 'exif', ...extra,
});

/**
 * An archive sorted from a trip folder and an older cloud download, and an export folder with:
 * a photo the archive has (other albums, a favorite), a better version of one of the download's
 * photos, a new live photo, a photo whose name is taken in the archive, an empty and a changed file.
 */
async function setup(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-merge-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'Pictures');
  const folder = path.join(tmp, 'Photos');
  const boat = await photo({ r: 0, g: 90, b: 200 }, '2017:03:10 12:00:00');
  const older = await photo({ r: 90, g: 90, b: 90 }, '2023:04:27 20:38:44');
  const better = await photo({ r: 91, g: 91, b: 91 }, '2023:04:27 20:38:44');
  const sailing = await photo({ r: 200, g: 100, b: 0 }, '2024:05:01 10:00:00');
  const other = await photo({ r: 1, g: 200, b: 1 }, '2019:08:02 18:00:00');
  await put(root, 'BVI 2017/IMG_1.jpg', boat);
  await put(root, 'Google/PXL_1.jpg', older);
  await put(root, 'Trip/IMG_7.jpg', await photo({ r: 200, g: 1, b: 1 }, '2019:08:02 18:00:00'));
  const dataDir = path.join(tmp, 'data');
  initArchive(root, { dataDir });
  await sortArchive(root, {});

  const clip = Buffer.from('the clip of a live photo');
  const items = {
    '2017/03/IMG_1.jpg': entry(boat, '2017-03-10 12:00:00', { albums: ['Sailing'], favorite: true }),
    '2023/04/PXL_1 (2).jpg': entry(better, '2023-04-27 20:38:44', { originalName: 'PXL_1.jpg' }),
    '2024/05/PXL_9.jpg': entry(sailing, '2024-05-01 10:00:00', { albums: ['Sailing'] }),
    '2024/05/PXL_9.mp4': entry(clip, '2024-05-01 10:00:00', { kind: 'video', liveOf: '2024/05/PXL_9.jpg' }),
    '2019/08/IMG_7.jpg': entry(other, '2019-08-02 18:00:00'),
    '2020/01/empty.jpg': entry(Buffer.alloc(0), '2020-01-01 00:00:00'),
    '2021/02/edited.jpg': entry(Buffer.from('as exported'), '2021-02-02 00:00:00'),
  };
  const files = { '2017/03/IMG_1.jpg': boat, '2023/04/PXL_1 (2).jpg': better, '2024/05/PXL_9.jpg': sailing, '2024/05/PXL_9.mp4': clip,
    '2019/08/IMG_7.jpg': other, '2020/01/empty.jpg': '', '2021/02/edited.jpg': 'edited since' };
  for (const [rel, data] of Object.entries(files)) await put(folder, rel, data);
  await put(folder, '.photobox/superseded/2023/04/PXL_1.jpg', older);
  const superseded = { '.photobox/superseded/2023/04/PXL_1.jpg': { ...entry(older, '2023-04-27 20:38:44'), supersededBy: sha256(better), exportedAs: '2023/04/PXL_1.jpg' } };
  await fs.writeFile(path.join(folder, MANIFEST), JSON.stringify({ version: 1, generator: 'photobox', albums: {}, items, superseded }));
  return { tmp, root, folder, dataDir, better, sailing };
}

const snapshot = async (root) => {
  const { items, superseded } = await readJsonFile(path.join(root, MANIFEST));
  return { files: await listing(root), items, superseded };
};
const withoutHistory = ({ files, ...rest }) => ({ ...rest, files: files.filter((f) => f !== '.photobox/history.jsonl') });

test('a dry run plans the merge and changes neither folder', async (t) => {
  const { root, folder } = await setup(t);
  const [archiveBefore, folderBefore] = [await snapshot(root), await listing(folder)];
  const plan = await mergeInto(root, folder, { dryRun: true });

  assert.deepEqual(plan.add.map((a) => [path.relative(folder, a.from), a.to]), [
    ['2019/08/IMG_7.jpg', '2019/08/IMG_7 (2).jpg'],
    ['2023/04/PXL_1 (2).jpg', '2023/04/PXL_1 (2).jpg'],
    ['2024/05/PXL_9.jpg', '2024/05/PXL_9.jpg'],
    ['2024/05/PXL_9.mp4', '2024/05/PXL_9.mp4'],
  ]);
  assert.deepEqual(plan.merge.map((m) => [m.to, m.changed]), [['2017/03/IMG_1.jpg', true]]);
  assert.deepEqual(plan.retire.map((r) => [r.rel, r.to, r.replacement]), [['2023/04/PXL_1.jpg', '.photobox/superseded/2023/04/PXL_1.jpg', '2023/04/PXL_1 (2).jpg']]);
  assert.deepEqual(plan.left, [{ rel: '2020/01/empty.jpg', reason: 'an empty file', empty: true }, { rel: '2021/02/edited.jpg', reason: 'changed since it was exported' }]);
  assert.equal(plan.link, true);
  assert.equal(plan.copyBytes, 0);
  assert.equal(plan.olderVersions, 1);
  assert.equal(plan.run, null);
  assert.deepEqual(await snapshot(root), archiveBefore);
  assert.deepEqual(await listing(folder), folderBefore);
});

test('merge links in what is new, adds albums to what is here, and moves older versions aside', async (t) => {
  const { root, folder, better } = await setup(t);
  const folderBefore = await listing(folder);
  const folderManifest = await fs.readFile(path.join(folder, MANIFEST), 'utf8');
  const result = await mergeInto(root, folder);
  assert.deepEqual(result.problems, []);
  assert.equal(result.added, 4);
  assert.equal(result.merged, 1);
  assert.equal(result.setAside, 1);

  const [inArchive, inFolder] = await Promise.all([fs.stat(path.join(root, '2024', '05', 'PXL_9.jpg')), fs.stat(path.join(folder, '2024', '05', 'PXL_9.jpg'))]);
  assert.equal(inArchive.ino, inFolder.ino, 'the same file under a second name');
  await assert.rejects(fs.access(path.join(root, '2023', '04', 'PXL_1.jpg')), 'the older version gave way');
  await fs.access(path.join(root, '.photobox', 'superseded', '2023', '04', 'PXL_1.jpg'));

  const { items, superseded } = await readJsonFile(path.join(root, MANIFEST));
  assert.deepEqual(items['2017/03/IMG_1.jpg'].albums, ['BVI 2017', 'Sailing']);
  assert.equal(items['2017/03/IMG_1.jpg'].favorite, true);
  assert.equal(items['2017/03/IMG_1.jpg'].sortedFrom, 'BVI 2017/IMG_1.jpg');
  assert.deepEqual(items['2023/04/PXL_1 (2).jpg'].albums, ['Google'], 'the older version passes on its albums');
  assert.equal(items['2023/04/PXL_1 (2).jpg'].originalName, 'PXL_1.jpg');
  assert.equal(items['2023/04/PXL_1 (2).jpg'].mergedFrom, path.join(folder, '2023', '04', 'PXL_1 (2).jpg'));
  assert.equal(items['2019/08/IMG_7 (2).jpg'].originalName, 'IMG_7.jpg');
  assert.equal(items['2024/05/PXL_9.mp4'].liveOf, '2024/05/PXL_9.jpg');
  assert.equal(items['2023/04/PXL_1.jpg'], undefined);
  const aside = superseded['.photobox/superseded/2023/04/PXL_1.jpg'];
  assert.equal(aside.supersededBy, sha256(better));
  assert.equal(aside.exportedAs, '2023/04/PXL_1.jpg');
  assert.equal(aside.sortedFrom, 'Google/PXL_1.jpg');

  assert.deepEqual(await listing(folder), folderBefore, 'the folder is only read');
  assert.equal(await fs.readFile(path.join(folder, MANIFEST), 'utf8'), folderManifest);
  const history = (await fs.readFile(path.join(root, '.photobox', 'history.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(history.filter((e) => e.run === result.run).map((e) => e.event),
    ['merge-started', ...Array(4).fill('file-added'), 'file-merged', 'file-superseded', 'merge-finished']);

  const again = await mergeInto(root, folder);
  assert.equal(again.added, 0);
  assert.equal(again.merged, 0);
  assert.deepEqual(again.merge.map((m) => m.changed), [false, false, false, false, false]);
});

test('undo takes out what a merge brought in and puts back what it moved aside', async (t) => {
  const { root, folder } = await setup(t);
  const [archiveBefore, folderBefore] = [await snapshot(root), await listing(folder)];
  await mergeInto(root, folder);
  await assert.rejects(undoSort(root), /The last change was a merge .* photobox merge --undo/);

  const undo = await undoMerge(root);
  assert.deepEqual(undo.problems, []);
  assert.equal(undo.restored, 5);
  assert.deepEqual(withoutHistory(await snapshot(root)), withoutHistory(archiveBefore));
  assert.deepEqual(await listing(folder), folderBefore);
  await assert.rejects(undoMerge(root), /There is no merge to undo/);
  assert.equal((await undoSort(root)).problems.length, 0, 'then the sort can be undone');
});

test('undo keeps a file whose original is gone, and finishes once it is back', async (t) => {
  const { root, folder } = await setup(t);
  await mergeInto(root, folder);
  const original = path.join(folder, '2024', '05', 'PXL_9.jpg');
  await fs.rm(original);

  const first = await undoMerge(root);
  assert.equal(first.problems.length, 1);
  assert.equal(first.problems[0].rel, '2024/05/PXL_9.jpg');
  assert.match(first.problems[0].reason, /its original .* is gone, so it stays/);
  await fs.access(path.join(root, '2024', '05', 'PXL_9.jpg'));
  assert.ok((await readJsonFile(path.join(root, MANIFEST))).items['2024/05/PXL_9.jpg']);

  await fs.link(path.join(root, '2024', '05', 'PXL_9.jpg'), original);
  const second = await undoMerge(root);
  assert.deepEqual(second.problems, []);
  assert.equal(second.restored, 1);
  await assert.rejects(fs.access(path.join(root, '2024', '05', 'PXL_9.jpg')));
});

test('without linking, files are copied and verified, and undo takes the copies out', async (t) => {
  const { root, folder, sailing } = await setup(t);
  const result = await mergeInto(root, folder, { link: false });
  assert.equal(result.link, false);
  assert.equal(result.copyBytes, result.add.reduce((sum, a) => sum + a.size, 0));
  assert.deepEqual(result.problems, []);
  const [inArchive, inFolder] = await Promise.all([fs.stat(path.join(root, '2024', '05', 'PXL_9.jpg')), fs.stat(path.join(folder, '2024', '05', 'PXL_9.jpg'))]);
  assert.notEqual(inArchive.ino, inFolder.ino);
  assert.deepEqual(await fs.readFile(path.join(root, '2024', '05', 'PXL_9.jpg')), sailing);
  assert.equal((await undoMerge(root)).restored, 5);
  await assert.rejects(fs.access(path.join(root, '2024', '05', 'PXL_9.jpg')));
});

test('merge refuses folders that are no export, inside the archive or holding it', async (t) => {
  const { tmp, root, folder } = await setup(t);
  await fs.rm(path.join(folder, MANIFEST));
  await assert.rejects(mergeInto(root, folder, { dryRun: true }), /is not a Photobox export/);
  await assert.rejects(mergeInto(root, path.join(root, '2017'), { dryRun: true }), /is inside the archive/);
  await assert.rejects(mergeInto(root, tmp, { dryRun: true }), /holds the archive/);
  await assert.rejects(mergeInto(root, root, { dryRun: true }), /the archive itself/);
});

test('an export into the archive afterwards keeps the merged albums and where they came from', async (t) => {
  const { tmp, root, folder, dataDir, sailing } = await setup(t);
  await mergeInto(root, folder);
  const phone = path.join(tmp, 'Phone');
  await put(phone, 'PXL_9.jpg', sailing);
  const config = loadConfig({ dataDir });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  await new Indexer(library, config).scanSource(library.addSource(phone));

  const result = await exportLibrary(library, root);
  assert.equal(result.present, 1);
  assert.equal(result.copied, 0);
  const { items } = await readJsonFile(path.join(root, MANIFEST));
  assert.deepEqual(items['2024/05/PXL_9.jpg'].albums, ['Sailing']);
  assert.equal(items['2024/05/PXL_9.jpg'].mergedFrom, path.join(folder, '2024', '05', 'PXL_9.jpg'));
});

test('the CLI: merge --dry-run, merge and merge --undo', async (t) => {
  const { root, folder, dataDir } = await setup(t);
  const photobox = async (...args) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, PHOTOBOX_DATA: dataDir } });
      return { code: 0, out: stdout + stderr };
    } catch (err) {
      return { code: err.code, out: err.stdout + err.stderr };
    }
  };
  const preview = await photobox('merge', folder, '--dry-run');
  assert.match(preview.out, /4 files not here yet \(0\.0 GB\) would be linked in: the same files under a second name, no extra space/);
  assert.match(preview.out, /1 photo or video here already, 1 of them would get albums, favorites or places from it/);
  assert.match(preview.out, /1 older version here \(0\.0 GB\) would move to \.photobox\/superseded\/: it has better ones/);
  assert.match(preview.out, /! 2021\/02\/edited\.jpg: changed since it was exported/);
  assert.match(preview.out, /Nothing was changed/);

  const merged = await photobox('merge', folder);
  assert.equal(merged.code, 1, 'two files stayed out');
  assert.match(merged.out, /Brought in 4 files, updated 1 entry, moved 1 older version aside/);
  const undone = await photobox('merge', '--undo');
  assert.equal(undone.code, 0, undone.out);
  assert.match(undone.out, /Put back 5 files as they were before merge-/);
  assert.equal((await photobox('merge')).code, 1, 'merge needs a folder');
});
