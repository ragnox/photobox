import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import { mediaKind } from './media.js';
import { isArchiveRoot, isSkipped, otherArchiveOf } from './files.js';
import { isInTakeout } from './takeout/sidecar.js';
import { MANIFEST } from './manifest.js';

const DEBOUNCE_MS = 1000;

const relevant = (file) => Boolean(mediaKind(file)) || file.toLowerCase().endsWith('.json');

/** Watches every source folder and feeds additions/removals to the indexer. */
export class SourceWatcher {
  constructor(library, indexer) {
    this.library = library;
    this.indexer = indexer;
    this.watchers = new Map();
    this.starting = new Set(); // sources whose folder is being read before it's watched
    this.pending = new Map();
    this.closed = false;
  }

  start() {
    for (const source of this.library.sources()) this.watchSource(source);
  }

  /** Watching opens the folder on the main thread, so only once a read of it has come back (see access.js). */
  watchSource(source) {
    if (source.managed === 'backup' || this.closed) return;
    if (this.watchers.has(source.id) || this.starting.has(source.id)) return;
    this.starting.add(source.id);
    this.indexer.access.readable(source.path).then((readable) => {
      if (!this.starting.delete(source.id) || !readable || this.closed) return;
      if (source.managed === 'archive') this.#watchArchive(source);
      else this.#watch(source);
    });
  }

  #watch(source) {
    const watcher = watch(source.path, {
      ignoreInitial: true,
      // The same folders a scan skips: hidden ones, Synology's @eaDir thumbnails, recycle bins, app libraries,
      // and an archive of its own inside the source.
      ignored: (file, stats) => isSkipped(path.basename(file)) || (stats?.isFile() && !relevant(file)) ||
        Boolean(stats?.isDirectory() && file !== source.path && isArchiveRoot(file)),
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    });
    watcher
      // A folder made an archive of its own after the watch began is left alone too.
      .on('add', (file) => otherArchiveOf(file, source.path) || this.#queue(source, 'changed', file))
      .on('change', (file) => otherArchiveOf(file, source.path) || this.#queue(source, 'changed', file))
      .on('unlink', (file) => this.#queue(source, 'removed', file))
      .on('unlinkDir', (dir) => {
        const prefix = dir + path.sep;
        for (const file of this.library.filePathsForSource(source.id)) {
          if (file.startsWith(prefix)) this.#queue(source, 'removed', file);
        }
      })
      .on('error', (err) => this.indexer.error(source.path, err));
    this.watchers.set(source.id, watcher);
  }

  /** An archive's photos are the files its manifest lists, so a new manifest is what to look for. */
  #watchArchive(source) {
    const watcher = watch(path.join(source.path, MANIFEST), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    });
    watcher
      .on('add', (file) => this.#queue(source, 'changed', file))
      .on('change', (file) => this.#queue(source, 'changed', file))
      .on('error', (err) => this.indexer.error(source.path, err));
    this.watchers.set(source.id, watcher);
  }

  async unwatch(sourceId) {
    this.starting.delete(sourceId);
    await this.watchers.get(sourceId)?.close();
    this.watchers.delete(sourceId);
  }

  async close() {
    this.closed = true;
    this.starting.clear();
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
  }

  #queue(source, type, file) {
    let batch = this.pending.get(source.id);
    if (!batch) {
      batch = { changed: new Set(), removed: new Set(), timer: null };
      this.pending.set(source.id, batch);
    }
    batch[type].add(file);
    clearTimeout(batch.timer);
    batch.timer = setTimeout(() => this.#flush(source), DEBOUNCE_MS);
  }

  #flush(source) {
    const batch = this.pending.get(source.id);
    this.pending.delete(source.id);
    if (!batch || !this.watchers.has(source.id)) return;
    // If the whole source vanished it was most likely unmounted, not emptied.
    const failed = (err) => this.indexer.error(source.path, err);
    if (batch.removed.size && fs.existsSync(source.path)) this.indexer.removePaths([...batch.removed]).catch(failed);
    if (!batch.changed.size) return;
    const dirs = [...new Set([...batch.changed].map((f) => path.dirname(f)))];
    // Inside a Takeout export a photo's sidecar can sit in another zip part, and an export
    // manifest describes files in every folder below it, so look at everything.
    if (dirs.some(isInTakeout) || [...batch.changed].some((f) => path.basename(f) === MANIFEST)) {
      this.indexer.scanSource(source).catch(failed);
    } else {
      this.indexer.scanFolders(source, dirs).catch(failed);
    }
  }
}
