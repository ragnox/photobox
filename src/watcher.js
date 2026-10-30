import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import { mediaKind } from './media.js';
import { isSkipped } from './files.js';
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
    this.pending = new Map();
  }

  start() {
    for (const source of this.library.sources()) this.watchSource(source);
  }

  watchSource(source) {
    if (source.managed === 'backup') return;
    if (this.watchers.has(source.id)) return;
    if (source.managed === 'archive') return this.#watchArchive(source);
    const watcher = watch(source.path, {
      ignoreInitial: true,
      // The same folders a scan skips: hidden ones, Synology's @eaDir thumbnails, recycle bins, app libraries.
      ignored: (file, stats) => isSkipped(path.basename(file)) || (stats?.isFile() && !relevant(file)),
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    });
    watcher
      .on('add', (file) => this.#queue(source, 'changed', file))
      .on('change', (file) => this.#queue(source, 'changed', file))
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
    await this.watchers.get(sourceId)?.close();
    this.watchers.delete(sourceId);
  }

  async close() {
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
