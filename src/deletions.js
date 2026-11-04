// Deleting a photo deletes it everywhere. Every copy on this computer goes to the Trash: its files
// in source folders, the archive's file, the phone backup's original, the copy in the export folder
// and older versions set aside there. Phones with Photobox for Android learn of it through feed()
// and delete theirs (Android asks first). The Deleted list keeps each file's fingerprint (full
// SHA-256) and what became of it. While a fingerprint is on it, a copy that turns up again (a drive
// plugged back in, a new Takeout, a phone) is deleted too; clearing it from the list forgets it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digestFile, quickHash, relPosix, isInside } from './files.js';
import { MANIFEST, readManifest } from './manifest.js';
import { safeRelative, writeManifest, withExportLock } from './export.js';
import { History, full } from './history.js';
import { thumbPath, previewPath } from './thumbs.js';

const run = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
// How often pending files are looked at, and how long one that couldn't be deleted waits until it's tried again.
const SWEEP_MS = 60_000;
const RETRY_MS = 10 * 60_000;
// A folder an export, sort or merge is writing to: its files wait for the next sweep rather than this long.
const LOCK_WAIT_MS = 5_000;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const ids = (list) => JSON.stringify([...list]);

/** Move `file` to the Trash, so Finder can put it back. Without a Trash (not macOS) it is deleted. */
export async function moveToTrash(file) {
  if (process.platform !== 'darwin') return fs.rm(file);
  try {
    await run('/usr/bin/trash', [file]);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error((err.stderr || err.message).trim().split('\n')[0]);
    // Before macOS 14 there is no trash command; Finder does it.
    await run('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', file]);
  }
}

