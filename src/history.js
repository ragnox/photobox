// An archive's history: .photobox/history.jsonl, one JSON object per line, only ever appended.
// `photobox sort` and `photobox merge` record each change there before it is final, so the
// last of them can be undone: every file goes back where it was, and so do manifest entries.
import fs from 'node:fs/promises';
import path from 'node:path';
import { digestFile, syncDirectory, relPosix, isInside } from './files.js';
import { readManifest } from './manifest.js';
import { safeRelative, writeManifest, withExportLock } from './export.js';
import { ARCHIVE_DIR } from './archive.js';

export const HISTORY = `${ARCHIVE_DIR}/history.jsonl`;
export const ASIDE = `${ARCHIVE_DIR}/superseded`;
// What Finder and Windows leave in folders: a folder holding only these is empty.
export const CLUTTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
// Events that put a file somewhere in the archive, which undo reverses.
const PLACED = new Set(['file-sorted', 'file-superseded', 'file-added', 'file-merged']);

export const full = (root, rel) => path.join(root, ...rel.split('/'));
export const nameKey = (rel) => rel.normalize('NFC').toLowerCase();
export const numbered = (rel, n) => {
  const ext = path.posix.extname(rel);
  return n === 1 ? rel : `${rel.slice(0, rel.length - ext.length)} (${n})${ext}`;
};

/** Appends events to .photobox/history.jsonl, each written through before the next step. */
export class History {
  static async open(root) {
    const history = new History();
    await fs.mkdir(full(root, ARCHIVE_DIR), { recursive: true });
    history.handle = await fs.open(full(root, HISTORY), 'a');
    return history;
  }

  async add(event) {
    await this.handle.write(`${JSON.stringify({ t: new Date().toISOString(), ...event })}\n`);
    await this.handle.sync();
  }

  close() {
    return this.handle.close();
  }
}

