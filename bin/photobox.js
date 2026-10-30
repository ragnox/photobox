#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig, defaultDataDir } from '../src/config.js';
import { ARCHIVE_DIR, findArchive, initArchive } from '../src/archive.js';
import { sortArchive, undoSort } from '../src/sort.js';
import { mergeInto, undoMerge } from '../src/merge.js';
import { adoptLibrary } from '../src/adopt.js';
import { Library } from '../src/db.js';
import { startPhotobox, openLibrary, scanAll, runningInstance, AlreadyRunning } from '../src/app.js';
import { exportLibrary } from '../src/export.js';
import { MANIFEST } from '../src/manifest.js';

const USAGE = `photobox - your photos, on your disk

  photobox init <folder>
      Make <folder> an archive, e.g. ~/Pictures: Photobox keeps its history and
      settings in <folder>/${ARCHIVE_DIR}, and its own library for it. Inside an archive
      (or with --archive), serve, scan and export use that archive's library.

  photobox sort [--dry-run] [--keep <folder>]...
      In an archive: move the photos and videos already in it into YYYY/MM/, by
      when they were taken. Folder names become albums, exact duplicates go to
      ${ARCHIVE_DIR}/superseded, and every move is logged. Sync folders and app
      libraries stay where they are; --keep leaves a folder in place, also later.
  photobox sort --undo
      Put back everything the last sort moved.

  photobox merge <folder> [--dry-run]
      In an archive: bring in what photobox export put into <folder>, e.g. a library
      exported before the archive existed. Photos already here get its albums and
      favorites; the others come in under YYYY/MM, as hard links on the same disk
      (the same file under a second name: no extra space). Older versions here that
      <folder> has better ones of go to ${ARCHIVE_DIR}/superseded. <folder> is only read.
  photobox merge --undo
      Take out again what the last merge brought in.

  photobox adopt
      In an archive: take over the library in Photobox's data folder (from before
      archives) as this archive's library. Its sources and their names, favorites,
      versions, paired phones and thumbnails come along, so nothing is indexed or
      paired again; the old library stays as it was. The next scan adds the
      archive's own photos.

  photobox serve [folders...] [--port 4567] [--open] [--listen <address>]
      Start the app. Folders given here are added to the library and watched.
      Point it at an extracted Google Takeout or any folder of photos.
      In an archive, the app shows the archive's photos along with its sources',
      and the desktop app opens that archive from then on.
      With --listen, phones can pair and browse the library over HTTPS on
      <address> (0.0.0.0 for every network, or e.g. a WireGuard address).

  photobox scan [folders...]
      Index once without starting the server, then print a summary.
      Without folders it rescans every folder the library already has.

  photobox export <dest> [folders...] [--dry-run]
      Copy every photo and video into <dest>/YYYY/MM/, once each, dated by when it
      was taken, with albums and other details in <dest>/${MANIFEST}.
      Rescans the library first; run it again to copy only what's new.
      In an archive, <dest> can be left out: the export goes into the archive.

Options:
  --archive <dir>
                 Use the archive at <dir> instead of the one the current folder is in
  --data <dir>   Database, thumbnails + phone originals (default ~/.photobox, or $PHOTOBOX_DATA)
  --port <n>     HTTP port (default 4567)
  --open         Open the browser once the server is up
  --listen <a>   Also serve paired devices on address <a>, over HTTPS on port + 1
  --remote-port <n>
                  Port for --listen instead of port + 1
  --backup-dir <dir>
                  Automatically export phone originals into an existing folder
  --tls-cert <file> --tls-key <file>
                 Your own certificate for --listen (e.g. from tailscale cert)
  --dry-run      export, sort, merge: show what would be done, change nothing
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    archive: { type: 'string' },
    data: { type: 'string' },
    port: { type: 'string' },
    open: { type: 'boolean', default: false },
    listen: { type: 'string' },
    'remote-port': { type: 'string' },
    'backup-dir': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    keep: { type: 'string', multiple: true, default: [] },
    undo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `fn`, but at most once a second. */
function throttle(fn) {
  let last = 0;
  return (...args) => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    fn(...args);
  };
}

const [command = 'serve', ...args] = positionals;
if (opts.help || !['init', 'sort', 'merge', 'adopt', 'serve', 'scan', 'export'].includes(command) || (command === 'init' && args.length !== 1) ||
    ((command === 'sort' || command === 'adopt') && args.length) || (command === 'merge' && args.length !== (opts.undo ? 0 : 1))) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}
const dataDir = opts.data ? path.resolve(opts.data) : defaultDataDir();
if (command === 'init') init(args[0]);

// The archive to work in, found the way git finds a repository: --archive, or the current folder.
let archive;
try {
  const start = opts.archive ? path.resolve(opts.archive) : process.cwd();
  if (!fs.statSync(start, { throwIfNoEntry: false })?.isDirectory()) fail(`Not a folder: ${start}`);
  archive = findArchive(start);
  if (opts.archive && !archive) fail(`Not in an archive: ${start} - make one with photobox init`);
} catch (err) {
  fail(err.message);
}
const dest = command === 'export' ? (args.length ? path.resolve(args.shift()) : archive?.root) : null;
if (command === 'export' && !dest) {
  console.log(USAGE);
  process.exit(1);
}
if (Boolean(opts['tls-cert']) !== Boolean(opts['tls-key'])) fail('--tls-cert and --tls-key go together');

const folders = args.map((f) => path.resolve(f));
for (const dir of folders) if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`Not a folder: ${dir}`);

function init(folder) {
  try {
    const created = initArchive(folder, { dataDir });
    const { libraryDir } = loadConfig({ dataDir, archive: created });
    console.log(`✓ ${created.root} is now a Photobox archive`);
    console.log(`  Its history and settings go in ${path.join(created.root, ARCHIVE_DIR)}, its library in ${libraryDir}.`);
    console.log('  Run photobox in it, or pass --archive: photobox export then copies into it.');
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
}

const openBrowser = (url) => opts.open && process.platform === 'darwin' && execFile('open', [url]);
const printScan = (source, { files, added, offline }) => {
  console.log(offline ? `! ${source.path}: not available, skipped` : `✓ ${source.path}: ${files} media files, ${added} new`);
};

function logProgress(indexer) {
  const log = throttle((s) => console.log(`  ${s.phase} ${s.source}: ${s.done}/${s.total} (${s.added} new)`));
  indexer.on('status', (s) => s.phase === 'indexing' && log(s));
}

async function runExport(library) {
  const dryRun = opts['dry-run'];
  const onProgress = throttle(({ phase, done, total }) => console.log(`  ${phase} ${done}/${total}`));
  const result = await exportLibrary(library, dest, { dryRun, onProgress });
  if (dryRun) {
    console.log(`Would copy ${result.planned.length} of ${result.total} items to ${dest} (${result.present} already there)`);
    for (const p of result.planned.slice(0, 20)) console.log(`  ${p.rel}  <-  ${p.source}`);
    if (result.planned.length > 20) console.log(`  … and ${result.planned.length - 20} more`);
    if (result.aside.length) {
      console.log(`${count(result.aside.length, 'older version')} here would move to ${ARCHIVE_DIR}/superseded: better versions of them are here`);
      for (const rel of result.aside.slice(0, 10)) console.log(`  ${rel}`);
      if (result.aside.length > 10) console.log(`  … and ${result.aside.length - 10} more`);
    }
  } else {
    console.log(`✓ Exported to ${dest}: ${result.copied} copied, ${result.present} already there (${result.total} items)`);
    if (result.superseded) console.log(`  ${result.superseded} older versions replaced by better ones, moved to .photobox/superseded`);
  }
  if (result.skipped.length) console.log(`  ${result.skipped.length} not exported:`);
  for (const s of result.skipped.slice(0, 10)) console.log(`  ! ${s.name}: ${s.reason}`);
  return result.skipped.length ? 1 : 0;
}

/** `scan` and `export`: index the library's folders (unless a running Photobox does that), then export. */
async function scanOrExport() {
  const config = loadConfig({ dataDir, archive });
  const other = runningInstance(config);
  // A running Photobox keeps the library up to date itself; an export can just read it.
  if (other && (command === 'scan' || folders.length)) fail(`Photobox is running at ${other.url} - add folders there, it will index them.`);
  let opened;
  try {
    opened = openLibrary(config, other ? [] : folders);
  } catch (err) {
    fail(err.message);
  }
  const { library, indexer } = opened;
  try {
    if (archive) console.log(`Archive ${archive.root}`);
    if (other) {
      console.log(`Exporting the library of the Photobox running at ${other.url}`);
    } else {
      // An archive's library always has the archive's own photos; other sources are named by the user.
      const named = library.sources().filter((s) => s.managed !== 'archive');
      if (!archive && !named.length) {
        console.log(USAGE);
        return 1;
      }
      logProgress(indexer);
      await scanAll(library, indexer, printScan);
      const stats = library.stats();
      console.log(`Library: ${stats.photos} photos, ${stats.videos} videos, ${stats.live} live photo clips, ${library.albums().length} albums`);
      for (const e of indexer.status.errors.slice(0, 10)) console.log(`  ! ${e.file}: ${e.message}`);
      if (archive && !named.length) {
        console.log('This archive has no sources yet - name the folders its photos come from: photobox scan <folders...>');
        if (!stats.photos && !stats.videos) return 1;
      }
    }
    return command === 'export' ? await runExport(library) : 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    library.close();
  }
}

async function serve() {
  let photobox;
  try {
    photobox = await startPhotobox({
      dataDir, archive, port: opts.port, folders, onScanned: printScan,
      listen: opts.listen, remotePort: opts['remote-port'], tlsCert: opts['tls-cert'], tlsKey: opts['tls-key'],
      backupDir: opts['backup-dir'],
    });
  } catch (err) {
    if (err instanceof AlreadyRunning) {
      console.log(`${err.message}${folders.length ? ' - add the folders there.' : ''}`);
      openBrowser(err.url);
      process.exit(0);
    }
    fail(err.code === 'EADDRINUSE' ? `Port ${err.port} is busy - try ${opts.listen ? '--port or --remote-port' : '--port'}` : err.message);
  }
  console.log(`Photobox running at ${photobox.url}  (${archive ? `archive: ${archive.root}` : `library: ${photobox.config.dataDir}`})`);
  if (photobox.network) {
    console.log(`Paired devices can connect at ${photobox.network.urls.join(', ') || '(no network address found)'}`);
    console.log('  To pair a phone, open Photobox on this computer and choose "Connect a phone".');
    if (photobox.network.fingerprint) console.log(`  Certificate authority fingerprint: ${photobox.network.fingerprint}`);
  }
  logProgress(photobox.indexer);
  openBrowser(photobox.url);

  const shutdown = async () => {
    await photobox.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const DATED_BY = { exif: 'the camera (EXIF)', takeout: 'a Google sidecar', capture: 'the phone', filename: 'the file name', upload: 'the upload', file: 'the file date only' };

function describeSort(result, dryRun) {
  const folders = new Map();
  const folder = (rel) => {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
    if (!folders.has(top)) folders.set(top, { moves: 0, duplicates: 0, albums: new Set() });
    return folders.get(top);
  };
  const dates = {};
  for (const { item } of result.moves) {
    const f = folder(item.rel);
    f.moves++;
    for (const album of item.albums) f.albums.add(album);
    dates[item.meta.dateSource] = (dates[item.meta.dateSource] ?? 0) + 1;
  }
  for (const { item } of result.duplicates) folder(item.rel).duplicates++;
  const bytes = result.moves.reduce((sum, { item }) => sum + item.size, 0);
  const asideBytes = result.duplicates.reduce((sum, { item }) => sum + item.size, 0);

  console.log(`${dryRun ? 'Would move' : 'Moving'} ${count(result.moves.length, 'photo or video', 'photos and videos')} into YYYY/MM (${gigabytes(bytes)}, moved, not copied):`);
  for (const [top, f] of [...folders].sort((a, b) => b[1].moves + b[1].duplicates - a[1].moves - a[1].duplicates)) {
    const albums = [...f.albums];
    const named = albums.length ? `  album${albums.length === 1 ? '' : 's'} ${albums.slice(0, 3).map((a) => `"${a}"`).join(', ')}${albums.length > 3 ? ` and ${albums.length - 3} more` : ''}` : '';
    console.log(`  ${String(f.moves).padStart(6)}  ${top || '(loose files at the top)'}${f.duplicates ? `, ${count(f.duplicates, 'duplicate')}` : ''}${named}`);
  }
  if (result.duplicates.length) console.log(`${count(result.duplicates.length, 'exact duplicate')} (${gigabytes(asideBytes)}) ${dryRun ? 'would move' : 'moved'} to ${ARCHIVE_DIR}/superseded/, under their old paths.`);
  const dated = Object.entries(DATED_BY).filter(([key]) => dates[key]).map(([key, label]) => `${label} ${dates[key].toLocaleString('en')}`);
  if (dated.length) console.log(`Dated by ${dated.join(' · ')}`);
  if (result.leftAlone.length || result.trashed.length || result.others.size) console.log('Staying where they are:');
  for (const { rel, reason } of result.leftAlone) console.log(`  ${rel}: ${reason}`);
  if (result.trashed.length) console.log(`  ${count(result.trashed.length, 'file')} a Google export marks as deleted`);
  const others = [...result.others].sort((a, b) => b[1] - a[1]);
  if (others.length) {
    const total = others.reduce((sum, [, n]) => sum + n, 0);
    console.log(`  ${count(total, 'other file')} (not photos or videos), most in ${others.slice(0, 4).map(([top, n]) => `${top || 'the top folder'} (${n})`).join(', ')}`);
  }
  for (const { rel, reason } of [...result.failed, ...result.problems].slice(0, 20)) console.log(`  ! ${rel}: ${reason}`);
}

function describeMerge(result, dryRun) {
  const brought = result.add.filter((a) => !a.present);
  const bytes = brought.reduce((sum, a) => sum + a.size, 0);
  const years = {};
  for (const a of result.add) years[a.to.slice(0, 4)] = (years[a.to.slice(0, 4)] ?? 0) + 1;
  const albums = new Map();
  for (const { entry, albums: theirs = entry.albums ?? [] } of [...result.add, ...result.merge]) {
    for (const album of theirs) albums.set(album, (albums.get(album) ?? 0) + 1);
  }
  const how = result.link ? 'linked in: the same files under a second name, no extra space' : `copied in (${gigabytes(result.copyBytes)})`;

  console.log(`Merging ${result.folder} (${count(result.total, 'photo or video', 'photos and videos')}):`);
  console.log(`  ${count(result.add.length, 'file')} not here yet (${gigabytes(bytes)}) ${dryRun ? 'would be' : 'were'} ${how}`);
  const byYear = Object.entries(years).sort((a, b) => b[0].localeCompare(a[0])).map(([year, n]) => `${year} ${n.toLocaleString('en')}`);
  if (byYear.length) console.log(`    by year: ${byYear.join(' · ')}`);
  const updated = result.merge.filter((m) => m.changed).length;
  console.log(`  ${count(result.merge.length, 'photo or video', 'photos and videos')} here already${updated ? `, ${count(updated, 'of them', 'of them')} ${dryRun ? 'would get' : 'got'} albums, favorites or places from it` : ''}`);
  if (result.retire.length) {
    const asideBytes = result.retire.reduce((sum, r) => sum + r.size, 0);
    console.log(`  ${count(result.retire.length, 'older version')} here (${gigabytes(asideBytes)}) ${dryRun ? 'would move' : 'moved'} to ${ARCHIVE_DIR}/superseded/: it has better ones`);
  }
  if (albums.size) {
    const top = [...albums].sort((a, b) => b[1] - a[1]);
    console.log(`  Albums: ${top.slice(0, 8).map(([name, n]) => `"${name}" (${n})`).join(', ')}${top.length > 8 ? ` and ${top.length - 8} more` : ''}`);
  }
  if (result.olderVersions) console.log(`  Its own ${count(result.olderVersions, 'older version')} (in ${ARCHIVE_DIR}/superseded) stay out.`);
  for (const { rel, reason } of [...result.left, ...result.problems].slice(0, 20)) console.log(`  ! ${rel}: ${reason}`);
}

/** `sort --undo`, `merge --undo`: undo the last sort or merge. */
async function undo(undoLast, onProgress) {
  const result = await undoLast(archive.root, { onProgress });
  console.log(`${result.problems.length ? '!' : '✓'} Put back ${count(result.restored, 'file')} as they were before ${result.run}`);
  for (const { rel, reason } of result.problems.slice(0, 20)) console.log(`  ! ${rel}: ${reason}`);
  if (result.problems.length) console.log(`${count(result.problems.length, 'file')} stayed. Fix what's listed, then run photobox ${command} --undo again.`);
  return result.problems.length ? 1 : 0;
}

