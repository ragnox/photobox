import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { detectMediaKind, mediaKind } from './media.js';
import { quickHash, digestFile, walk, readJson, isInside } from './files.js';
import { readImageMeta, readVideoMeta } from './metadata.js';
import { makeThumbnail, imageSize, thumbPath, previewPath, differenceHash } from './thumbs.js';
import { DATE_RANK, formatLocal, localToInstant, dateFromFilename, zoneAt } from './dates.js';
import { SidecarIndex, classifyJson, albumTitle, sidecarMeta, takeoutFolderKey } from './takeout/sidecar.js';
import { MANIFEST, ManifestIndex, readManifest, manifestMeta } from './manifest.js';
import { shotKey, findVersions } from './versions.js';
import { safeRelative } from './export.js';

async function isReadableDir(dir) {
  try {
    await fs.readdir(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sidecars and album names for the folders of one source, plus the manifests of
 * any `photobox export` folders in it. Folders are keyed so that
 * "takeout-001/Takeout/Google Photos/Trip" and "takeout-002/…/Trip" merge.
 */
export class FolderContext {
  constructor() {
    this.folders = new Map();
    this.manifests = new Map();
  }

  folder(dir) {
    const key = takeoutFolderKey(dir);
    if (!this.folders.has(key)) this.folders.set(key, { sidecars: new SidecarIndex(), album: null });
    return this.folders.get(key);
  }

  async addJson(file) {
    if (path.basename(file) === MANIFEST) return this.addManifest(path.dirname(file));
    const data = await readJson(file);
    const type = classifyJson(data, path.basename(file));
    const folder = this.folder(path.dirname(file));
    if (type === 'sidecar') folder.sidecars.add(file, data);
    else if (type === 'album') folder.album = albumTitle(data, path.basename(path.dirname(file))) ?? folder.album;
  }

  async addManifest(dir) {
    if (!this.manifests.has(dir)) {
      const data = await readManifest(dir);
      this.manifests.set(dir, data ? new ManifestIndex(dir, data) : null);
    }
    return this.manifests.get(dir);
  }

  /** Rescans of single folders (from the watcher) need the manifest of the export they're in, further up. */
  async addManifestsAbove(dir, root) {
    for (let d = dir; ; d = path.dirname(d)) {
      await this.addManifest(d);
      if (d === root || path.dirname(d) === d) break;
    }
  }

  lookup(file) {
    const folder = this.folder(path.dirname(file));
    let manifest = null;
    for (const m of this.manifests.values()) {
      if (m?.covers(file) && (!manifest || m.root.length > manifest.root.length)) manifest = m;
    }
    return { sidecar: folder.sidecars.find(path.basename(file)), album: folder.album, manifest };
  }
}

/** Date, size, place and the rest for one media file; `sc` is what a sidecar or manifest said about it. */
export async function extractMeta(file, kind, stat, sc) {
  const info = kind === 'video' ? await readVideoMeta(file) : await readImageMeta(file);
  const name = path.basename(file).normalize('NFC');
  const fromName = dateFromFilename(name);

  const lat = info.lat ?? sc?.lat ?? null;
  const lon = info.lon ?? sc?.lon ?? null;
  // Wall clock for a bare instant: in the zone where it was taken, if we know the place.
  const zone = zoneAt(lat, lon);
  const wallClock = (ms) => formatLocal(ms, zone);

  let date;
  // An export manifest holds the date as it was worked out when the library was exported.
  if (sc?.localTime && !sc.fromUpload) date = { takenAt: sc.takenAt, localTime: sc.localTime, dateSource: sc.dateSource };
  else if (info.date?.instant != null) date = { takenAt: info.date.instant, localTime: info.date.local ?? wallClock(info.date.instant), dateSource: 'exif' };
  else if (sc?.fromUpload && sc.takenAt != null) date = { takenAt: sc.takenAt, localTime: info.date?.local ?? (zone ? wallClock(sc.takenAt) : sc.localTime ?? wallClock(sc.takenAt)), dateSource: 'capture' };
  else if (sc?.takenAt) date = { takenAt: sc.takenAt, localTime: info.date?.local ?? wallClock(sc.takenAt), dateSource: 'takeout' };
  else if (info.date) date = { takenAt: localToInstant(info.date.local), localTime: info.date.local, dateSource: 'exif' };
  else if (fromName) date = { takenAt: localToInstant(fromName), localTime: fromName, dateSource: 'filename' };
  else if (sc?.uploadedAt) date = { takenAt: sc.uploadedAt, localTime: wallClock(sc.uploadedAt), dateSource: 'upload' };
  else date = { takenAt: Math.floor(stat.mtimeMs), localTime: formatLocal(stat.mtimeMs), dateSource: 'file' };

  let { width, height } = info;
  if (kind === 'image' && !width) ({ width, height } = await imageSize(file));

  return {
    ...date,
    filename: sc?.title ?? name,
    width: width ?? null,
    height: height ?? null,
    duration: info.duration ?? null,
    lat,
    lon,
    // By its real name: an export's "IMG_1~2 (2).jpg" is still the edited copy "IMG_1~2.jpg".
    shotKey: shotKey({ kind, file: sc?.title ?? name, shot: info.shot, camera: info.camera, width, height, recordedAt: kind === 'video' ? info.date?.instant : null }),
    camera: info.camera ?? sc?.camera ?? null,
    description: sc?.description ?? null,
    people: sc?.people ?? [],
    favorite: sc?.favorite ?? false,
    archived: sc?.archived ?? false,
  };
}

export class Indexer extends EventEmitter {
  #albumsChanged = false;

  constructor(library, config) {
    super();
    this.library = library;
    this.config = config;
    this.queue = Promise.resolve();
    // Hashes currently being imported, so parallel workers don't import duplicates twice.
    this.inflight = new Map();
    this.cancelled = new Set();
    this.needsPrune = false;
    this.status = { running: false, phase: 'idle', source: null, total: 0, done: 0, added: 0, errors: [] };
    // Bumped whenever the visible library changes, so clients know when to refresh.
    this.version = 0;
  }

  changed() {
    this.version++;
    this.emit('changed', this.version);
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', this.status);
  }

  error(file, err) {
    this.status.errors = [{ file, message: err.message, at: Date.now() }, ...this.status.errors].slice(0, 50);
    this.emit('status', this.status);
  }

  /** Serialize scans so the watcher and manual rescans never overlap. */
  enqueue(job) {
    const next = this.queue.then(job);
    this.queue = next.catch(() => {});
    return next;
  }

  scanSource(source) {
    if (source.managed === 'backup') return Promise.resolve({ files: 0, added: 0 });
    return this.enqueue(() => this.#scan(source));
  }

  /** Re-check specific folders of a source (used by the watcher). */
  scanFolders(source, dirs) {
    if (source.managed === 'backup') return Promise.resolve({ files: 0, added: 0 });
    return this.enqueue(() => this.#scan(source, dirs));
  }

  /** Only verified upload records admit files from a managed inbox. */
  indexUpload(source, file, upload) {
    return this.enqueue(async () => {
      let created;
      try { created = await this.#indexFile(source, file, new FolderContext(), upload); }
      finally { await this.#prunePending(); }
      this.library.linkLivePhotos(source.id);
      if (this.#resolveVersions() || created) this.changed();
      const indexed = this.library.fileByPath(file);
      if (indexed?.sha256 !== upload.sha256) throw new Error('Upload was not indexed with its verified identity');
      return this.library.media(indexed.media_id);
    });
  }

  async #prunePending() {
    if (!this.needsPrune) return;
    this.needsPrune = false;
    await this.#deleteThumbs(this.library.pruneOrphans());
  }

  async #identityLock(key, fn) {
    const previous = this.inflight.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(fn);
    this.inflight.set(key, job);
    try { return await job; } finally {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    }
  }

  /** Upgrade legacy cache keys only after reading actual content, never by sample alone. */
  async #findMedia(file, quick, identity) {
    let media = this.library.mediaBySha256(identity.sha256);
    if (media) return media;
    for (const legacy of this.library.q('SELECT * FROM media WHERE quick_hash = ? AND sha256 IS NULL').all(quick)) {
      for (const { path: candidate } of this.library.q('SELECT path FROM files WHERE media_id = ? ORDER BY path').all(legacy.id)) {
        let verified;
        try {
          verified = candidate === file ? identity : await digestFile(candidate);
          if (candidate !== file && await quickHash(candidate, verified.size) !== quick) continue;
        } catch { continue; } // Offline/changed legacy sources cannot prove identity.
        media = this.library.mediaBySha256(verified.sha256);
        if (!media) {
          this.library.q('UPDATE media SET sha256 = ? WHERE id = ?').run(verified.sha256, legacy.id);
          media = this.library.media(legacy.id);
        }
        if (verified.sha256 === identity.sha256) return media;
        break; // This legacy cache key belongs to different bytes; keep it intact.
      }
    }
    return null;
  }

  removeSource(sourceId) {
    this.cancelled.add(sourceId);
    return this.enqueue(async () => {
      this.cancelled.delete(sourceId);
      await this.#deleteThumbs(this.library.removeSource(sourceId));
      this.#resolveVersions();
      this.changed();
    });
  }

  /** The user says these two are different photos: show both again. */
  keepApart(id1, id2) {
    return this.enqueue(async () => {
      if (!this.library.keepApart(id1, id2)) return false;
      if (this.#resolveVersions()) this.changed();
      return true;
    });
  }

  /** Which items are versions of one shot, among everything in the library. Returns whether that changed. */
  #resolveVersions() {
    return this.library.applyVersions(findVersions(this.library.versionCandidates(), this.library.separatePairs()));
  }

  /** Shot keys and thumbnail hashes for items indexed before Photobox compared versions. */
  async #backfillVersions() {
    const todo = this.library.q('SELECT id, hash, kind, thumb_w, shot_key, dhash FROM media WHERE shot_key IS NULL OR dhash IS NULL').all();
    if (!todo.length) return;
    this.setStatus({ running: true, phase: 'comparing', total: todo.length, done: 0 });
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const m = todo[next++];
        try {
          const key = m.shot_key ?? await this.#readShotKey(m);
          const dhash = m.dhash ?? (m.thumb_w ? await differenceHash(thumbPath(this.config, m.hash)).catch(() => '') : '');
          this.library.q('UPDATE media SET shot_key = ?, dhash = ? WHERE id = ?').run(key, dhash, m.id);
        } catch (err) {
          this.error(this.library.primaryPath(m.id) ?? m.hash, err);
        }
        this.status.done++;
        if (this.status.done % 25 === 0) this.emit('status', this.status);
      }
    };
    await Promise.all(Array.from({ length: this.config.concurrency }, worker));
  }

  /** The shot key from the first of an item's files that is there; null (try again later) if none is. */
  async #readShotKey(m) {
    for (const { path: file } of this.library.q('SELECT path FROM files WHERE media_id = ? ORDER BY length(path), path').all(m.id)) {
      if (!(await fs.stat(file).catch(() => null))?.isFile()) continue;
      const info = m.kind === 'video' ? await readVideoMeta(file) : await readImageMeta(file);
      let { width, height } = info;
      if (m.kind === 'image' && !width) ({ width, height } = await imageSize(file));
      return shotKey({ kind: m.kind, file, shot: info.shot, camera: info.camera, width, height, recordedAt: m.kind === 'video' ? info.date?.instant : null });
    }
    return null;
  }

  removePaths(paths) {
    return this.enqueue(async () => {
      const hashes = this.library.removeFiles(paths);
      await this.#deleteThumbs(hashes);
      if (hashes.length) this.changed();
    });
  }

  async #scan(source, onlyDirs = null) {
    const started = Date.now();
    // An unplugged drive looks exactly like "every file was deleted" - don't fall for it.
    if (!(await isReadableDir(source.path))) {
      this.error(source.path, new Error('Folder is not available (unplugged drive?) - skipped'));
      return { files: 0, added: 0, offline: true };
    }
    this.setStatus({ running: true, phase: 'scanning', source: source.path, total: 0, done: 0, added: 0 });
    const context = new FolderContext();
    const mediaFiles = [];
    const archive = source.managed === 'archive';
    if (archive) {
      // An archive's own photos are the files its manifest lists: a sync folder or an app's
      // library inside it is not one of them. A changed manifest means a look at all of them.
      onlyDirs = null;
      const manifest = await context.addManifest(source.path);
      for (const rel of manifest?.paths ?? []) {
        if (safeRelative(rel) && mediaKind(rel)) mediaFiles.push(path.join(source.path, ...rel.split('/')));
      }
    } else {
      if (onlyDirs) for (const dir of onlyDirs) await context.addManifestsAbove(dir, source.path);
      for (const root of onlyDirs ?? [source.path]) {
        for await (const file of walk(root, {
          recursive: !onlyDirs,
          exclude: (file) => file === this.config.dataDir || isInside(file, this.config.dataDir),
        })) {
          if (file.toLowerCase().endsWith('.json')) await context.addJson(file);
          else if (await detectMediaKind(file)) mediaFiles.push(file);
        }
      }
    }

    // On Linux an unmounted drive's mount point is an empty, readable folder: same trap.
    if (!onlyDirs && !mediaFiles.length && this.library.filePathsForSource(source.id).length) {
      this.setStatus({ running: false, phase: 'idle', source: null });
      this.error(source.path, new Error(archive
        ? `The archive lists no photos (is its ${MANIFEST} gone?), but Photobox knows photos in it - skipped`
        : 'Folder is empty, but Photobox knows photos in it (unmounted drive?) - skipped'));
      return { files: 0, added: 0, offline: true };
    }

    // Files that disappeared since the last full scan.
    if (!onlyDirs) {
      const seen = new Set(mediaFiles);
      const gone = this.library.filePathsForSource(source.id).filter((p) => !seen.has(p));
      if (gone.length) await this.#deleteThumbs(this.library.removeFiles(gone));
    }

    this.setStatus({ phase: 'indexing', total: mediaFiles.length });
    let next = 0;
    const worker = async () => {
      while (next < mediaFiles.length && !this.cancelled.has(source.id)) {
        const file = mediaFiles[next++];
        try {
          if (await this.#indexFile(source, file, context)) this.status.added++;
        } catch (err) {
          this.error(file, err);
        }
        this.status.done++;
        if (this.status.done % 25 === 0) this.emit('status', this.status);
      }
    };
    await Promise.all(Array.from({ length: this.config.concurrency }, worker));
    await this.#prunePending();

    let versionsChanged = false;
    if (!this.cancelled.has(source.id)) {
      this.library.linkLivePhotos(source.id);
      if (!onlyDirs) this.library.markScanned(source.id);
      await this.#backfillVersions();
      versionsChanged = this.#resolveVersions();
    }
    const { added } = this.status;
    this.setStatus({ running: false, phase: 'idle', source: null, lastScan: { source: source.path, added, files: mediaFiles.length, ms: Date.now() - started } });
    if (added || this.#albumsChanged || versionsChanged) this.changed();
    this.#albumsChanged = false;
    return { files: mediaFiles.length, added };
  }

  /** Index one file. Returns true when it created a new media item. */
  async #indexFile(source, file, context, upload = null) {
    const stat = await fs.stat(file);
    const stamps = await fs.stat(file, { bigint: true });
    const { sidecar, album, manifest } = context.lookup(file);
    const existing = this.library.fileByPath(file);
    // Without a Takeout sidecar, an export manifest entry plays its part: found by path, or by
    // content for files moved or renamed inside the export (an unchanged file keeps its indexed hash).
    const exported = sidecar ? null : manifest;
    const byHash = (hash) => (hash && exported?.byHash.get(hash)) || null;
    let listed = exported ? exported.find(file) ?? byHash(existing && this.library.media(existing.media_id)?.hash) : null;
    let sidecarPath = sidecar?.entry.path ?? listed?.key ?? null;
    const albumIds = (meta) => [...new Set([album, ...(meta?.albums ?? [])].filter(Boolean))].map((name) => this.library.albumId(name, source.id));
    if (!upload && existing?.sha256 && existing.size === stat.size &&
        existing.mtime_ns === String(stamps.mtimeNs) && existing.ctime_ns === String(stamps.ctimeNs) && existing.sidecar === sidecarPath) {
      // The file is as it was, but its albums may not be (an album Photobox learned to read later).
      const ids = albumIds(listed && manifestMeta(listed.entry));
      if (this.library.setFileAlbums(existing.id, ids)) this.#albumsChanged = true;
      return false;
    }

    const identity = await digestFile(file);
    stat.size = identity.size;
    stat.mtimeMs = identity.mtimeMs;
    if (upload && (identity.sha256 !== upload.sha256 || identity.size !== upload.size)) throw new Error('Inbox original failed SHA-256 verification');
    const quick = await quickHash(file, identity.size);
    if (listed?.entry.sha256 && listed.entry.sha256 !== identity.sha256) listed = null;
    if (exported && !listed) {
      listed = exported.bySha256.get(identity.sha256) ?? byHash(quick);
      if (listed?.entry.sha256 && listed.entry.sha256 !== identity.sha256) listed = null;
      sidecarPath = listed?.key ?? null;
    }
    const sc = upload ? {
      fromUpload: true, title: upload.filename.normalize('NFC'),
      takenAt: upload.captured_at ? Date.parse(upload.captured_at) : null,
      localTime: upload.captured_at ? upload.captured_at.slice(0, 19).replace('T', ' ') : null,
      uploadedAt: upload.created_at,
    } : sidecar ? sidecarMeta(sidecar.entry.data) : listed ? manifestMeta(listed.entry) : null;
    if (upload) sidecarPath = `backup:${upload.id}:${upload.sha256}:${upload.captured_at ?? ''}`;
    // Disk names can be truncated or sanitized; then the sidecar's title is the real name.
    if (sidecar && sidecar.method !== 'title' && sidecar.method !== 'truncated') sc.title = null;
    if (sc?.trashed) {
      if (existing) {
        this.library.q('DELETE FROM files WHERE path = ?').run(file);
        this.needsPrune = true;
      }
      return false;
    }

    const kind = await detectMediaKind(file);
    return this.#identityLock(quick, async () => {
      let media = await this.#findMedia(file, quick, identity);
      let created = false;

      if (!media) {
        const cacheKey = this.library.mediaByHash(quick) ? `${quick}-${identity.sha256}` : quick;
        media = await this.#importMedia(file, kind, cacheKey, stat, sc, quick, identity.sha256);
        created = true;
      } else if (sc) {
        // An upload without a capture timestamp must not replace a stronger date.
        const rank = sc.fromManifest ? sc.dateSource : sc.fromUpload ? (sc.takenAt != null ? 'capture' : 'upload') : 'takeout';
        const betterDate = DATE_RANK[rank] > DATE_RANK[media.date_source];
        const entryChanged = sc.fromManifest && existing?.sidecar !== sidecarPath;
        if (betterDate || entryChanged || (!sc.fromUpload && !this.library.hasSidecar(media.id))) {
          const meta = await extractMeta(file, kind, stat, sc);
          // A manifest's date replaces only a worse one, and the name goes with it: the archive's
          // sorted copy of a photo dated by its own file doesn't undo a Google sidecar's exact time.
          if (sc.fromManifest && !betterDate) Object.assign(meta, { filename: media.filename, takenAt: media.taken_at, localTime: media.local_time, dateSource: media.date_source });
          this.library.updateMediaMeta(media.id, meta);
        }
      }

      const after = await fs.stat(file, { bigint: true });
      if (String(after.mtimeNs) !== identity.mtimeNs || String(after.ctimeNs) !== identity.ctimeNs || Number(after.size) !== identity.size) {
        this.needsPrune ||= created;
        throw new Error('File changed while indexing');
      }
      if (existing && existing.media_id !== media.id) {
        const old = this.library.media(existing.media_id);
        if (old?.favorite) this.library.setFavorite(media.id, true);
      }

      this.library.upsertFile({
        path: file, sourceId: source.id, mediaId: media.id, albumIds: albumIds(sc),
        size: stat.size, mtime: Math.floor(stat.mtimeMs), sidecar: sidecarPath,
        sha256: identity.sha256, mtimeNs: identity.mtimeNs, ctimeNs: identity.ctimeNs,
      });
      // Prune only after all workers finish, so another worker's new media row
      // cannot be removed between its insert and its file association.
      if (existing && existing.media_id !== media.id) this.needsPrune = true;
      return created;
    });
  }

  async #importMedia(file, kind, hash, stat, sc, quickHash, sha256) {
    const meta = await extractMeta(file, kind, stat, sc);
    let thumb = {};
    try {
      thumb = await makeThumbnail(file, kind, thumbPath(this.config, hash), { duration: meta.duration });
    } catch (err) {
      this.error(file, new Error(`thumbnail failed: ${err.message.split('\n')[0]}`));
    }
    const dhash = thumb.width ? await differenceHash(thumbPath(this.config, hash)).catch(() => '') : '';
    const id = this.library.insertMedia({ ...meta, hash, sha256, quickHash, kind, bytes: stat.size, thumbW: thumb.width, thumbH: thumb.height, dhash });
    return this.library.media(id);
  }

  async #deleteThumbs(hashes) {
    for (const hash of hashes) {
      await fs.rm(thumbPath(this.config, hash), { force: true });
      await fs.rm(previewPath(this.config, hash), { force: true });
    }
  }
}
