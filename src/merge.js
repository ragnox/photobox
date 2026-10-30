// Merging an export folder into an archive: what `photobox export` put into another folder, a
// library exported before the archive existed for example, comes into the archive once. Photos
// the archive has already get the folder's albums, people and favorites; the others come in
// under their YYYY/MM path. On the same disk they are hard links: the same file under a second
// name, so no extra space, and the folder keeps its own. From another disk they are copied.
// Older versions of photos that the folder replaced by better ones move to .photobox/superseded/
// here too. The folder is only read. Every change goes into .photobox/history.jsonl first, so
// `photobox merge --undo` can take it all out again.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestFile, statOrNull, syncDirectory, isInside } from './files.js';
import { MANIFEST, readManifest } from './manifest.js';
import { safeRelative, regularDestination, writeManifest, withExportLock, makeDirectory, copyInto } from './export.js';
import { ASIDE, History, full, nameKey, numbered, linkFree, undoLast } from './history.js';

const SHA256 = /^[a-f0-9]{64}$/;
const WORKERS = 4;
const SAVE_EVERY = 250;
// Space to leave free on the archive's disk when merging means copying.
const SPARE_BYTES = 2e9;

const union = (a = [], b = []) => [...new Set([...a, ...b])];
const gigabytes = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;

/** The archive's entry for a photo, with what another entry for it adds: albums, people and favorite add up, the rest fills gaps. */
function mergedEntry(here, there, liveOf = null) {
  const entry = { ...here };
  const albums = union(here.albums, there.albums);
  if (albums.length) entry.albums = albums;
  const people = union(here.people, there.people);
  if (people.length) entry.people = people;
  if (there.favorite) entry.favorite = true;
  if (!entry.description && there.description) entry.description = there.description;
  if (entry.lat == null && there.lat != null) Object.assign(entry, { lat: there.lat, lon: there.lon });
  if (!entry.camera && there.camera) entry.camera = there.camera;
  if (!entry.liveOf && liveOf) entry.liveOf = liveOf;
  return entry;
}