export async function readHistory(root) {
  const text = await fs.readFile(full(root, HISTORY), 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

/** Link `toRel` in the archive to the file `source` under the first free name, then return that name. */
export async function linkFree(source, root, toRel) {
  for (let n = 1; ; n++) {
    const rel = numbered(toRel, n);
    try {
      await fs.link(source, full(root, rel));
      return rel;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/** Remove `dirs` and the folders above them (up to `root`) that are now empty, but for Finder's bookkeeping. */
export async function removeEmpty(root, dirs, onRemoved = async () => {}) {
  const pending = [...new Set(dirs)].sort((a, b) => b.length - a.length);
  const seen = new Set();
  while (pending.length) {
    const dir = pending.shift();
    if (seen.has(dir) || dir === root || !isInside(dir, root) || dir === full(root, ARCHIVE_DIR)) continue;
    seen.add(dir);
    const entries = await fs.readdir(dir).catch(() => null);
    if (!entries || entries.some((name) => !CLUTTER.has(name))) continue;
    for (const name of entries) await fs.rm(path.join(dir, name));
    await fs.rmdir(dir);
    await onRemoved(relPosix(root, dir));
    pending.push(path.dirname(dir));
    pending.sort((a, b) => b.length - a.length);
  }
}

/** Take a file out of the archive that a merge linked or copied in, if its original is still where it came from. */
async function takeOut(root, e, history, run) {
  const now = await fs.lstat(full(root, e.to)).catch(() => null);
  if (!now) return false; // taken out by an earlier undo
  if (!now.isFile()) throw new Error('no longer a file');
  const original = await fs.stat(e.from).catch(() => null);
  if (!original?.isFile()) throw new Error(`its original ${e.from} is gone, so it stays`);
  const linked = original.ino === now.ino && original.dev === now.dev;
  if (!linked && (original.size !== e.size || (await digestFile(e.from)).sha256 !== e.sha256)) throw new Error(`its original ${e.from} changed, so it stays`);
  if (now.size !== e.size || (!linked && (await digestFile(full(root, e.to))).sha256 !== e.sha256)) throw new Error('changed since it was merged');
  await history.add({ event: 'file-removed', run, undo: true, path: e.to, sha256: e.sha256, original: e.from });
  await fs.rm(full(root, e.to));
  await syncDirectory(path.dirname(full(root, e.to)));
  return true;
}

/** Move a file back from where a sort or merge put it in the archive to where it was. */
async function moveBack(root, e, history, run) {
  if (!safeRelative(e.from) || !safeRelative(e.to)) throw new Error('not a path in the archive');
  const to = full(root, e.to);
  const from = full(root, e.from);
  const now = await fs.lstat(to).catch(() => null);
  const back = await fs.lstat(from).catch(() => null);
  if (!now && back?.isFile() && back.size === e.size) return false; // put back by an earlier undo
  if (!now?.isFile()) throw new Error('no longer there');
  if (back && (back.ino !== now.ino || back.dev !== now.dev)) throw new Error('its old place is taken');
  if (now.size !== e.size || (await digestFile(to)).sha256 !== e.sha256) throw new Error('changed since it was sorted');
  if (!back) {
    await fs.mkdir(path.dirname(from), { recursive: true });
    await fs.link(to, from);
  }
  await history.add({ event: 'file-moved', run, undo: true, from: e.to, to: e.from, sha256: e.sha256, size: e.size });
  await fs.rm(to);
  await syncDirectory(path.dirname(from));
  await syncDirectory(path.dirname(to));
  return true;
}

/**
 * Undo the last sort or merge (`kind`) that isn't undone yet. A file that changed since, or whose
 * old place is taken, stays where it is and is listed in `problems`; run it again once fixed.
 * Changes are undone newest first, so only the last one can be: a merge after a sort is undone
 * before the sort. Returns { run, restored, problems }.
 */
export function undoLast(root, kind, { onProgress = () => {} } = {}) {
  return withExportLock(root, async (key) => {
    root = await fs.realpath(key);
    const events = await readHistory(root);
    const undone = new Set(events.filter((e) => /^(sort|merge)-undone$/.test(e.event)).map((e) => e.run));
    const open = events.filter((e) => /^(sort|merge)-started$/.test(e.event) && !undone.has(e.run));
    const mine = open.filter((e) => e.event === `${kind}-started`).at(-1);
    if (!mine) throw new Error(`There is no ${kind} to undo`);
    const last = open.at(-1);
    const lastKind = last.event.slice(0, -'-started'.length);
    if (last !== mine) throw new Error(`The last change was a ${lastKind} (${last.run}) - undo that first: photobox ${lastKind} --undo`);
    const { run } = mine;
    const changes = events.filter((e) => e.run === run && PLACED.has(e.event) && !e.undo).reverse();

    const manifest = await readManifest(root);
    const items = { ...manifest?.items };
    const superseded = { ...manifest?.superseded };
    // Entries as they were before the change. Without them, a merge changed no entry, and a sort only added one.
    const restore = (e) => {
      if (!e.previous) {
        if (e.event === 'file-merged') return;
        delete items[e.to];
        delete superseded[e.to];
        return;
      }
      for (const [rel, entry] of Object.entries(e.previous.items ?? {})) if (entry) items[rel] = entry; else delete items[rel];
      for (const [rel, entry] of Object.entries(e.previous.superseded ?? {})) if (entry) superseded[rel] = entry; else delete superseded[rel];
    };
    const result = { run, restored: 0, problems: [] };
    const emptied = [];
    const history = await History.open(root);
    try {
      await history.add({ event: 'undo-started', run, files: changes.length });
      for (const [i, e] of changes.entries()) {
        try {
          if (e.event === 'file-added') {
            if (e.how !== 'there' && await takeOut(root, e, history, run)) {
              emptied.push(path.dirname(full(root, e.to)));
              result.restored++;
            }
          } else if (e.event !== 'file-merged' && await moveBack(root, e, history, run)) {
            emptied.push(path.dirname(full(root, e.to)));
            result.restored++;
          }
          restore(e);
        } catch (err) {
          result.problems.push({ rel: e.to, reason: err.message });
        }
        onProgress({ phase: 'undoing', done: i + 1, total: changes.length });
      }
      await removeEmpty(root, emptied);
      await writeManifest(root, items, superseded);
      if (!result.problems.length) await history.add({ event: `${kind}-undone`, run, restored: result.restored });
    } finally {
      await history.close();
    }
    return result;
  });
}
