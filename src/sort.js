// Sorting an archive: the photos and videos already in it, wherever they are, move into
// YYYY/MM/ by when they were taken, the layout `photobox export` writes. Folder names become
// albums, and an exact duplicate moves to .photobox/superseded/ instead of being deleted.
// Every move is recorded in .photobox/history.jsonl as it happens, so `photobox sort --undo`
// can put everything back. Files are moved (renamed), never copied, overwritten or deleted.
// Sync folders, app libraries, the archive's sources and folders you keep stay as they are.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestFile, quickHash, statOrNull, syncDirectory, relPosix, isInside, isSkipped, readJson } from './files.js';
import { mediaKind, stripMediaExt } from './media.js';
import { DATE_RANK } from './dates.js';
import { FolderContext, extractMeta } from './indexer.js';
import { sidecarMeta } from './takeout/sidecar.js';
import { readManifest } from './manifest.js';
import { safeStem, safeRelative, writeManifest, withExportLock, makeDirectory } from './export.js';
import { ARCHIVE_DIR } from './archive.js';
import { ASIDE, CLUTTER, History, full, nameKey, numbered, linkFree, removeEmpty, undoLast } from './history.js';

const SETTINGS = `${ARCHIVE_DIR}/settings.json`;
// Top-level year folders hold what is sorted already.
const SORTED = /^\d{4}$/;
// Folder names that say how files got somewhere, not what they show: they make no album.
const GENERIC = [/^DCIM$/i, /^\d{3}[A-Z0-9_]{5}$/i, /^Photos from \d{4}$/i, /^Takeout$/i, /^Google (Photos|Fotos)$/i, /^Sent$/i, /^Private$/i];
const WORKERS = 6;
const SAVE_EVERY = 250;

const topFolder = (rel) => (rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '');

/** The album a folder makes: its path in the archive, without names like DCIM or "Photos from 2019". */
export function folderAlbum(dir) {
  const parts = dir ? dir.normalize('NFC').split('/').filter((part) => !GENERIC.some((re) => re.test(part))) : [];
  return parts.length ? parts.join(' / ') : null;
}

async function readSettings(root) {
  const data = await readJson(full(root, SETTINGS));
  const settings = data && typeof data === 'object' && !Array.isArray(data) ? data : { version: 1 };
  const keep = Array.isArray(settings.keepInPlace) ? settings.keepInPlace.filter(safeRelative).map((k) => k.normalize('NFC')) : [];
  return { settings, keep };
}

