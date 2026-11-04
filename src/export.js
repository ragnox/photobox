// Copies the library into a folder you own: <dest>/YYYY/MM/<name>, one file per
// unique photo or video, grouped and dated by when it was taken. Sources are only
// read, nothing in <dest> is ever overwritten, and running it again copies only
// what's new. <dest>/photobox-export.json keeps albums, favorites, descriptions,
// people and places, and remembers what has been exported. When a better version of
// an exported photo turns up, the older file moves to <dest>/.photobox/superseded/.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { quickHash, digestFile, syncDirectory, walk, statOrNull, isInside, relPosix, readJson } from './files.js';
import { mediaExt, mediaKind, stripMediaExt } from './media.js';
import { MANIFEST, readManifest } from './manifest.js';

// Characters that Windows, exFAT or FAT32 drives can't store in a file name.
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const MAX_STEM_BYTES = 200;
const COPY_WORKERS = 4;
const SAVE_EVERY = 250;
// Where exported files go once a better version of their photo replaced them.
const ASIDE = '.photobox/superseded';
// An exported file that hasn't changed since an export read it (same inode, size, modified and changed
// times) isn't read again for this long. Then it is, so damage that leaves those alone shows within a week.
const RECHECK_MS = 7 * 24 * 3600_000;

const full = (dest, rel) => path.join(dest, ...rel.split('/'));
const nameKey = (rel) => rel.normalize('NFC').toLowerCase();

/** File name stem to export under: the photo's real name, made safe for any drive. */
export function safeStem(filename) {
  let stem = stripMediaExt(filename).normalize('NFC').replace(UNSAFE, '_').replace(/^[. ]+|[. ]+$/g, '');
  while (Buffer.byteLength(stem) > MAX_STEM_BYTES) stem = [...stem].slice(0, -1).join('');
  return stem || 'untitled';
}

