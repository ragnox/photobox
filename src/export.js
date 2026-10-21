// Copies the library into a folder you own: <dest>/YYYY/MM/<name>, one file per
// unique photo or video, grouped and dated by when it was taken. Sources are only
// read, nothing in <dest> is ever overwritten, and running it again copies only
// what's new. <dest>/photobox-export.json keeps albums, favorites, descriptions,
// people and places, and remembers what has been exported.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { quickHash } from './indexer.js';
import { MEDIA_EXT } from './media.js';

export const MANIFEST = 'photobox-export.json';

// Characters that Windows, exFAT or FAT32 drives can't store in a file name.
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_STEM_BYTES = 200;
const COPY_WORKERS = 4;
const SAVE_EVERY = 250;

async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

const full = (dest, rel) => path.join(dest, ...rel.split('/'));
const nameKey = (rel) => rel.normalize('NFC').toLowerCase();

/** File name stem to export under: the photo's real name, made safe for any drive. */
export function safeStem(filename) {
  const ext = path.extname(filename);
  let stem = MEDIA_EXT.has(ext.toLowerCase()) ? filename.slice(0, -ext.length) : filename;
  stem = stem.normalize('NFC').replace(UNSAFE, '_').replace(/^[. ]+|[. ]+$/g, '');
  while (Buffer.byteLength(stem) > MAX_STEM_BYTES) stem = [...stem].slice(0, -1).join('');
  return stem || 'untitled';
}

async function readManifest(dest) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dest, MANIFEST), 'utf8'));
    return data?.version === 1 && data.items && typeof data.items === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function writeManifest(dest, items) {
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const albums = {};
  for (const [rel, item] of Object.entries(sorted)) for (const name of item.albums ?? []) (albums[name] ??= []).push(rel);
  const data = { version: 1, generator: 'photobox', exportedAt: new Date().toISOString(), albums, items: sorted };
  const file = path.join(dest, MANIFEST);
  const partial = path.join(dest, `.${MANIFEST}.partial`);
  await fs.writeFile(partial, JSON.stringify(data, null, 1));
  await fs.rename(partial, file);
}

/** What the manifest records about one exported file. */
function manifestEntry(m, rel, liveOf) {
  const entry = {
    hash: m.hash,
    kind: m.kind,
    takenAt: new Date(m.taken_at).toISOString(),
    localTime: m.local_time,
    dateSource: m.date_source,
  };
  if (path.posix.basename(rel) !== m.filename) entry.originalName = m.filename;
  if (liveOf) entry.liveOf = liveOf;
  if (m.favorite) entry.favorite = true;
  if (m.archived) entry.archived = true;
  if (m.description) entry.description = m.description;
  if (m.people) entry.people = JSON.parse(m.people);
  if (m.lat != null && m.lon != null) Object.assign(entry, { lat: m.lat, lon: m.lon });
  if (m.camera) entry.camera = m.camera;
  if (m.albums.length) entry.albums = m.albums;
  return entry;
}

/** First of the item's files that still has the content that was indexed. */
async function readableSource(m) {
  let changed = false;
  for (const file of m.paths) {
    const stat = await statOrNull(file);
    if (!stat?.isFile()) continue;
    if ((await quickHash(file, stat.size)) === m.hash) return { file };
    changed = true;
  }
  return { reason: changed ? 'changed since the last scan - rescan to export it' : 'not available (source folder offline?)' };
}

/**
 * A name in <dest>/<dir> that isn't taken: "IMG_1.jpg", "IMG_1 (2).jpg", …
 * A file that is already there with the same content (an earlier export whose
 * manifest got lost) is reused instead of copied again.
 */
async function freeName(dest, dir, stem, ext, hash, reserved) {
  for (let n = 1; ; n++) {
    const rel = `${dir}/${n === 1 ? stem : `${stem} (${n})`}${ext}`;
    if (reserved.has(nameKey(rel))) continue;
    const stat = await statOrNull(full(dest, rel));
    if (!stat) return { rel, present: false };
    if (stat.isFile() && (await quickHash(full(dest, rel), stat.size)) === hash) return { rel, present: true };
  }
}