async function writeJsonAtomic(file, value) {
  const partial = `${file}.${randomUUID()}.partial`;
  try {
    const handle = await fs.open(partial, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(partial, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(partial, { force: true }); }
}

/** `folder` (absolute, or relative to the archive) as a path in the archive. */
async function keptFolder(root, folder) {
  const dir = await fs.realpath(path.resolve(root, folder)).catch(() => path.resolve(root, folder));
  const rel = relPosix(root, dir).normalize('NFC');
  if (!isInside(dir, root) || !safeRelative(rel)) throw new Error(`Not a folder in the archive: ${folder}`);
  if (!(await statOrNull(dir))?.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  return rel;
}

/** The archive's files outside the year folders, and what is left alone and why. */
async function unsortedFiles(root, { kept, sources }) {
  const files = [];
  const leftAlone = [];
  const visit = async (dir) => {
    const rel = relPosix(root, dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      leftAlone.push({ rel, reason: "can't be read" });
      return;
    }
    if (dir !== root && entries.some((e) => e.name === '.stfolder')) {
      leftAlone.push({ rel, reason: 'a sync folder (Syncthing)' });
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const fileRel = relPosix(root, file);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || (dir === root && SORTED.test(entry.name))) continue;
        if (isSkipped(entry.name)) leftAlone.push({ rel: fileRel, reason: 'an app library or system folder' });
        else if (kept.includes(fileRel.normalize('NFC'))) leftAlone.push({ rel: fileRel, reason: 'kept in place' });
        else if (sources.includes(file.normalize('NFC'))) leftAlone.push({ rel: fileRel, reason: 'a source of this archive' });
        else await visit(file);
      } else if (entry.isFile() && !isSkipped(entry.name)) {
        files.push(file);
      }
    }
  };
  await visit(root);
  return { files, leftAlone };
}

async function readItem(root, file, context) {
  const stat = await fs.stat(file);
  const identity = await digestFile(file);
  const { sidecar, album } = context.lookup(file);
  const sc = sidecar ? sidecarMeta(sidecar.entry.data) : null;
  const rel = relPosix(root, file);
  if (sc?.trashed) return { rel, trashed: true };
  const kind = mediaKind(file);
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  return {
    file, rel, dir, kind, name: path.basename(file).normalize('NFC'),
    sha256: identity.sha256, size: identity.size, mtimeNs: identity.mtimeNs,
    quick: await quickHash(file, identity.size),
    meta: await extractMeta(file, kind, stat, sc),
    albums: [album ?? folderAlbum(dir)].filter(Boolean),
  };
}

/** One record for the copies of one content: the best-dated copy, with every copy's albums. */
function merged(copies) {
  const [first, ...rest] = copies;
  const meta = { ...first.meta };
  for (const { meta: m } of rest) {
    if (meta.lat == null && m.lat != null) Object.assign(meta, { lat: m.lat, lon: m.lon });
    meta.camera ??= m.camera;
    meta.description ??= m.description;
    meta.favorite ||= m.favorite;
    if (!meta.people?.length && m.people?.length) meta.people = m.people;
  }
  return { ...first, meta, albums: [...new Set(copies.flatMap((c) => c.albums))].sort() };
}

/** What the manifest records about a sorted file: what `photobox export` writes, plus where it was. */
function manifestEntry(item, rel, liveOf) {
  const m = item.meta;
  const entry = {
    hash: item.quick,
    sha256: item.sha256,
    bytes: item.size,
    kind: item.kind,
    takenAt: new Date(m.takenAt).toISOString(),
    localTime: m.localTime,
    dateSource: m.dateSource,
  };
  if (path.posix.basename(rel) !== item.name) entry.originalName = item.name;
  if (liveOf) entry.liveOf = liveOf;
  if (m.favorite) entry.favorite = true;
  if (m.archived) entry.archived = true;
  if (m.description) entry.description = m.description;
  if (m.people?.length) entry.people = m.people;
  if (m.lat != null && m.lon != null) Object.assign(entry, { lat: m.lat, lon: m.lon });
  if (m.camera) entry.camera = m.camera;
  if (item.albums.length) entry.albums = item.albums;
  entry.sortedFrom = item.rel.normalize('NFC');
  return entry;
}

/**
 * What sorting the archive at `root` would do, without changing anything:
 * { moves, duplicates, addAlbums, leftAlone, trashed, others, failed, keep, total }.
 * `keep` lists further folders to leave in place, `sources` the archive's source folders.
 */
export async function planSort(root, { keep = [], sources = [], onProgress = () => {} } = {}) {
  const { keep: saved } = await readSettings(root);
  const kept = [...new Set([...saved, ...await Promise.all(keep.map((k) => keptFolder(root, k)))])].sort();
  const { files, leftAlone } = await unsortedFiles(root, { kept, sources: sources.map((s) => path.resolve(s).normalize('NFC')) });

  const context = new FolderContext();
  const media = [];
  const others = new Map(); // top folder -> files that stay because they are no photo or video
  for (const file of files) {
    if (file.toLowerCase().endsWith('.json')) await context.addJson(file);
    if (mediaKind(file)) media.push(file);
    else if (!CLUTTER.has(path.basename(file))) {
      const top = topFolder(relPosix(root, file));
      others.set(top, (others.get(top) ?? 0) + 1);
    }
  }

  const read = [];
  const trashed = [];
  const failed = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < media.length) {
      const file = media[next++];
      try {
        const item = await readItem(root, file, context);
        (item.trashed ? trashed : read).push(item);
      } catch (err) {
        failed.push({ rel: relPosix(root, file), reason: err.message.split('\n')[0] });
      }
      onProgress({ phase: 'reading', done: ++done, total: media.length });
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));

  // What earlier sorts and exports put in the year folders, by content.
  const manifest = await readManifest(root);
  const sortedBySha = new Map();
  for (const [rel, entry] of Object.entries(manifest?.items ?? {})) {
    if (typeof entry?.sha256 !== 'string' || !SORTED.test(topFolder(rel)) || !safeRelative(rel)) continue;
    if ((await statOrNull(full(root, rel)))?.size === entry.bytes) sortedBySha.set(entry.sha256, rel);
  }

  const groups = new Map();
  for (const item of read.sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
    if (!groups.has(item.sha256)) groups.set(item.sha256, []);
    groups.get(item.sha256).push(item);
  }
  // Per content, the best-dated copy first; stills before clips, so a live photo's clip can take its still's name.
  const byDate = (a, b) => DATE_RANK[b.meta.dateSource] - DATE_RANK[a.meta.dateSource] || (a.rel < b.rel ? -1 : 1);
  const contents = [...groups.values()].map((copies) => {
    copies.sort(byDate);
    return { copies, item: merged(copies) };
  });
  contents.sort((a, b) => (a.item.kind === b.item.kind ? (a.item.rel < b.item.rel ? -1 : 1) : a.item.kind === 'image' ? -1 : 1));

  const moves = [];
  const duplicates = [];
  const addAlbums = new Map(); // a file sorted earlier -> albums its new copies add
  const reserved = new Set();
  const stills = new Map(); // folder + name without extension -> the move of that still
  // A name not taken yet; with `item`, a file already there with its content counts as it.
  const freeName = async (rel, item = null) => {
    for (let n = 1; ; n++) {
      const candidate = numbered(rel, n);
      if (reserved.has(nameKey(candidate))) continue;
      const stat = await statOrNull(full(root, candidate));
      if (!stat) return { rel: candidate, present: false };
      if (item && stat.isFile() && stat.size === item.size && (await digestFile(full(root, candidate))).sha256 === item.sha256) {
        return { rel: candidate, present: true };
      }
    }
  };
  const setAside = async (copy, sameAs) => {
    const { rel } = await freeName(`${ASIDE}/${copy.rel}`);
    reserved.add(nameKey(rel));
    duplicates.push({ item: copy, to: rel, sameAs });
  };

  for (const { copies, item } of contents) {
    const earlier = sortedBySha.get(item.sha256);
    if (earlier) {
      addAlbums.set(earlier, [...new Set([...(addAlbums.get(earlier) ?? []), ...item.albums])]);
      for (const copy of copies) await setAside(copy, earlier);
      continue;
    }
    const ext = path.extname(item.name);
    const still = item.kind === 'video'
      ? stills.get(`${item.dir}\0${stripMediaExt(item.name).toLowerCase()}`) ?? stills.get(`${item.dir}\0${item.name.toLowerCase()}`)
      : null;
    let target;
    if (still) {
      // A clip takes its still's name: "IMG_1 (2).HEIC" -> "IMG_1 (2).MOV", "X.MP.jpg" -> "X.MP".
      let stem = path.posix.parse(still.to).name;
      if (stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
      target = `${path.posix.dirname(still.to)}/${stem}${ext}`;
    } else {
      target = `${item.meta.localTime.slice(0, 4)}/${item.meta.localTime.slice(5, 7)}/${safeStem(item.name)}${ext}`;
    }
    const { rel, present } = await freeName(target, item);
    reserved.add(nameKey(rel));
    if (present) {
      for (const copy of copies) await setAside(copy, rel);
      addAlbums.set(rel, [...new Set([...(addAlbums.get(rel) ?? []), ...item.albums])]);
      continue;
    }
    const move = { item, to: rel, liveOf: still?.to ?? null };
    moves.push(move);
    if (item.kind === 'image') stills.set(`${item.dir}\0${stripMediaExt(item.name).toLowerCase()}`, move);
    for (const copy of copies.slice(1)) await setAside(copy, rel);
  }

  return {
    root, keep: kept, total: media.length, moves, duplicates, addAlbums, leftAlone, failed,
    trashed: trashed.map((t) => t.rel), others,
  };
}