/** Copy a file into the archive under the first free name, verified (see copyInto). */
async function copyFree(add, root) {
  for (let n = 1; ; n++) {
    const rel = numbered(add.to, n);
    try {
      await copyInto(add.from, root, rel, add.entry.takenAt, add.sha256);
      return rel;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/**
 * What merging the export folder `folder` into the archive at `root` would do, without changing
 * anything: { folder, total, add, merge, retire, left, olderVersions, link, copyBytes }. `add` lists
 * files to bring in, `merge` photos the archive has already, `retire` the archive's older versions
 * of photos the folder has better ones of, `left` what stays out and why.
 */
export async function planMerge(root, folder, { link = true, onProgress = () => {} } = {}) {
  const there = await readManifest(folder);
  if (!there) throw new Error(`${folder} is not a Photobox export: it has no ${MANIFEST}`);
  const items = { ...(await readManifest(root))?.items };
  const bySha = new Map(); // content -> where the archive has it
  for (const [rel, entry] of Object.entries(items)) {
    if (!SHA256.test(entry?.sha256 ?? '') || !safeRelative(rel) || bySha.has(entry.sha256)) continue;
    if ((await statOrNull(full(root, rel)))?.size === entry.bytes) bySha.set(entry.sha256, rel);
  }

  const left = [];
  const entries = [];
  for (const [rel, entry] of Object.entries(there.items)) {
    if (!safeRelative(rel) || !SHA256.test(entry?.sha256 ?? '') || !Number.isInteger(entry.bytes)) left.push({ rel, reason: 'not a valid manifest entry' });
    else if (entry.bytes === 0) left.push({ rel, reason: 'an empty file', empty: true });
    else entries.push([rel, entry]);
  }
  // Stills before clips, so a clip can take its still's name.
  entries.sort(([a, x], [b, y]) => Boolean(x.liveOf) - Boolean(y.liveOf) || (a < b ? -1 : 1));

  // Files with content the archive lacks must be what the folder's manifest says they are.
  const fresh = entries.filter(([, entry]) => !bySha.has(entry.sha256));
  const checked = new Map(); // folder path -> { mtimeNs } or { problem }
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < fresh.length) {
      const [rel, entry] = fresh[next++];
      try {
        if (!await regularDestination(folder, rel)) checked.set(rel, { problem: 'missing' });
        else {
          const identity = await digestFile(full(folder, rel));
          checked.set(rel, identity.sha256 === entry.sha256 ? { mtimeNs: identity.mtimeNs } : { problem: 'changed since it was exported' });
        }
      } catch (err) {
        checked.set(rel, { problem: err.message.split('\n')[0] });
      }
      onProgress({ phase: 'checking', done: ++done, total: fresh.length });
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));

  const add = [];
  const merge = [];
  const retire = [];
  const placed = new Map(); // folder path -> archive path
  const reserved = new Set();
  // A name not taken yet; a file already there with the entry's content counts as it.
  const freeName = async (rel, entry = null) => {
    for (let n = 1; ; n++) {
      const candidate = numbered(rel, n);
      if (reserved.has(nameKey(candidate))) continue;
      const stat = await statOrNull(full(root, candidate));
      if (!stat) return { rel: candidate, present: false };
      if (entry && stat.isFile() && stat.size === entry.bytes && await regularDestination(root, candidate) &&
          (await digestFile(full(root, candidate))).sha256 === entry.sha256) return { rel: candidate, present: true };
    }
  };

  for (const [rel, entry] of entries) {
    const from = full(folder, rel);
    const stillRel = entry.liveOf ? placed.get(entry.liveOf) ?? null : null;
    const known = bySha.get(entry.sha256);
    if (known) {
      const merged = mergedEntry(items[known], entry, stillRel);
      merge.push({ from, to: known, sha256: entry.sha256, entry: merged, albums: entry.albums ?? [], changed: JSON.stringify(merged) !== JSON.stringify(items[known]) });
      items[known] = merged;
      placed.set(rel, known);
      continue;
    }
    const { problem, mtimeNs } = checked.get(rel);
    if (problem) {
      left.push({ rel, reason: problem });
      continue;
    }
    let target = rel;
    if (stillRel) {
      // A clip takes its still's name: "IMG_1 (2).HEIC" -> "IMG_1 (2).MOV", "X.MP.jpg" -> "X.MP".
      const ext = path.posix.extname(rel);
      let stem = path.posix.parse(stillRel).name;
      if (stem.toLowerCase().endsWith(ext.toLowerCase())) stem = stem.slice(0, -ext.length);
      target = `${path.posix.dirname(stillRel)}/${stem}${ext}`;
    }
    const { rel: to, present } = await freeName(target, entry);
    reserved.add(nameKey(to));
    const added = { ...entry, mergedFrom: from };
    if (stillRel) added.liveOf = stillRel;
    else delete added.liveOf;
    const name = entry.originalName ?? path.posix.basename(rel);
    if (path.posix.basename(to) === name) delete added.originalName;
    else added.originalName = name;
    add.push({ from, to, sha256: entry.sha256, size: entry.bytes, mtimeNs, entry: added, present });
    items[to] = added;
    bySha.set(entry.sha256, to);
    placed.set(rel, to);
  }

  // The folder's older versions of photos: where the archive has one, it gives way to the better version.
  const ours = new Set(entries.map(([, entry]) => entry.sha256));
  const replacedBy = new Map();
  for (const entry of Object.values(there.superseded ?? {})) {
    if (SHA256.test(entry?.sha256 ?? '') && SHA256.test(entry.supersededBy ?? '')) replacedBy.set(entry.sha256, entry.supersededBy);
  }
  for (const [old, by] of replacedBy) {
    const rel = bySha.get(old);
    if (!rel || ours.has(old)) continue;
    let better = by;
    for (let hops = 0; !bySha.has(better) && replacedBy.has(better) && hops < 10; hops++) better = replacedBy.get(better);
    const replacement = bySha.get(better);
    if (!replacement || replacement === rel) continue;
    const { rel: to } = await freeName(`${ASIDE}/${rel}`);
    reserved.add(nameKey(to));
    retire.push({ rel, to, sha256: old, size: items[rel].bytes, supersededBy: better, replacement });
  }

  const sameDisk = (await fs.stat(folder)).dev === (await fs.stat(root)).dev;
  return {
    folder, total: Object.keys(there.items).length, add, merge, retire, left,
    olderVersions: replacedBy.size, link: link && sameDisk,
    copyBytes: link && sameDisk ? 0 : add.filter((a) => !a.present).reduce((sum, a) => sum + a.size, 0),
  };
}

/**
 * Merge the export folder `folder` into the archive at `root` (see planMerge). `dryRun` only plans;
 * `link: false` copies even on the same disk. Returns the plan plus { run, added, merged, setAside, problems }.
 */
export function mergeInto(root, folder, { dryRun = false, link = true, onProgress = () => {} } = {}) {
  return withExportLock(root, async (key) => {
    root = await fs.realpath(key);
    const real = await fs.realpath(path.resolve(folder)).catch(() => null);
    if (!real || !(await fs.stat(real)).isDirectory()) throw new Error(`Not a folder: ${folder}`);
    folder = real;
    if (folder === root) throw new Error("That's the archive itself");
    if (isInside(folder, root)) throw new Error(`${folder} is inside the archive - photobox sort puts what's in it in place`);
    if (isInside(root, folder)) throw new Error(`${folder} holds the archive`);
    const plan = await planMerge(root, folder, { link, onProgress });
    const result = { ...plan, run: null, added: 0, merged: 0, setAside: 0, problems: [] };
    if (dryRun) return result;
    if (plan.copyBytes) {
      const { bavail, bsize } = await fs.statfs(root);
      if (bavail * bsize < plan.copyBytes + SPARE_BYTES) {
        throw new Error(`Not enough space: the copies need ${gigabytes(plan.copyBytes)} and ${gigabytes(SPARE_BYTES)} should stay free, the disk has ${gigabytes(bavail * bsize)}`);
      }
    }

    const manifest = await readManifest(root);
    const items = { ...manifest?.items };
    const superseded = { ...manifest?.superseded };
    result.run = `merge-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomUUID().slice(0, 6)}`;
    const history = await History.open(root);
    const made = new Set();
    const total = plan.add.length + plan.merge.length + plan.retire.length;
    let done = 0;
    let sinceSave = 0;
    const step = async () => {
      onProgress({ phase: 'merging', done: ++done, total });
      if (++sinceSave < SAVE_EVERY) return;
      sinceSave = 0;
      await writeManifest(root, items, superseded);
    };

    try {
      await history.add({ event: 'merge-started', run: result.run, from: folder, files: plan.add.length + plan.merge.length });
      for (const a of plan.add) {
        try {
          let to = a.to;
          if (!a.present) {
            const dir = path.posix.dirname(a.to);
            if (!made.has(dir)) {
              await makeDirectory(root, dir);
              made.add(dir);
            }
            const now = await fs.stat(a.from, { bigint: true });
            if (Number(now.size) !== a.size || String(now.mtimeNs) !== a.mtimeNs) throw new Error('changed since it was checked');
            to = plan.link ? await linkFree(a.from, root, a.to) : await copyFree(a, root);
            await syncDirectory(path.dirname(full(root, to)));
          }
          const how = a.present ? 'there' : plan.link ? 'link' : 'copy';
          await history.add({ event: 'file-added', run: result.run, how, from: a.from, to, sha256: a.sha256, size: a.size, previous: { items: { [to]: items[to] ?? null } } });
          items[to] = to === a.to ? a.entry : { ...a.entry, originalName: a.entry.originalName ?? path.posix.basename(a.to) };
          result.added++;
        } catch (err) {
          result.problems.push({ rel: a.from, reason: err.message });
        }
        await step();
      }
      for (const m of plan.merge) {
        // Recorded either way: the history says where else each photo was.
        const event = { event: 'file-merged', run: result.run, from: m.from, to: m.to, sha256: m.sha256 };
        if (m.changed) event.previous = { items: { [m.to]: items[m.to] ?? null } };
        await history.add(event);
        if (m.changed) {
          items[m.to] = m.entry;
          result.merged++;
        }
        await step();
      }
      for (const r of plan.retire) {
        // Only once the better version is here.
        if (items[r.replacement] && items[r.rel]) {
          try {
            if ((await fs.stat(full(root, r.rel))).size !== r.size) throw new Error('changed since it was checked');
            await makeDirectory(root, path.posix.dirname(r.to));
            const aside = await linkFree(full(root, r.rel), root, r.to);
            await history.add({
              event: 'file-superseded', run: result.run, reason: 'older version', from: r.rel, to: aside, sha256: r.sha256, size: r.size,
              supersededBy: r.supersededBy, previous: { items: { [r.rel]: items[r.rel], [r.replacement]: items[r.replacement] }, superseded: { [aside]: superseded[aside] ?? null } },
            });
            await fs.rm(full(root, r.rel));
            await syncDirectory(path.dirname(full(root, aside)));
            await syncDirectory(path.dirname(full(root, r.rel)));
            superseded[aside] = { ...items[r.rel], supersededBy: r.supersededBy, exportedAs: r.rel };
            items[r.replacement] = mergedEntry(items[r.replacement], items[r.rel]);
            delete items[r.rel];
            result.setAside++;
          } catch (err) {
            result.problems.push({ rel: r.rel, reason: err.message });
          }
        }
        await step();
      }
      await writeManifest(root, items, superseded);
      await history.add({ event: 'merge-finished', run: result.run, added: result.added, merged: result.merged, setAside: result.setAside, problems: result.problems.length });
    } finally {
      await history.close();
    }
    return result;
  });
}

/** Take out what the last merge brought in, unless something changed since (see undoLast). */
export const undoMerge = (root, options) => undoLast(root, 'merge', options);