/** Copy via a hidden partial file, so an interrupted export never leaves a half-written photo. */
async function copyInto(source, target, takenAt) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.partial`);
  try {
    // A copy-on-write clone where Node supports it (Btrfs/XFS on Linux; not APFS), a plain copy elsewhere.
    await fs.copyFile(source, partial, constants.COPYFILE_FICLONE);
    const when = new Date(takenAt);
    await fs.utimes(partial, when, when);
    if (await statOrNull(target)) throw new Error(`${target} appeared during the export`);
    await fs.rename(partial, target);
  } catch (err) {
    await fs.rm(partial, { force: true });
    throw err;
  }
}

/**
 * Export every media item in the library to <dest>/YYYY/MM/. Returns
 * { total, copied, present, skipped: [{ name, reason }], planned: [{ source, rel }] }.
 * With dryRun nothing is written; `planned` lists what would be copied.
 */
export async function exportLibrary(library, dest, { dryRun = false, onProgress = () => {} } = {}) {
  dest = path.resolve(dest);
  const destStat = await statOrNull(dest);
  if (destStat && !destStat.isDirectory()) throw new Error(`Not a folder: ${dest}`);

  // Earlier exports, minus files that have since been deleted from <dest> (those get copied again).
  const items = {};
  const exported = new Map();
  for (const [rel, entry] of Object.entries((await readManifest(dest))?.items ?? {})) {
    if (typeof entry?.hash === 'string' && (await statOrNull(full(dest, rel)))?.isFile()) {
      items[rel] = entry;
      if (!exported.has(entry.hash)) exported.set(entry.hash, rel);
    }
  }
  const reserved = new Set(Object.keys(items).map(nameKey));
  const placed = new Map(); // media id -> rel, so a live photo's clip can sit next to its still
  const planned = [];
  const result = { total: 0, copied: 0, present: 0, skipped: [], planned };

  const all = library.exportItems();
  for (const m of all) {
    result.total++;
    if (result.total % 100 === 0) onProgress({ phase: 'checking', done: result.total, total: all.length });
    const stillRel = m.live_of ? placed.get(m.live_of) : null;
    const known = exported.get(m.hash);
    if (known) {
      items[known] = manifestEntry(m, known, stillRel);
      placed.set(m.id, known);
      result.present++;
      continue;
    }
    const source = await readableSource(m);
    if (!source.file) {
      result.skipped.push({ name: m.filename, reason: source.reason });
      continue;
    }
    const ext = path.extname(source.file);
    // A clip takes its still's name ("IMG_1 (2).HEIC" -> "IMG_1 (2).MOV") so apps keep them paired.
    const [dir, stem] = stillRel
      ? [path.posix.dirname(stillRel), path.posix.parse(stillRel).name]
      : [`${m.local_time.slice(0, 4)}/${m.local_time.slice(5, 7)}`, safeStem(m.filename)];
    const { rel, present } = await freeName(dest, dir, stem, ext, m.hash, reserved);
    reserved.add(nameKey(rel));
    items[rel] = manifestEntry(m, rel, stillRel);
    placed.set(m.id, rel);
    if (present) result.present++;
    else planned.push({ source: source.file, rel, takenAt: m.taken_at, name: m.filename });
  }

  if (dryRun) return result;
  await fs.mkdir(dest, { recursive: true });

  let next = 0;
  let done = 0;
  let sinceSave = 0;
  let saving = Promise.resolve();
  const worker = async () => {
    while (next < planned.length) {
      const job = planned[next++];
      try {
        await copyInto(job.source, full(dest, job.rel), job.takenAt);
        result.copied++;
      } catch (err) {
        delete items[job.rel];
        result.skipped.push({ name: job.name, reason: err.message });
      }
      onProgress({ phase: 'copying', done: ++done, total: planned.length });
      // Save progress now and then, so an interrupted export resumes where it stopped.
      if (++sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        saving = saving.then(() => writeManifest(dest, items));
      }
    }
  };
  await Promise.all(Array.from({ length: COPY_WORKERS }, worker));
  await saving;
  await writeManifest(dest, items);
  return result;
}