/** `merge`: plan, show and (unless --dry-run) merge an export folder into the archive, or undo the last merge. */
async function merge() {
  if (!archive) fail('photobox merge works in an archive - make one with photobox init <folder>');
  console.log(`Archive ${archive.root}`);
  const onProgress = throttle(({ phase, done, total }) => console.log(`  ${phase} ${done}/${total}`));
  try {
    if (opts.undo) return await undo(undoMerge, onProgress);
    const dryRun = opts['dry-run'];
    const result = await mergeInto(archive.root, folders[0], { dryRun, onProgress });
    describeMerge(result, dryRun);
    if (dryRun) {
      console.log(`Nothing was changed. photobox merge ${folders[0]} does it.`);
    } else {
      console.log(`✓ Brought in ${count(result.added, 'file')}, updated ${count(result.merged, 'entry', 'entries')}, moved ${count(result.setAside, 'older version')} aside.`);
      console.log(`  Every change is in ${ARCHIVE_DIR}/history.jsonl; photobox merge --undo takes them out again.`);
    }
    // An empty file has nothing to bring in; anything else left out is worth a look.
    return result.problems.length || result.left.some((l) => !l.empty) ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

/** `adopt`: the archive takes over the library in the data folder. */
function adopt() {
  if (!archive) fail('photobox adopt works in an archive - make one with photobox init <folder>');
  const config = loadConfig({ dataDir, archive });
  const other = runningInstance(config);
  if (other) fail(`Photobox is running on this archive at ${other.url} - quit it first.`);
  console.log(`Archive ${archive.root}`);
  try {
    const result = adoptLibrary(config);
    console.log(`✓ Adopted the library in ${dataDir}: ${count(result.photos + result.videos, 'photo or video', 'photos and videos')}, ` +
      `${count(result.sources.length, 'source')}, ${count(result.devices, 'paired device')}`);
    for (const s of result.sources) console.log(`  ${s.name ?? (s.managed === 'backup' ? 'Phone backup' : path.basename(s.path))}: ${s.path}`);
    console.log(`  The library in ${dataDir} stays as it was. photobox scan here adds the archive's own photos.`);
    return 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

/** `sort`: plan, show and (unless --dry-run) do the sort of the archive, or undo the last one. */
async function sort() {
  if (!archive) fail('photobox sort works in an archive - make one with photobox init <folder>');
  console.log(`Archive ${archive.root}`);
  const onProgress = throttle(({ phase, done, total }) => console.log(`  ${phase} ${done}/${total}`));
  try {
    if (opts.undo) return await undo(undoSort, onProgress);
    const config = loadConfig({ dataDir, archive });
    const library = new Library(config.dbPath);
    const sources = library.sources().filter((s) => s.managed !== 'archive').map((s) => s.path);
    library.close();
    const dryRun = opts['dry-run'];
    const result = await sortArchive(archive.root, { dryRun, keep: opts.keep.map((k) => path.resolve(k)), sources, onProgress });
    describeSort(result, dryRun);
    if (dryRun) {
      console.log('Nothing was moved. photobox sort does it; --keep <folder> leaves a folder where it is.');
    } else {
      console.log(`✓ Moved ${count(result.sorted, 'file')} into YYYY/MM and ${count(result.setAside, 'duplicate')} aside. Every move is in ${ARCHIVE_DIR}/history.jsonl;`);
      console.log('  photobox sort --undo puts them all back.');
    }
    return result.problems.length || result.failed.length ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

if (command === 'serve') await serve();
else if (command === 'sort') process.exitCode = await sort();
else if (command === 'merge') process.exitCode = await merge();
else if (command === 'adopt') process.exitCode = adopt();
else process.exitCode = await scanOrExport();
