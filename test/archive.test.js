// Archives: `photobox init`, finding the archive like git finds .git, each archive's library kept apart,
// the archive's own photos in it, and `photobox adopt`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ARCHIVE_DIR, findArchive, initArchive, readArchive } from '../src/archive.js';
import { createHash } from 'node:crypto';
import { loadConfig, sourceProblem } from '../src/config.js';
import { Library } from '../src/db.js';
import { openLibrary, scanAll, startPhotobox } from '../src/app.js';
import { writeManifest } from '../src/export.js';
import { MANIFEST, readManifest } from '../src/manifest.js';
import { loadHostSettings } from '../src/host-settings.js';
import { SourceWatcher } from '../src/watcher.js';

const CLI = fileURLToPath(new URL('../bin/photobox.js', import.meta.url));
const jpeg = (r, g, b) => sharp({ create: { width: 16, height: 12, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

async function tmpDir(t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-archive-')));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}

/** Runs the CLI in `cwd` with its own data folder: { code, out }. */
async function photobox(cwd, dataDir, ...args) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, PHOTOBOX_DATA: dataDir } });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    return { code: err.code, out: err.stdout + err.stderr };
  }
}

test('init makes a folder an archive that is found from anywhere inside it', async (t) => {
  const tmp = await tmpDir(t);
  const root = path.join(tmp, 'Pictures');
  await fs.mkdir(path.join(root, 'Trip', 'Day 1'), { recursive: true });
  const archive = initArchive(root, { dataDir: path.join(tmp, 'data') });

  assert.equal(archive.root, root);
  assert.match(archive.id, /^[0-9a-f-]{36}$/);
  const saved = JSON.parse(await fs.readFile(path.join(root, ARCHIVE_DIR, 'archive.json'), 'utf8'));
  assert.deepEqual(saved, { version: 1, id: archive.id, createdAt: archive.createdAt });
  assert.deepEqual(findArchive(path.join(root, 'Trip', 'Day 1')), archive);
  assert.deepEqual(findArchive(root), archive);
  assert.equal(findArchive(tmp), null);
  assert.equal(readArchive(path.join(root, 'Trip')), null);
});

test('init keeps what an export already put in .photobox', async (t) => {
  const tmp = await tmpDir(t);
  const root = path.join(tmp, 'Photos');
  await fs.mkdir(path.join(root, ARCHIVE_DIR, 'superseded', '2024', '03'), { recursive: true });
  await fs.writeFile(path.join(root, ARCHIVE_DIR, 'superseded', '2024', '03', 'old.jpg'), await jpeg(1, 2, 3));
  assert.ok(initArchive(root, { dataDir: path.join(tmp, 'data') }));
  assert.ok((await fs.stat(path.join(root, ARCHIVE_DIR, 'superseded', '2024', '03', 'old.jpg'))).isFile());
});