/**
 * Sort the archive at `root` (see planSort for the options; `dryRun` only plans). Returns the
 * plan plus { run, sorted, setAside, problems }. Folders given in `keep` are remembered in
 * .photobox/settings.json and left in place by later sorts too.
 */
export function sortArchive(root, { dryRun = false, keep = [], sources = [], onProgress = () => {} } = {}) {
  return withExportLock(root, async (key) => {
    root = await fs.realpath(key);
    const plan = await planSort(root, { keep, sources, onProgress });
    const result = { ...plan, run: null, sorted: 0, setAside: 0, problems: [] };
    if (dryRun) return result;

    const { settings } = await readSettings(root);
    if (plan.keep.join('\n') !== (settings.keepInPlace ?? []).join('\n')) {
      await writeJsonAtomic(full(root, SETTINGS), { ...settings, version: 1, keepInPlace: plan.keep });
    }
    const manifest = await readManifest(root);
    const items = { ...manifest?.items };
    const superseded = { ...manifest?.superseded };
    for (const [rel, albums] of plan.addAlbums) {
      if (items[rel]) items[rel] = { ...items[rel], albums: [...new Set([...(items[rel].albums ?? []), ...albums])].sort() };
    }

    result.run = `sort-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 6)}`;
    const history = await History.open(root);
    const made = new Set();
    const emptied = [];
    const finalName = new Map(); // planned name -> name it got, should a name be taken meanwhile
    let sinceSave = 0;
    let done = 0;
    const total = plan.moves.length + plan.duplicates.length;
    const move = async ({ item }, to, event) => {
      const now = await fs.stat(item.file, { bigint: true });
      if (Number(now.size) !== item.size || String(now.mtimeNs) !== item.mtimeNs) throw new Error('changed since it was read');
      const dir = path.posix.dirname(to);
      if (!made.has(dir)) {
        await makeDirectory(root, dir);
        made.add(dir);
      }
      const rel = await linkFree(item.file, root, to);
      // Recorded before the old name goes: undo then finds the file under one name or both.
      await history.add({ ...event(rel), run: result.run, from: item.rel, to: rel, sha256: item.sha256, size: item.size });
      await fs.rm(item.file);
      await syncDirectory(path.dirname(full(root, rel)));
      await syncDirectory(path.dirname(item.file));
      emptied.push(path.dirname(item.file));
      return rel;
    };
    const save = async () => {
      if (++sinceSave < SAVE_EVERY) return;
      sinceSave = 0;
      await writeManifest(root, items, superseded);
    };

    try {
      await history.add({ event: 'sort-started', run: result.run, files: total, keep: plan.keep });
      for (const planned of plan.moves) {
        try {
          const liveOf = planned.liveOf && (finalName.get(planned.liveOf) ?? planned.liveOf);
          const rel = await move(planned, planned.to, () => ({
            event: 'file-sorted', albums: planned.item.albums, takenAt: new Date(planned.item.meta.takenAt).toISOString(),
            dateSource: planned.item.meta.dateSource,
          }));
          finalName.set(planned.to, rel);
          items[rel] = manifestEntry(planned.item, rel, liveOf);
          result.sorted++;
        } catch (err) {
          result.problems.push({ rel: planned.item.rel, reason: err.message });
        }
        onProgress({ phase: 'moving', done: ++done, total });
        await save();
      }
      for (const planned of plan.duplicates) {
        try {
          const sameAs = finalName.get(planned.sameAs) ?? planned.sameAs;
          const rel = await move(planned, planned.to, () => ({ event: 'file-superseded', reason: 'duplicate', sameAs }));
          superseded[rel] = { sha256: planned.item.sha256, bytes: planned.item.size, duplicateOf: sameAs, sortedFrom: planned.item.rel.normalize('NFC') };
          result.setAside++;
        } catch (err) {
          result.problems.push({ rel: planned.item.rel, reason: err.message });
        }
        onProgress({ phase: 'moving', done: ++done, total });
        await save();
      }
      await removeEmpty(root, emptied, (rel) => history.add({ event: 'folder-removed', run: result.run, path: rel }));
      await writeManifest(root, items, superseded);
      await history.add({ event: 'sort-finished', run: result.run, sorted: result.sorted, setAside: result.setAside, problems: result.problems.length });
    } finally {
      await history.close();
    }
    return result;
  });
}

/** Put back what the last sort moved, unless something changed since (see undoLast). */
export const undoSort = (root, options) => undoLast(root, 'sort', options);