async function available(dir) {
  try {
    await fs.readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** The export folder whose manifest an indexed file was read with (its sidecar is "<folder>/photobox-export.json#…"). */
const manifestOf = (sidecar) => (sidecar?.includes(`/${MANIFEST}#`) ? path.dirname(sidecar.slice(0, sidecar.indexOf('#'))) : null);

export class Deletions {
  constructor(library, indexer, config, { uploads = null, trash = moveToTrash } = {}) {
    Object.assign(this, { library, indexer, config, uploads, trash });
    this.closed = false;
    this.sweeping = null;
    this.again = false;
    indexer.on('deleted-found', () => this.request());
    this.timer = setInterval(() => this.request(), SWEEP_MS);
    this.timer.unref();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.sweeping;
  }

  /** Folders that hold a copy of the library with a manifest: the archive, and where phone backups are exported to. */
  #libraryFolders() {
    return [...new Set([this.config.archive?.root, this.config.backupDir].filter(Boolean))];
  }

  /**
   * Delete the photo `id` from everywhere, with its other versions and its live photo's clip.
   * Returns { files, waiting }: how many copies on this computer, and how many of them wait for
   * their folder (an unplugged drive) or couldn't be moved to the Trash yet. Null if there's no such photo.
   */
  async delete(id) {
    let shown = this.library.media(id);
    if (!shown) return null;
    // A version or a live photo's clip stands for the photo that is shown.
    for (let up; (up = this.library.media(shown.superseded_by ?? shown.live_of));) shown = up;
    const group = new Map([[shown.id, shown]]);
    for (let grew = true; grew;) {
      grew = false;
      const more = this.library.q(`SELECT * FROM media WHERE superseded_by IN (SELECT value FROM json_each(?))
        OR live_of IN (SELECT value FROM json_each(?))`).all(ids(group.keys()), ids(group.keys()));
      for (const m of more.filter((m) => !group.has(m.id))) {
        group.set(m.id, m);
        grew = true;
      }
    }
    // Every item needs its fingerprint; one indexed before Photobox had them gets it from a file that's there.
    for (const m of group.values()) {
      for (const { path: file } of m.sha256 ? [] : this.library.q('SELECT path FROM files WHERE media_id = ?').all(m.id)) {
        const identity = await digestFile(file).catch(() => null);
        if (identity && await quickHash(file, identity.size) === (m.quick_hash ?? m.hash)) { m.sha256 = identity.sha256; break; }
      }
      if (!m.sha256) throw fail(409, `Photobox can't read ${m.filename} right now (is its drive unplugged?), so it can't delete it yet`);
    }
    const contents = new Map([...group.values()].map((m) => [m.sha256, { sha256: m.sha256, filename: m.filename, kind: m.kind, local_time: m.local_time, bytes: m.bytes }]));

    // Copies that are no file of the library: in the library folders' manifests, older versions set aside there, the inbox.
    const copies = [];
    for (const dir of this.#libraryFolders()) {
      const manifest = await readManifest(dir);
      for (const [rel, entry] of Object.entries(manifest?.items ?? {})) {
        if (contents.has(entry?.sha256) && safeRelative(rel)) copies.push({ sha256: entry.sha256, path: full(dir, rel), root: dir, manifest: dir });
      }
      const aside = Object.entries(manifest?.superseded ?? {}).filter(([rel, entry]) => safeRelative(rel) && SHA256.test(entry?.sha256 ?? ''));
      for (let grew = true; grew;) {
        grew = false;
        for (const [rel, entry] of aside) {
          if (copies.some((c) => c.path === full(dir, rel)) || !(contents.has(entry.sha256) || contents.has(entry.supersededBy) || contents.has(entry.duplicateOf))) continue;
          if (!contents.has(entry.sha256)) {
            contents.set(entry.sha256, { sha256: entry.sha256, filename: path.posix.basename(rel), kind: entry.kind ?? shown.kind, local_time: entry.localTime ?? null, bytes: entry.bytes ?? null });
          }
          copies.push({ sha256: entry.sha256, path: full(dir, rel), root: dir, manifest: dir });
          grew = true;
        }
      }
    }
    if (this.uploads) {
      for (const row of this.library.q("SELECT * FROM backup_uploads WHERE state = 'received' AND sha256 IN (SELECT value FROM json_each(?))").all(ids(contents.keys()))) {
        copies.push({ sha256: row.sha256, path: this.uploads.destination(row), root: path.join(this.config.inboxDir, String(row.device_id)), manifest: null });
      }
    }

    // One transaction, without awaiting anything, so a scan can't add a file of these items in between.
    const now = Date.now();
    const files = this.library.tx(() => {
      let seq = this.library.q('SELECT coalesce(max(seq), 0) AS n FROM deletions').get().n;
      for (const c of contents.values()) {
        this.library.q(`INSERT INTO deletions (sha256, photo, filename, kind, local_time, bytes, deleted_at, cleared_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT (sha256) DO UPDATE SET photo = excluded.photo, filename = excluded.filename, kind = excluded.kind, local_time = excluded.local_time,
            bytes = excluded.bytes, deleted_at = excluded.deleted_at, cleared_at = NULL, seq = excluded.seq`)
          .run(c.sha256, shown.sha256, c.filename, c.kind, c.local_time, c.bytes, now, ++seq);
      }
      const indexed = this.library.q(`SELECT f.path, f.media_id, f.sidecar, s.path AS root, s.managed FROM files f JOIN sources s ON s.id = f.source_id
        WHERE f.media_id IN (SELECT value FROM json_each(?))`).all(ids(group.keys()));
      const places = new Map(copies.map((c) => [c.path, c]));
      for (const f of indexed) {
        const manifest = f.managed === 'archive' ? f.root : manifestOf(f.sidecar);
        places.set(f.path, { sha256: group.get(f.media_id).sha256, path: f.path, root: f.root, manifest: manifest ?? places.get(f.path)?.manifest ?? null });
      }
      for (const p of places.values()) {
        this.library.q(`INSERT INTO deleted_files (sha256, path, root, manifest, state, at) VALUES (?, ?, ?, ?, 'pending', ?)
          ON CONFLICT (path) DO UPDATE SET sha256 = excluded.sha256, root = excluded.root, manifest = excluded.manifest, state = 'pending', error = NULL, at = excluded.at`)
          .run(p.sha256, p.path, p.root, p.manifest, now);
      }
      // A phone backup's export receipt is no proof of anything any more.
      this.library.q('DELETE FROM backup_exports WHERE upload_id IN (SELECT id FROM backup_uploads WHERE sha256 IN (SELECT value FROM json_each(?)))').run(ids(contents.keys()));
      this.library.q('DELETE FROM media WHERE id IN (SELECT value FROM json_each(?))').run(ids(group.keys()));
      this.library.pruneOrphans();
      return places.size;
    });
    for (const m of group.values()) {
      await fs.rm(thumbPath(this.config, m.hash), { force: true });
      await fs.rm(previewPath(this.config, m.hash), { force: true });
    }
    this.indexer.changed();
    await this.sweep();
    const waiting = this.library.q(`SELECT count(*) AS n FROM deleted_files WHERE state = 'pending' AND sha256 IN (SELECT value FROM json_each(?))`).get(ids(contents.keys())).n;
    return { files, waiting };
  }

  /** Look at pending files soon. */
  request() {
    if (this.closed) return;
    if (this.sweeping) {
      this.again = true;
      return;
    }
    this.sweeping = (async () => {
      do {
        this.again = false;
        try { await this.#sweep(); } catch (err) { console.error(err); }
      } while (this.again && !this.closed);
    })().finally(() => { this.sweeping = null; });
  }

  /** Delete what is pending now, and wait until that's done. */
  async sweep() {
    this.request();
    await this.sweeping;
  }

  async #sweep() {
    const rows = this.library.q(`SELECT f.* FROM deleted_files f JOIN deletions d ON d.sha256 = f.sha256
      WHERE f.state = 'pending' AND d.cleared_at IS NULL AND (f.error IS NULL OR f.at < ?) ORDER BY f.id`).all(Date.now() - RETRY_MS);
    const listed = new Map();
    for (const row of rows) {
      if (this.closed) return;
      if (row.manifest) listed.set(row.manifest, [...(listed.get(row.manifest) ?? []), row]);
      else this.#settle(row, await this.#check(row) ?? await this.#trash(row));
    }
    // A folder with a manifest: its entries go first, under the folder's lock, then the files.
    for (const [dir, list] of listed) {
      if (this.closed) return;
      try {
        await withExportLock(dir, () => this.#sweepListed(dir, list), { wait: LOCK_WAIT_MS });
      } catch (err) {
        for (const row of list) this.#settle(row, { state: 'pending', error: err.message });
      }
    }
  }

  async #sweepListed(dir, list) {
    const ready = [];
    for (const row of list) {
      const problem = await this.#check(row);
      if (problem && problem.state !== 'deleted') this.#settle(row, problem);
      else ready.push({ row, gone: Boolean(problem) });
    }
    if (!ready.length) return;
    const manifest = await readManifest(dir);
    if (manifest) {
      const items = { ...manifest.items };
      const superseded = { ...manifest.superseded };
      const keys = new Map([...Object.keys(items), ...Object.keys(superseded)].map((rel) => [rel.normalize('NFC'), rel]));
      let edited = false;
      for (const { row } of ready) {
        const rel = keys.get(relPosix(dir, row.path).normalize('NFC'));
        if (!rel) continue;
        delete items[rel];
        delete superseded[rel];
        edited = true;
      }
      if (edited) await writeManifest(dir, items, superseded);
    }
    const history = dir === this.config.archive?.root ? await History.open(dir) : null;
    try {
      for (const { row, gone } of ready) {
        const outcome = gone ? { state: 'deleted' } : await this.#trash(row);
        if (!gone && outcome.state === 'deleted') await history?.add({ event: 'file-deleted', path: relPosix(dir, row.path).normalize('NFC'), sha256: row.sha256 });
        this.#settle(row, outcome);
      }
    } finally {
      await history?.close();
    }
  }

  /** Why the file can't be deleted now ({ state, error }), { state: 'deleted' } if it's gone already, or null. */
  async #check(row) {
    try {
      if (!(await available(row.root))) return { state: 'pending', error: 'Its folder is not available (unplugged drive?)' };
      const stat = await fs.lstat(row.path).catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
      if (!stat) return { state: 'deleted' };
      if (!stat.isFile()) return { state: 'changed', error: 'No longer a file, so it stays' };
      if ((await digestFile(row.path)).sha256 !== row.sha256) return { state: 'changed', error: 'Changed since you deleted it, so it stays' };
      return null;
    } catch (err) {
      return { state: 'pending', error: err.message };
    }
  }

  async #trash(row) {
    try {
      await this.trash(row.path);
      return { state: 'deleted' };
    } catch (err) {
      return { state: 'pending', error: `Couldn't move it to the Trash: ${err.message}` };
    }
  }

  #settle(row, { state, error = null }) {
    this.library.q('UPDATE deleted_files SET state = ?, error = ?, at = ? WHERE id = ?').run(state, error, Date.now(), row.id);
    // Other content at its place now: that is a photo of its own again.
    if (state === 'changed') this.#rescan([row.path]);
  }

  /** Look again at the folders these files are in, so what's there is shown. */
  #rescan(files) {
    for (const source of this.library.sources()) {
      const dirs = [...new Set(files.filter((f) => isInside(f, source.path)).map((f) => path.dirname(f)))];
      if (dirs.length) this.indexer.scanFolders(source, dirs).catch((err) => this.indexer.error(source.path, err));
    }
  }

  // --- the Deleted list ----------------------------------------------------

  /** Photos on the Deleted list, newest first: each with its contents (by fingerprint), their files and what phones did. */
  list() {
    const rows = this.library.q('SELECT * FROM deletions WHERE cleared_at IS NULL ORDER BY deleted_at DESC, seq').all();
    const files = this.library.q('SELECT path, state, error, at FROM deleted_files WHERE sha256 = ? ORDER BY path');
    const reported = this.library.q('SELECT device_id, device_name AS name, state, at FROM deleted_on_devices WHERE sha256 = ?');
    // Phones that backed it up, and so have a copy unless they say otherwise.
    const holders = this.library.q(`SELECT DISTINCT d.id AS device_id, d.name FROM backup_uploads b JOIN devices d ON d.id = b.device_id
      WHERE b.sha256 = ? AND b.state = 'received'`);
    const photos = new Map();
    for (const r of rows) {
      const content = {
        sha256: r.sha256, filename: r.filename, kind: r.kind, bytes: r.bytes,
        files: files.all(r.sha256),
        devices: [...new Map([...holders.all(r.sha256).map((d) => [d.device_id, { ...d, state: 'waiting' }]),
          ...reported.all(r.sha256).map((d) => [d.device_id, d])]).values()],
      };
      const photo = photos.get(r.photo);
      if (photo) photo.contents.push(content);
      else photos.set(r.photo, { photo: r.photo, filename: r.filename, kind: r.kind, local_time: r.local_time, deleted_at: r.deleted_at, contents: [content] });
    }
    // The photo itself first, then its versions and clip.
    for (const p of photos.values()) {
      const own = p.contents.find((c) => c.sha256 === p.photo);
      if (own) Object.assign(p, { filename: own.filename, kind: own.kind, contents: [own, ...p.contents.filter((c) => c !== own)] });
    }
    return [...photos.values()];
  }

  /** How many photos are on the Deleted list, and how many of their files are still waiting to be deleted. */
  counts() {
    return { ...this.library.q(`SELECT (SELECT count(DISTINCT photo) FROM deletions WHERE cleared_at IS NULL) AS photos,
      (SELECT count(*) FROM deleted_files f JOIN deletions d ON d.sha256 = f.sha256 WHERE f.state = 'pending' AND d.cleared_at IS NULL) AS waiting`).get() };
  }

  /**
   * Clear photos (by the fingerprint of each; all of them without `photos`) from the Deleted list:
   * Photobox forgets them. A copy that is still there or turns up again is shown again, and phones
   * stop deleting theirs. Returns how many photos were cleared.
   */
  clear(photos = null) {
    if (photos !== null && (!Array.isArray(photos) || photos.length > 10_000 || !photos.every((p) => SHA256.test(p)))) throw fail(400, 'photos must be a list of fingerprints');
    const left = [];
    const cleared = this.library.tx(() => {
      const rows = this.library.q('SELECT sha256, photo FROM deletions WHERE cleared_at IS NULL AND (? IS NULL OR photo IN (SELECT value FROM json_each(?)))')
        .all(photos && ids(photos), photos && ids(photos));
      let seq = this.library.q('SELECT coalesce(max(seq), 0) AS n FROM deletions').get().n;
      for (const { sha256 } of rows) {
        left.push(...this.library.q("SELECT path FROM deleted_files WHERE sha256 = ? AND state <> 'deleted'").all(sha256).map((r) => r.path));
        this.library.q('UPDATE deletions SET cleared_at = ?, seq = ? WHERE sha256 = ?').run(Date.now(), ++seq, sha256);
        this.library.q('DELETE FROM deleted_files WHERE sha256 = ?').run(sha256);
        this.library.q('DELETE FROM deleted_on_devices WHERE sha256 = ?').run(sha256);
      }
      return new Set(rows.map((r) => r.photo)).size;
    });
    this.#rescan(left);
    return cleared;
  }

  // --- phones --------------------------------------------------------------

  /**
   * What changed on the Deleted list since `after` (a `seq` from an earlier answer), for a phone:
   * { deletions: [{ seq, sha256, deleted }], more }. `deleted: false` means it was cleared: keep it.
   */
  feed(after) {
    const since = Number.isSafeInteger(Number(after)) && Number(after) > 0 ? Number(after) : 0;
    const rows = this.library.q('SELECT seq, sha256, cleared_at IS NULL AS deleted FROM deletions WHERE seq > ? ORDER BY seq LIMIT 501').all(since);
    return { deletions: rows.slice(0, 500).map((r) => ({ seq: r.seq, sha256: r.sha256, deleted: Boolean(r.deleted) })), more: rows.length > 500 };
  }

  /** A phone says what it did with its copies of deleted content: [{ sha256, state: 'trashed' | 'kept' }]. */
  reported(device, items) {
    if (!Array.isArray(items) || items.length > 500 || !items.every((i) => SHA256.test(i?.sha256 ?? '') && ['trashed', 'kept'].includes(i.state))) {
      throw fail(400, 'items must be at most 500 of { sha256, state: "trashed" | "kept" }');
    }
    this.library.tx(() => {
      for (const { sha256, state } of items) {
        if (!this.library.isDeleted(sha256)) continue;
        this.library.q(`INSERT INTO deleted_on_devices (sha256, device_id, device_name, state, at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (sha256, device_id) DO UPDATE SET device_name = excluded.device_name, state = excluded.state, at = excluded.at`)
          .run(sha256, device.id, device.name, state, Date.now());
      }
    });
    return { ok: true };
  }
}