test('init refuses folders that are already archives, broad folders and Photobox data', async (t) => {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'Pictures');
  await fs.mkdir(path.join(root, 'Trip'), { recursive: true });
  initArchive(root, { dataDir });

  assert.throws(() => initArchive(root, { dataDir }), /is already an archive/);
  assert.throws(() => initArchive(path.join(root, 'Trip'), { dataDir }), /is inside the archive at/);
  assert.throws(() => initArchive(path.join(tmp, 'missing'), { dataDir }), /Not a folder/);
  assert.throws(() => initArchive(tmp, { dataDir, home: tmp }), /home folder/);
  assert.throws(() => initArchive(path.parse(tmp).root, { dataDir }), /root can't be an archive/);
  await fs.mkdir(path.join(dataDir, 'inside'), { recursive: true });
  assert.throws(() => initArchive(path.join(dataDir, 'inside'), { dataDir }), /Photobox's own data/);
  await fs.mkdir(path.join(tmp, 'outer'));
  assert.throws(() => initArchive(path.join(tmp, 'outer'), { dataDir: path.join(tmp, 'outer', 'data') }), /Photobox's own data/);
});

test('a damaged archive file is an error, not a reason to use another library', async (t) => {
  const tmp = await tmpDir(t);
  await fs.mkdir(path.join(tmp, 'Pictures', ARCHIVE_DIR), { recursive: true });
  await fs.writeFile(path.join(tmp, 'Pictures', ARCHIVE_DIR, 'archive.json'), '{"version": 1');
  assert.throws(() => findArchive(path.join(tmp, 'Pictures')), /Cannot read the archive file/);
  await fs.writeFile(path.join(tmp, 'Pictures', ARCHIVE_DIR, 'archive.json'), '{"version": 2, "id": "x"}');
  assert.throws(() => findArchive(path.join(tmp, 'Pictures')), /Not a Photobox archive file/);
});

test('each archive has its own library in the data folder; without one the library is the data folder', async (t) => {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const [a, b] = ['A', 'B'].map((name) => path.join(tmp, name));
  for (const dir of [a, b]) await fs.mkdir(dir);
  const [first, second] = [initArchive(a, { dataDir }), initArchive(b, { dataDir })];

  const plain = loadConfig({ dataDir });
  assert.equal(plain.dbPath, path.join(dataDir, 'library.db'));
  assert.equal(plain.archive, null);
  const config = loadConfig({ dataDir, archive: first });
  assert.equal(config.libraryDir, path.join(dataDir, 'cache', first.id));
  assert.equal(config.dbPath, path.join(dataDir, 'cache', first.id, 'library.db'));
  assert.equal(config.thumbsDir, path.join(dataDir, 'cache', first.id, 'thumbs'));
  assert.equal(config.uploadsDir, path.join(dataDir, 'uploads'), 'phone uploads stay with the machine');

  const library = new Library(config.dbPath);
  library.addSource(path.join(tmp, 'Takeout'));
  library.close();
  const other = new Library(loadConfig({ dataDir, archive: second }).dbPath);
  t.after(() => other.close());
  assert.deepEqual(other.sources(), []);
});

test('an archive is not a source of itself, and neither is a folder holding it', async (t) => {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'Pictures');
  await fs.mkdir(root);
  const config = loadConfig({ dataDir, archive: initArchive(root, { dataDir }) });

  assert.equal(sourceProblem(root, config), "That's the archive itself");
  assert.equal(sourceProblem(tmp, config), 'That folder holds the archive');
  assert.equal(sourceProblem(dataDir, config), "That's Photobox's own data folder");
  assert.equal(sourceProblem(path.join(root, 'Camera'), config), null);
  assert.equal(sourceProblem(path.join(tmp, 'Takeout'), config), null);
  assert.equal(sourceProblem(tmp, loadConfig({ dataDir })), null);
});

test('the CLI: init, then scan and export inside the archive use its own library', async (t) => {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'Pictures');
  const source = path.join(tmp, 'Takeout');
  await fs.mkdir(path.join(root, 'Trip'), { recursive: true });
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'IMG_1.jpg'), await jpeg(200, 0, 0));
  await fs.writeFile(path.join(source, 'IMG_2.jpg'), await jpeg(0, 200, 0));

  const init = await photobox(tmp, dataDir, 'init', root);
  assert.equal(init.code, 0, init.out);
  assert.match(init.out, /is now a Photobox archive/);
  const { id } = readArchive(root);
  assert.equal((await photobox(tmp, dataDir, 'init', root)).code, 1);

  const empty = await photobox(path.join(root, 'Trip'), dataDir, 'scan');
  assert.equal(empty.code, 1);
  assert.match(empty.out, /This archive has no sources yet/);
  const itself = await photobox(root, dataDir, 'scan', root);
  assert.equal(itself.code, 1);
  assert.match(itself.out, /That's the archive itself/);

  const scan = await photobox(path.join(root, 'Trip'), dataDir, 'scan', source);
  assert.equal(scan.code, 0, scan.out);
  assert.match(scan.out, /2 media files, 2 new/);
  const exported = await photobox(root, dataDir, 'export');
  assert.equal(exported.code, 0, exported.out);
  assert.match(exported.out, new RegExp(`Exported to ${root}: 2 copied`));
  const years = (await fs.readdir(root)).filter((name) => /^\d{4}$/.test(name));
  assert.equal(years.length, 1);

  await fs.access(path.join(dataDir, 'cache', id, 'library.db'));
  await assert.rejects(fs.access(path.join(dataDir, 'library.db')), 'the home library is untouched');
  const outside = await photobox(tmp, dataDir, 'export', '--archive', path.join(root, 'Trip'), '--dry-run');
  assert.equal(outside.code, 0, outside.out);
  assert.match(outside.out, /Would copy 0 of 2 items/);
  const notArchive = await photobox(tmp, dataDir, 'scan', '--archive', source);
  assert.equal(notArchive.code, 1);
  assert.match(notArchive.out, /Not in an archive/);

  await fs.writeFile(path.join(root, 'Trip', '20190802_180000.jpg'), await jpeg(0, 0, 200));
  const preview = await photobox(root, dataDir, 'sort', '--dry-run');
  assert.equal(preview.code, 0, preview.out);
  assert.match(preview.out, /Would move 1 photo or video into YYYY\/MM/);
  assert.match(preview.out, /1 {2}Trip {2}album "Trip"/);
  assert.match(preview.out, /Nothing was moved/);
  const sorted = await photobox(root, dataDir, 'sort');
  assert.equal(sorted.code, 0, sorted.out);
  await fs.access(path.join(root, '2019', '08', '20190802_180000.jpg'));
  const undone = await photobox(root, dataDir, 'sort', '--undo');
  assert.equal(undone.code, 0, undone.out);
  assert.match(undone.out, /Put back 1 file/);
  await fs.access(path.join(root, 'Trip', '20190802_180000.jpg'));
  assert.match((await photobox(tmp, dataDir, 'sort')).out, /works in an archive/);
});