export async function writeManifest(dest, items, superseded = {}) {
  const sorted = Object.fromEntries(Object.keys(items).sort().map((rel) => [rel, items[rel]]));
  const albums = {};
  for (const [rel, item] of Object.entries(sorted)) for (const name of item.albums ?? []) (albums[name] ??= []).push(rel);
  const data = { version: 1, generator: 'photobox', exportedAt: new Date().toISOString(), albums, items: sorted };
  if (Object.keys(superseded).length) data.superseded = superseded;
  const file = path.join(dest, MANIFEST);
  const partial = path.join(dest, `.${MANIFEST}.${randomUUID()}.partial`);
  try {
    const handle = await fs.open(partial, 'wx');
    try { await handle.writeFile(JSON.stringify(data, null, 1)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(partial, file);
    await syncDirectory(dest);
  } finally { await fs.rm(partial, { force: true }); }
}

/** What the manifest records about one exported file. */
function manifestEntry(m, rel, liveOf) {
  const entry = {
    hash: m.hash,
    sha256: m.sha256,
    bytes: m.bytes,
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

/** A file `photobox sort` or `photobox merge` put in place keeps the albums it came with, and where it was. */
function keepSorted(before, entry) {
  if (!before?.sortedFrom && !before?.mergedFrom) return entry;
  const albums = [...new Set([...(entry.albums ?? []), ...(before.albums ?? [])])];
  const from = Object.fromEntries(['sortedFrom', 'mergedFrom'].filter((key) => before[key]).map((key) => [key, before[key]]));
  return { ...entry, ...(albums.length && { albums }), ...from };
}

/** First of the item's files that still has the content that was indexed. */
async function readableSource(m) {
  let changed = false;
  let found = null;
  for (const file of m.paths) {
    const stat = await statOrNull(file);
    if (!stat?.isFile()) continue;
    if (m.bytes != null && stat.size !== m.bytes) { changed = true; continue; }
    if (!m.sha256 && await quickHash(file, stat.size) !== (m.quick_hash ?? m.hash)) { changed = true; continue; }
    const identity = await digestFile(file);
    if (m.sha256) {
      if (identity.sha256 === m.sha256) return { file, identity };
      changed = true;
    } else if (found && found.identity.sha256 !== identity.sha256) {
      return { reason: 'legacy fingerprint contains different full hashes - rescan before exporting' };
    } else found = { file, identity };
  }
  if (found) return found;
  return { reason: changed ? 'changed since the last scan - rescan to export it' : 'not available (source folder offline?)' };
}

export const safeRelative = (rel) => typeof rel === 'string' && rel.length > 0 && !rel.includes('\\') &&
  !path.posix.isAbsolute(rel) && !rel.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'));

/** Destination receipts never follow symlinks out of the plain-files export. */
export async function regularDestination(dest, rel) {
  if (!safeRelative(rel)) return false;
  let current = dest;
  const parts = rel.split('/');
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await fs.lstat(current).catch((err) => { if (err.code !== 'ENOENT') throw err; return null; });
    if (!info || info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) return false;
  }
  return true;
}

export async function makeDirectory(dest, rel) {
  let current = dest;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    await fs.mkdir(current).catch((err) => { if (err.code !== 'EEXIST') throw err; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Export path is not a plain directory');
    await syncDirectory(path.dirname(current));
  }
}

/** Seal reused/moved files too: a hash alone does not persist their directory entry. */
async function sealExport(library, dest, rel, sha256) {
  if (!await regularDestination(dest, rel)) throw new Error('Exported file is unavailable');
  const verified = await digestFile(full(dest, rel), true);
  if (verified.sha256 !== sha256) throw new Error('Export failed SHA-256 verification');
  for (let dir = path.dirname(full(dest, rel)); ; dir = path.dirname(dir)) {
    await syncDirectory(dir);
    if (dir === dest) break;
  }
  await rememberCheck(library, full(dest, rel), verified);
}

/** Notes what an exported file was found to be, with the inode it has now, if it hasn't changed since. */
async function rememberCheck(library, file, identity) {
  const now = await fs.stat(file, { bigint: true });
  if (Number(now.size) !== identity.size || String(now.mtimeNs) !== identity.mtimeNs || String(now.ctimeNs) !== identity.ctimeNs) return;
  library.rememberExportCheck(file, { ...identity, dev: String(now.dev), ino: String(now.ino) });
}

/** An exported file's SHA-256 and size: read, or as an export found them if the file hasn't changed since (see RECHECK_MS). */
async function checkedDigest(library, file) {
  const stat = await fs.stat(file, { bigint: true });
  const known = library.exportCheck(file);
  if (known && Date.now() - known.checked_at < RECHECK_MS && known.size === Number(stat.size) && known.dev === String(stat.dev) &&
      known.ino === String(stat.ino) && known.mtime_ns === String(stat.mtimeNs) && known.ctime_ns === String(stat.ctimeNs)) {
    return { sha256: known.sha256, size: known.size };
  }
  const identity = await digestFile(file);
  await rememberCheck(library, file, identity);
  return identity;
}

/**
 * Files in <dest> that the manifest doesn't list but that hold an item still to
 * export: moved or renamed since the last export. Returns hash -> rel. Only files
 * with the size of such an item are read, so unrelated files cost a stat at most.
 * Source folders inside <dest> (a Takeout unpacked there) hold originals, not
 * exported copies, so they are left out.
 */
async function findMoved(dest, items, pending, sources) {
  const found = new Map();
  if (!pending.length) return found;
  const wanted = new Set(pending.map((m) => m.sha256));
  const sizes = pending.some((m) => m.bytes == null) ? null : new Set(pending.map((m) => m.bytes));
  const listed = new Set(Object.keys(items).map((rel) => rel.normalize('NFC')));
  const originals = sources.filter((dir) => isInside(dir, dest));
  for await (const file of walk(dest)) {
    const rel = relPosix(dest, file);
    if (!mediaKind(file) || listed.has(rel.normalize('NFC')) || originals.some((dir) => isInside(file, dir))) continue;
    const stat = await statOrNull(file);
    if (!stat || (sizes && !sizes.has(stat.size))) continue;
    if (!await regularDestination(dest, rel)) continue;
    const hash = (await digestFile(file)).sha256;
    if (wanted.has(hash) && !found.has(hash)) found.set(hash, rel);
  }
  return found;
}

/**
 * A name in <dest>/<dir> that isn't taken: "IMG_1.jpg", "IMG_1 (2).jpg", …
 * A file that is already there with the same content (an earlier export whose
 * manifest got lost) is reused instead of copied again.
 */
async function freeName(dest, dir, stem, ext, sha256, reserved) {
  for (let n = 1; ; n++) {
    const rel = `${dir}/${n === 1 ? stem : `${stem} (${n})`}${ext}`;
    if (reserved.has(nameKey(rel))) continue;
    const stat = await statOrNull(full(dest, rel));
    if (!stat) return { rel, present: false };
    if (await regularDestination(dest, rel) && (await digestFile(full(dest, rel))).sha256 === sha256) return { rel, present: true };
  }
}

/**
 * Move an exported file to <dest>/.photobox/superseded/, in the same YYYY/MM folder and
 * under the same name (numbered if taken). Linked, then unlinked: never replaces a file.
 */
async function moveAside(dest, rel) {
  if (!await regularDestination(dest, rel)) throw new Error('Exported file is unavailable');
  const dir = `${ASIDE}/${path.posix.dirname(rel)}`;
  await makeDirectory(dest, dir);
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base);
  for (let n = 1; ; n++) {
    const aside = `${dir}/${n === 1 ? base : `${base.slice(0, -ext.length || undefined)} (${n})${ext}`}`;
    try {
      await fs.link(full(dest, rel), full(dest, aside));
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    await fs.rm(full(dest, rel));
    await syncDirectory(path.dirname(full(dest, aside)));
    await syncDirectory(path.dirname(full(dest, rel)));
    return aside;
  }
}

/** Copy via a hidden partial file, so an interrupted export never leaves a half-written photo. */
export async function copyInto(source, dest, rel, takenAt, sha256) {
  await makeDirectory(dest, path.posix.dirname(rel));
  const target = full(dest, rel);
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.partial`);
  try {
    // A copy-on-write clone where Node supports it (Btrfs/XFS on Linux; not APFS), a plain copy elsewhere.
    await fs.copyFile(source, partial, constants.COPYFILE_FICLONE);
    const when = new Date(takenAt);
    await fs.utimes(partial, when, when);
    const verified = await digestFile(partial, true);
    if (verified.sha256 !== sha256) throw new Error('Source changed or export copy failed SHA-256 verification');
    // link publishes atomically without replacing a file created by another writer.
    await fs.link(partial, target);
    await fs.rm(partial, { force: true });
    await syncDirectory(path.dirname(target));
    return verified;
  } finally { await fs.rm(partial, { force: true }); }
}

/**
 * Export every media item in the library to <dest>/YYYY/MM/. Returns
 * { total, copied, present, skipped: [{ name, reason }], planned: [{ source, rel, takenAt, name }] }.
 * With dryRun nothing is written; `planned` lists what would be copied.
 */
const exportLocks = new Map();
// Held in <dest> while a Photobox writes to it, so one in another process waits its turn.
export const WRITING = '.photobox-writing';
// A lock this old was left by a process that is long gone, even if its id was reused since.
const STALE_MS = 12 * 3600_000;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * Run `fn` once no other export, sort or merge is writing to `dest`: none in this process, and
 * none in another (the app's phone backup and a nightly export, say), which `wait`s at most this long.
 */
export async function withExportLock(dest, fn, { wait = 30 * 60_000 } = {}) {
  const key = path.resolve(dest);
  const previous = exportLocks.get(key) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(() => withWritingLock(key, () => fn(key), wait));
  exportLocks.set(key, job);
  try { return await job; } finally { if (exportLocks.get(key) === job) exportLocks.delete(key); }
}

/** Hold <dest>/.photobox-writing while `fn` runs. A lock whose process is gone is taken over. */
async function withWritingLock(dest, fn, wait) {
  if (!(await statOrNull(dest))?.isDirectory()) return fn(); // nobody else writes to a folder that isn't there yet
  const lock = path.join(dest, WRITING);
  const partial = path.join(dest, `${WRITING}.${randomUUID()}.partial`);
  await fs.writeFile(partial, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
  try {
    for (const started = Date.now(); ;) {
      try {
        await fs.link(partial, lock);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      const held = await fs.lstat(lock).catch(() => null);
      const holder = await readJson(lock);
      const stale = holder && (!alive(holder.pid) || Date.now() - Date.parse(holder.since) > STALE_MS);
      // Only the lock that was found stale goes, not one another waiter took in the meantime.
      if (held && stale && (await fs.lstat(lock).catch(() => null))?.ino === held.ino) await fs.rm(lock, { force: true });
      else if (Date.now() - started > wait) throw new Error(`Another Photobox (process ${holder?.pid ?? '?'}) is writing to ${dest} - try again later`);
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await fs.rm(partial, { force: true });
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

export const exportLibrary = (library, dest, options = {}) => withExportLock(dest, (key) => runExport(library, key, options));

async function runExport(library, dest, { dryRun = false, onProgress = () => {}, mediaIds = null, validateDestination = async () => {} } = {}) {
  dest = path.resolve(dest);
  await validateDestination();
  const destStat = await statOrNull(dest);
  if (destStat && !destStat.isDirectory()) throw new Error(`Not a folder: ${dest}`);
  if (destStat) dest = await fs.realpath(dest);

  const allItems = library.exportItems();
  const ids = mediaIds && new Set(mediaIds);
  if (ids) for (const m of allItems) if (ids.has(m.id) && m.live_of) ids.add(m.live_of);
  const all = [];
  const result = { total: 0, copied: 0, present: 0, superseded: 0, skipped: [], planned: [], verified: [] };
  for (const m of allItems.filter((m) => !ids || ids.has(m.id))) {
    result.total++;
    if (!m.sha256) {
      const source = await readableSource(m);
      if (!source.file) { result.skipped.push({ name: m.filename, reason: source.reason }); continue; }
      m.sha256 = source.identity.sha256;
      m.bytes = source.identity.size;
    }
    all.push(m);
  }
  const byCacheKey = new Map(all.map((m) => [m.hash, m]));

  // Earlier exports, minus files that have since been moved or deleted from <dest>.
  const items = {};
  const exported = new Map();
  const previous = await readManifest(dest);
  const superseded = { ...previous?.superseded };
  // Exported files of versions another version replaced: they keep their name (the new
  // version gets another) and stay listed until the new version is safely there.
  const retiring = [];
  library.forgetExportChecks(Date.now() - RECHECK_MS);
  for (const [rel, entry] of Object.entries(previous?.items ?? {})) {
    if (typeof entry?.hash === 'string' && await regularDestination(dest, rel)) {
      const identity = await checkedDigest(library, full(dest, rel));
      const expected = entry.sha256 ?? byCacheKey.get(entry.hash)?.sha256;
      if (expected && identity.sha256 !== expected) continue;
      items[rel] = { ...entry, sha256: identity.sha256, bytes: identity.size };
      const replacement = library.replacementOf(identity.sha256);
      if (replacement) retiring.push({ rel, replacement });
      else if (!exported.has(identity.sha256)) exported.set(identity.sha256, rel);
    }
  }
  const pending = all.filter((m) => !exported.has(m.sha256));
  const sources = await Promise.all(library.sources().map((s) => fs.realpath(s.path).catch(() => s.path)));
  for (const [hash, rel] of await findMoved(dest, items, pending, sources)) exported.set(hash, rel);
  const reserved = new Set([...Object.keys(items), ...exported.values()].map(nameKey));
  const placed = new Map(); // media id -> rel, so a live photo's clip can sit next to its still
  const planned = result.planned;

  for (const [i, m] of all.entries()) {
    if ((i + 1) % 100 === 0) onProgress({ phase: 'checking', done: i + 1, total: all.length });
    const stillRel = m.live_of ? placed.get(m.live_of) : null;
    const known = exported.get(m.sha256);
    if (known) {
      items[known] = keepSorted(items[known], manifestEntry(m, known, stillRel));
      placed.set(m.id, known);
      result.present++;
      result.verified.push({ mediaId: m.id, sha256: m.sha256, rel: known });
      continue;
    }
    const source = await readableSource(m);
    if (!source.file) {
      result.skipped.push({ name: m.filename, reason: source.reason });
      continue;
    }
    // A name without an extension (Takeout's "30.12.11 - 1") gets the one its content shows.
    const ext = await mediaExt(source.file) ?? path.extname(source.file);
    // A clip takes its still's name ("IMG_1 (2).HEIC" -> "IMG_1 (2).MOV") so apps keep them paired;
    // a Pixel motion clip keeps Google's form ("X.MP.jpg" -> "X.MP", not "X.MP.MP").
    let [dir, stem] = stillRel
      ? [path.posix.dirname(stillRel), path.posix.parse(stillRel).name]
      : [`${m.local_time.slice(0, 4)}/${m.local_time.slice(5, 7)}`, safeStem(m.filename)];
    if (stillRel && stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
    const { rel, present } = await freeName(dest, dir, stem, ext, m.sha256, reserved);
    reserved.add(nameKey(rel));
    items[rel] = manifestEntry(m, rel, stillRel);
    placed.set(m.id, rel);
    if (present) {
      result.present++;
      result.verified.push({ mediaId: m.id, sha256: m.sha256, rel });
    } else planned.push({ source: source.file, rel, takenAt: m.taken_at, name: m.filename, sha256: m.sha256, mediaId: m.id });
  }

  // Older versions here whose better version is here too, or is coming: they move aside.
  const coming = new Set([...result.verified, ...planned].map((p) => p.sha256));
  result.aside = retiring.filter((r) => coming.has(r.replacement)).map((r) => r.rel);
  if (dryRun) return result;
  await fs.mkdir(dest, { recursive: true });
  await syncDirectory(path.dirname(dest));
  // Its real path, as a folder that was already there has: what an export checked is noted under that.
  dest = await fs.realpath(dest);

  const copied = new Set();
  let next = 0;
  let done = 0;
  let sinceSave = 0;
  let saving = Promise.resolve();
  const worker = async () => {
    while (next < planned.length) {
      const job = planned[next++];
      try {
        await validateDestination();
        if (library.isDeleted(job.sha256)) throw new Error('deleted');
        await copyInto(job.source, dest, job.rel, job.takenAt, job.sha256);
        const item = { mediaId: job.mediaId, sha256: job.sha256, rel: job.rel };
        result.verified.push(item);
        copied.add(item);
        result.copied++;
      } catch (err) {
        delete items[job.rel];
        result.skipped.push({ name: job.name, reason: err.message });
      }
      onProgress({ phase: 'copying', done: ++done, total: planned.length });
      // Save progress now and then, so an interrupted export resumes where it stopped.
      if (++sinceSave >= SAVE_EVERY) {
        sinceSave = 0;
        saving = saving.then(() => writeManifest(dest, items, superseded));
      }
    }
  };
  await Promise.all(Array.from({ length: COPY_WORKERS }, worker));
  await saving;
  await validateDestination();
  // What was already here was read (or found unchanged) above; what this export copied is read once more, from disk.
  for (const item of [...copied]) {
    try { await sealExport(library, dest, item.rel, item.sha256); } catch (err) {
      result.verified.splice(result.verified.indexOf(item), 1);
      delete items[item.rel];
      result.skipped.push({ name: path.basename(item.rel), reason: err.message });
    }
  }
  await validateDestination();
  const here = new Set(result.verified.map((item) => item.sha256));
  for (const { rel, replacement } of retiring) {
    if (!here.has(replacement)) continue;
    try {
      const aside = await moveAside(dest, rel);
      superseded[aside] = { ...items[rel], supersededBy: replacement, exportedAs: rel };
      delete items[rel];
      result.superseded++;
    } catch (err) {
      result.skipped.push({ name: path.basename(rel), reason: `older version not moved aside: ${err.message}` });
    }
  }
  // Deleted while this export ran: the copy here goes too, once this export lets go of the folder (see deletions.js).
  for (const [rel, entry] of Object.entries(items)) library.deletedCopy(entry.sha256, full(dest, rel), dest, dest);
  await writeManifest(dest, items, superseded);
  return result;
}
