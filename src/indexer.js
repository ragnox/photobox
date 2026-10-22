import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mediaKind, isHidden } from './media.js';
import { readImageMeta, readVideoMeta } from './metadata.js';
import { makeThumbnail, imageSize, cachePath } from './thumbs.js';
import { formatLocal, localToInstant, dateFromFilename, zoneAt } from './dates.js';
import { SidecarIndex, classifyJson, albumTitle, sidecarMeta, takeoutFolderKey } from './takeout/sidecar.js';
import { MANIFEST, ManifestIndex, readManifest, manifestMeta } from './manifest.js';

const SKIP_DIRS = new Set(['node_modules', '@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information']);
// How much we trust each date source; better information replaces worse.
const DATE_RANK = { exif: 4, takeout: 4, filename: 2, upload: 1, file: 0 };
const HASH_CHUNK = 64 * 1024;

/** Fast content fingerprint: size + first and last 64 KB. Good enough to dedupe photo libraries. */
export async function quickHash(file, size) {
  const hash = createHash('sha1').update(String(size));
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(HASH_CHUNK, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > HASH_CHUNK) {
      const tail = Buffer.alloc(Math.min(HASH_CHUNK, size - HASH_CHUNK));
      await handle.read(tail, 0, tail.length, size - tail.length);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function isReadableDir(dir) {
  try {
    return (await fs.stat(dir)).isDirectory() && Boolean(await fs.readdir(dir));
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Sidecars and album names for the folders of one source, plus the manifests of
 * any `photobox export` folders in it. Folders are keyed so that
 * "takeout-001/Takeout/Google Photos/Trip" and "takeout-002/…/Trip" merge.
 */
class FolderContext {
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
    const type = classifyJson(data);
    const folder = this.folder(path.dirname(file));
    if (type === 'sidecar') folder.sidecars.add(file, data);
    else if (type === 'album') folder.album = albumTitle(data) ?? folder.album;
  }

  async addManifest(dir) {
    if (this.manifests.has(dir)) return;
    const data = await readManifest(dir);
    this.manifests.set(dir, data ? new ManifestIndex(dir, data) : null);
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

export class Indexer extends EventEmitter {
  constructor(library, config) {
    super();
    this.library = library;
    this.config = config;
    this.queue = Promise.resolve();
    // Hashes currently being imported, so parallel workers don't import duplicates twice.
    this.inflight = new Map();
    this.cancelled = new Set();
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
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  scanSource(source) {
    return this.enqueue(() => this.#scan(source));
  }

  /** Re-check specific folders of a source (used by the watcher). */
  scanFolders(source, dirs) {
    return this.enqueue(() => this.#scan(source, dirs));
  }

  removeSource(sourceId) {
    this.cancelled.add(sourceId);
    return this.enqueue(async () => {
      this.cancelled.delete(sourceId);
      await this.#deleteThumbs(this.library.removeSource(sourceId));
      this.changed();
    });
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
    const roots = onlyDirs ?? [source.path];
    if (onlyDirs) for (const dir of onlyDirs) await context.addManifestsAbove(dir, source.path);
    for (const root of roots) {
      const files = onlyDirs ? await this.#listDir(root) : walk(root);
      for await (const file of files) {
        if (file.toLowerCase().endsWith('.json')) await context.addJson(file);
        else if (mediaKind(file)) mediaFiles.push(file);
      }
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

    if (!this.cancelled.has(source.id)) {
      this.library.linkLivePhotos(source.id);
      if (!onlyDirs) this.library.markScanned(source.id);
    }
    const { added } = this.status;
    this.setStatus({ running: false, phase: 'idle', source: null, lastScan: { source: source.path, added, files: mediaFiles.length, ms: Date.now() - started } });
    if (added) this.changed();
    return { files: mediaFiles.length, added };
  }

  async *#listDir(dir) {
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isFile() && !isHidden(entry.name)) yield path.join(dir, entry.name);
      }
    } catch {
      // folder vanished
    }
  }

  /** Index one file. Returns true when it created a new media item. */
  async #indexFile(source, file, context) {
    const stat = await fs.stat(file);
    const { sidecar, album, manifest } = context.lookup(file);
    const existing = this.library.fileByPath(file);
    // Without a Takeout sidecar, an export manifest entry plays its part. Files moved or renamed
    // inside the export are found by content; an unchanged file still has its indexed content.
    let listed = sidecar || !manifest ? null : manifest.find(file);
    if (manifest && !sidecar && !listed && existing) listed = manifest.byHash.get(this.library.media(existing.media_id)?.hash) ?? null;
    let sidecarPath = sidecar?.entry.path ?? listed?.key ?? null;
    if (existing && existing.size === stat.size && existing.mtime === Math.floor(stat.mtimeMs) && existing.sidecar === sidecarPath) {
      return false;
    }

    const hash = await quickHash(file, stat.size);
    if (manifest && !sidecar && !listed) {
      listed = manifest.byHash.get(hash) ?? null;
      sidecarPath = listed?.key ?? null;
    }
    const sc = sidecar ? sidecarMeta(sidecar.entry.data) : listed ? manifestMeta(listed.entry) : null;
    if (sc?.trashed) {
      if (existing) await this.#deleteThumbs(this.library.removeFiles([file]));
      return false;
    }

    const kind = mediaKind(file);
    let media = this.library.mediaByHash(hash);
    if (!media && this.inflight.has(hash)) {
      await this.inflight.get(hash).catch(() => {});
      media = this.library.mediaByHash(hash);
    }
    let created = false;

    if (!media) {
      const importing = this.#importMedia(file, kind, hash, stat, sc, sidecar?.method);
      this.inflight.set(hash, importing);
      try {
        media = await importing;
      } finally {
        this.inflight.delete(hash);
      }
      created = true;
    } else if (sc && (DATE_RANK[sc.fromManifest ? sc.dateSource : 'takeout'] > DATE_RANK[media.date_source] || !this.library.hasSidecar(media.id) ||
        (sc.fromManifest && existing?.sidecar !== sidecarPath))) {
      // Same photo seen before without its sidecar (e.g. split zip parts), or its manifest entry changed: upgrade.
      this.library.updateMediaMeta(media.id, await this.#extract(file, kind, stat, sc, sidecar?.method));
    }

    const albumIds = [...new Set([album, ...(sc?.albums ?? [])].filter(Boolean))].map((name) => this.library.albumId(name));
    this.library.upsertFile({
      path: file, sourceId: source.id, mediaId: media.id, albumIds,
      size: stat.size, mtime: Math.floor(stat.mtimeMs), sidecar: sidecarPath,
    });
    // The file's content changed: the media it used to point at may be orphaned now.
    if (existing && existing.media_id !== media.id) await this.#deleteThumbs(this.library.pruneOrphans());
    return created;
  }

  async #extract(file, kind, stat, sc, sidecarMethod) {
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
    if (sc?.localTime) date = { takenAt: sc.takenAt, localTime: sc.localTime, dateSource: sc.dateSource };
    else if (info.date?.instant != null) date = { takenAt: info.date.instant, localTime: info.date.local ?? wallClock(info.date.instant), dateSource: 'exif' };
    else if (sc?.takenAt) date = { takenAt: sc.takenAt, localTime: info.date?.local ?? wallClock(sc.takenAt), dateSource: 'takeout' };
    else if (info.date) date = { takenAt: localToInstant(info.date.local), localTime: info.date.local, dateSource: 'exif' };
    else if (fromName) date = { takenAt: localToInstant(fromName), localTime: fromName, dateSource: 'filename' };
    else if (sc?.uploadedAt) date = { takenAt: sc.uploadedAt, localTime: wallClock(sc.uploadedAt), dateSource: 'upload' };
    else date = { takenAt: Math.floor(stat.mtimeMs), localTime: formatLocal(stat.mtimeMs), dateSource: 'file' };

    let { width, height } = info;
    if (kind === 'image' && !width) ({ width, height } = await imageSize(file));

    // Disk names can be truncated or sanitized; the sidecar title is the real name.
    const useTitle = sc?.title && (sc.fromManifest || sidecarMethod === 'title' || sidecarMethod === 'truncated');
    return {
      ...date,
      filename: useTitle ? sc.title : name,
      width: width ?? null,
      height: height ?? null,
      duration: info.duration ?? null,
      lat,
      lon,
      camera: info.camera ?? sc?.camera ?? null,
      description: sc?.description ?? null,
      people: sc?.people ?? [],
      favorite: sc?.favorite ?? false,
      archived: sc?.archived ?? false,
    };
  }

  async #importMedia(file, kind, hash, stat, sc, sidecarMethod) {
    const meta = await this.#extract(file, kind, stat, sc, sidecarMethod);
    let thumb = {};
    try {
      thumb = await makeThumbnail(file, kind, cachePath(this.config.thumbsDir, hash, '.webp'), { duration: meta.duration });
    } catch (err) {
      this.error(file, new Error(`thumbnail failed: ${err.message.split('\n')[0]}`));
    }
    const id = this.library.insertMedia({ ...meta, hash, kind, bytes: stat.size, thumbW: thumb.width, thumbH: thumb.height });
    return this.library.media(id);
  }

  async #deleteThumbs(hashes) {
    for (const hash of hashes) {
      await fs.rm(cachePath(this.config.thumbsDir, hash, '.webp'), { force: true });
      await fs.rm(cachePath(this.config.previewsDir, hash, '.jpg'), { force: true });
    }
  }
}