/**
 * An archive (Pictures) with two sorted photos in its manifest, a phone sync folder and a kept
 * folder that it doesn't list, and a Takeout with one of the two photos in its "Trip" album.
 */
async function archiveWithPhotos(t) {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'Pictures');
  const put = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  const [red, green] = [await jpeg(200, 0, 0), await jpeg(0, 200, 0)];
  await put(path.join(root, '2019/08/IMG_1.jpg'), red);
  await put(path.join(root, '2019/08/IMG_2.jpg'), green);
  await put(path.join(root, 'Camera/PXL_3.jpg'), await jpeg(0, 0, 200));
  await put(path.join(root, 'Backgrounds/wall.jpg'), await jpeg(250, 250, 250));
  await put(path.join(tmp, 'Takeout/Trip/IMG_1.jpg'), red);
  await put(path.join(tmp, 'Takeout/Trip/metadata.json'), JSON.stringify({ title: 'Trip' }));
  const entry = (data, localTime, albums) => ({
    hash: `quick-${localTime}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, kind: 'image',
    takenAt: new Date(`${localTime.replace(' ', 'T')}Z`).toISOString(), localTime, dateSource: 'filename', albums,
  });
  await writeManifest(root, {
    '2019/08/IMG_1.jpg': { ...entry(red, '2019-08-02 18:00:00', ['Trip']), sortedFrom: 'Trip/IMG_1.jpg' },
    '2019/08/IMG_2.jpg': { ...entry(green, '2019-08-03 09:30:00', ['Sailing']), sortedFrom: 'Sailing/IMG_2.jpg' },
  });
  const archive = initArchive(root, { dataDir });
  return { tmp, dataDir, root, archive, takeout: path.join(tmp, 'Takeout'), camera: path.join(root, 'Camera') };
}

test("an archive's library has the photos its manifest lists, as the archive's own, next to its sources", async (t) => {
  const { dataDir, root, archive, takeout, camera } = await archiveWithPhotos(t);
  const { library, indexer } = openLibrary(loadConfig({ dataDir, archive }), [camera, takeout]);
  t.after(() => library.close());
  await scanAll(library, indexer);

  const own = library.sources().find((s) => s.managed === 'archive');
  assert.equal(own.path, root);
  assert.deepEqual(library.filePathsForSource(own.id).sort(), [path.join(root, '2019/08/IMG_1.jpg'), path.join(root, '2019/08/IMG_2.jpg')]);
  const all = library.timeline({}).items.map((i) => library.mediaDetails(i.id));
  assert.deepEqual(all.map((m) => m.filename).sort(), ['IMG_1.jpg', 'IMG_2.jpg', 'PXL_3.jpg'], 'the kept folder is not part of it');
  const byName = (name) => all.find((m) => m.filename === name);
  const fromTakeout = library.sources().find((s) => s.path === takeout).id;
  assert.equal(byName('IMG_1.jpg').files.length, 2, 'the same photo in the archive and a source is one photo');
  assert.deepEqual(byName('IMG_1.jpg').sources, [fromTakeout], 'it came from the source, not from the archive');
  assert.deepEqual(byName('IMG_2.jpg').sources, [own.id]);
  assert.equal(byName('IMG_2.jpg').local_time, '2019-08-03 09:30:00', 'dated as the manifest says');
  assert.deepEqual(byName('IMG_2.jpg').albums, ['Sailing']);
  assert.deepEqual(library.albums().map((a) => [a.name, a.source_id]).sort(), [['Sailing', own.id], ['Trip', own.id], ['Trip', fromTakeout]]);

  // Once the manifest no longer lists a photo, it's no longer the archive's.
  const manifest = await readManifest(root);
  delete manifest.items['2019/08/IMG_2.jpg'];
  await writeManifest(root, manifest.items);
  await indexer.scanSource(own);
  assert.deepEqual(library.timeline({}).items.map((i) => library.media(i.id).filename).sort(), ['IMG_1.jpg', 'PXL_3.jpg']);

  // Without its manifest, the archive looks empty: that's taken as a problem, not as everything gone.
  await fs.rename(path.join(root, MANIFEST), path.join(root, 'moved.json'));
  assert.equal((await indexer.scanSource(own)).offline, true);
  assert.match(indexer.status.errors[0].message, /The archive lists no photos/);
  assert.equal(library.filePathsForSource(own.id).length, 1);
});

test('adopt: an archive takes over the library in the data folder, which stays as it was', async (t) => {
  const { tmp, dataDir, root, archive, takeout } = await archiveWithPhotos(t);
  const home = openLibrary(loadConfig({ dataDir }), [takeout]);
  await scanAll(home.library, home.indexer);
  const [source] = home.library.sources();
  home.library.setSourceName(source.id, 'Google, main account');
  const [photo] = home.library.timeline({}).items;
  home.library.setFavorite(photo.id, true);
  home.library.addDevice('Pixel', 'token-hash');
  const thumbs = await fs.readdir(path.join(dataDir, 'thumbs'), { recursive: true, withFileTypes: true });
  const thumb = path.relative(dataDir, path.join(thumbs.find((e) => e.isFile()).parentPath, thumbs.find((e) => e.isFile()).name));
  home.library.close();

  assert.match((await photobox(tmp, dataDir, 'adopt')).out, /works in an archive/);
  const adopted = await photobox(root, dataDir, 'adopt');
  assert.equal(adopted.code, 0, adopted.out);
  assert.match(adopted.out, /Adopted the library in .*: 1 photo or video, 1 source, 1 paired device/);
  assert.match(adopted.out, new RegExp(`Google, main account: ${takeout}`));

  const config = loadConfig({ dataDir, archive });
  const library = new Library(config.dbPath);
  t.after(() => library.close());
  assert.deepEqual(library.sources().map((s) => [s.name, s.path, s.managed]), [[null, root, 'archive'], ['Google, main account', takeout, null]]);
  assert.equal(library.media(photo.id).favorite, 1);
  assert.deepEqual(library.devices().map((d) => d.name), ['Pixel']);
  await fs.access(path.join(config.libraryDir, thumb)); // thumbnails come along
  const old = new Library(path.join(dataDir, 'library.db'));
  assert.deepEqual(old.sources().map((s) => s.path), [takeout], 'the old library is as it was');
  old.close();

  const again = await photobox(root, dataDir, 'adopt');
  assert.equal(again.code, 1);
  assert.match(again.out, /has 1 source and 1 paired device of its own/);
});

test("a host on an archive shows the archive's file as the library copy, and the desktop app opens that archive next", async (t) => {
  const { dataDir, root, archive, takeout } = await archiveWithPhotos(t);
  const app = await startPhotobox({ dataDir, archive, port: 0, folders: [takeout] });
  t.after(() => app.close());
  await app.indexer.queue;
  assert.equal(loadHostSettings(dataDir).archive, root);
  const get = async (url) => (await fetch(`${app.url}${url}`)).json();
  const { items } = await get('/api/timeline');
  const details = await Promise.all(items.map((i) => get(`/api/media/${i.id}`)));
  const red = details.find((d) => d.filename === 'IMG_1.jpg');
  assert.equal(red.copy, path.join(root, '2019/08/IMG_1.jpg'));
  const own = (await get('/api/status')).sources.find((s) => s.managed === 'archive');
  const removed = await fetch(`${app.url}/api/sources/${own.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(removed.status, 409);
  await app.close();

  const plain = await startPhotobox({ dataDir, port: 0 });
  await plain.close();
  assert.equal(loadHostSettings(dataDir).archive, null, 'started outside an archive, the host serves the data folder\'s library');
});

test("a new manifest has the archive's photos looked at again; nothing else in the archive does", async (t) => {
  const { dataDir, root, archive } = await archiveWithPhotos(t);
  const { library } = openLibrary(loadConfig({ dataDir, archive }));
  t.after(() => library.close());
  const scans = [];
  const indexer = { scanSource: async (source) => scans.push(source.managed), scanFolders: async () => scans.push('folders'), error: () => {} };
  const watcher = new SourceWatcher(library, indexer);
  t.after(() => watcher.close());
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.writeFile(path.join(root, 'Backgrounds/new.jpg'), await jpeg(1, 1, 1));
  const manifest = await readManifest(root);
  await writeManifest(root, manifest.items);
  for (let waited = 0; !scans.length && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(scans, ['archive']);
});

test("a photo a source dated keeps that date and name when the archive lists it; an export's numbered edited copy is still the edited copy", async (t) => {
  const tmp = await tmpDir(t);
  const dataDir = path.join(tmp, 'data');
  const root = path.join(tmp, 'Pictures');
  const takeout = path.join(tmp, 'Takeout');
  const put = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  const [w, h] = [160, 120];
  const gradient = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gradient.set([40 + x, 90 + y, 200], (y * w + x) * 3);
  const edited = (quality) => sharp(gradient, { raw: { width: w, height: h, channels: 3 } })
    .withExif({ IFD0: { Make: 'Google', Model: 'Pixel 5' }, IFD2: { DateTimeOriginal: '2024:03:19 12:21:29', SubSecTimeOriginal: '737' } })
    .jpeg({ quality }).toBuffer();
  const [red, better, worse] = [await jpeg(200, 0, 0), await edited(95), await edited(40)];
  await put(path.join(takeout, 'IMG_1.jpg'), red);
  await put(path.join(takeout, 'IMG_1.jpg.json'), JSON.stringify({ title: 'IMG_1.jpg', photoTakenTime: { timestamp: '1564766400' } }));
  await put(path.join(takeout, 'PXL_20240319_112129737~2.jpg'), worse);
  await put(path.join(root, '2019/08/Old name.jpg'), red);
  await put(path.join(root, '2024/03/PXL_20240319_112129737~2 (2).jpg'), better);
  const entry = (data, localTime, extra) => ({
    hash: `quick-${localTime}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, kind: 'image',
    takenAt: new Date(`${localTime.replace(' ', 'T')}Z`).toISOString(), localTime, dateSource: 'filename', ...extra,
  });
  await writeManifest(root, {
    '2019/08/Old name.jpg': entry(red, '2019-08-02 18:00:00', { sortedFrom: 'Old name.jpg' }),
    '2024/03/PXL_20240319_112129737~2 (2).jpg': entry(better, '2024-03-19 12:21:29', { dateSource: 'exif', originalName: 'PXL_20240319_112129737~2.jpg' }),
  });
  const { library, indexer } = openLibrary(loadConfig({ dataDir, archive: initArchive(root, { dataDir }) }), [takeout]);
  t.after(() => library.close());
  const [own, source] = ['archive', null].map((managed) => library.sources().find((s) => s.managed === managed));
  await indexer.scanSource(source);
  await indexer.scanSource(own);

  const media = (file) => library.media(library.fileByPath(file).media_id);
  const photo = media(path.join(root, '2019/08/Old name.jpg'));
  assert.deepEqual([photo.filename, photo.taken_at, photo.date_source], ['IMG_1.jpg', 1564766400000, 'takeout']);
  const copy = media(path.join(root, '2024/03/PXL_20240319_112129737~2 (2).jpg'));
  assert.match(copy.shot_key, /\|edited$/);
  assert.equal(media(path.join(takeout, 'PXL_20240319_112129737~2.jpg')).superseded_by, copy.id, 'the better version is shown');
});

test("an archive's manifest doesn't date a photo whose original Photobox reads, in whichever order the folders are scanned", async (t) => {
  for (const order of [['archive', 'takeout'], ['takeout', 'archive']]) {
    const tmp = await tmpDir(t);
    const root = path.join(tmp, 'Pictures');
    const takeout = path.join(tmp, 'Takeout');
    const put = async (file, data) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    };
    // A WhatsApp image a computer uploaded on 2024-12-28; an older export took that for when it was taken.
    const name = 'WhatsApp Image 2024-11-20 at 21.16.25.jpeg';
    const red = await jpeg(200, 0, 0);
    await put(path.join(takeout, name), red);
    await put(path.join(takeout, `${name}.supplemental-metadata.json`), JSON.stringify({
      title: name, photoTakenTime: { timestamp: '1735398014' }, googlePhotosOrigin: { webUpload: { computerUpload: {} } },
    }));
    await put(path.join(root, '2024/12', name), red);
    await writeManifest(root, { [`2024/12/${name}`]: {
      hash: 'quick-1', sha256: createHash('sha256').update(red).digest('hex'), bytes: red.length, kind: 'image',
      takenAt: new Date(1735398014000).toISOString(), localTime: '2024-12-28 16:00:14', dateSource: 'takeout',
    } });
    const { library, indexer } = openLibrary(loadConfig({ dataDir: path.join(tmp, 'data'), archive: initArchive(root, { dataDir: path.join(tmp, 'data') }) }), [takeout]);
    const sources = { archive: library.sources().find((s) => s.managed === 'archive'), takeout: library.sources().find((s) => !s.managed) };
    for (const which of order) await indexer.scanSource(sources[which]);
    const m = library.media(library.fileByPath(path.join(root, '2024/12', name)).media_id);
    library.close();
    assert.deepEqual([m.local_time, m.date_source], ['2024-11-20 21:16:25', 'filename'], `scanned ${order.join(', then ')}`);
  }
});
