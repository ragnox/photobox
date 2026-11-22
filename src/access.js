// macOS asks you before an app may read your Downloads, Desktop or Documents folder or a removable or
// network drive, and the read that asked waits until you answer. Watching a folder opens it on the main
// thread, so one unanswered question froze all of Photobox: nothing answered, phones included. So every
// folder is first read off the main thread, and only watched or scanned once that read has come back.
// A read still out after a few seconds is waiting - for you to answer on the Mac, or for a slow drive.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { isInside } from './files.js';

export const WAIT_MS = 3000;
const RETRY_MS = 10_000; // a refusal is the answer for this long; asked later, the folder is read again
const REFUSED = new Set(['EPERM', 'EACCES']);

/** Opens `dir` and reads one entry, off the main thread. */
export async function openFolder(dir) {
  const folder = await fs.promises.opendir(dir);
  try { await folder.read(); } finally { await folder.close(); }
}

/**
 * Which folders Photobox may read. Emits 'waiting' (dir) when a read is still out after `waitMs`,
 * 'readable' (dir, waited) when it comes back, 'refused' (dir, error) when it may not read it.
 */
export class FolderAccess extends EventEmitter {
  constructor({ open = openFolder, waitMs = WAIT_MS, retryMs = RETRY_MS } = {}) {
    super();
    this.open = open;
    this.waitMs = waitMs;
    this.retryMs = retryMs;
    this.folders = new Map(); // dir -> { state: 'checking' | 'waiting' | 'readable' | 'refused', check, waited }
  }

  /**
   * Resolves once `dir` was read: true if Photobox may read it, or it isn't there (what to do about a
   * missing folder is up to the caller), false if it may not. Asked again a while after a refusal it
   * reads again, since you may have allowed it in the meantime.
   */
  readable(dir) {
    return this.#entry(dir).check;
  }

  /** Like readable(), but null while the read is still out after `waitMs`. */
  answer(dir) {
    const entry = this.#entry(dir);
    return Promise.race([entry.check, entry.waited]);
  }

  /** Whether `file` is in a folder whose read hasn't come back: touching it now would wait too. */
  pending(file) {
    for (const [dir, entry] of this.folders) {
      if ((entry.state === 'checking' || entry.state === 'waiting') && (file === dir || isInside(file, dir))) return true;
    }
    return false;
  }

  /** Folders whose read is still out after `waitMs`. */
  waiting() {
    return [...this.folders].filter(([, e]) => e.state === 'waiting').map(([dir]) => dir);
  }

  #entry(dir) {
    const known = this.folders.get(dir);
    if (known && !(known.state === 'refused' && Date.now() - known.at >= this.retryMs)) return known;
    const entry = { state: 'checking' };
    entry.waited = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (entry.state !== 'checking') return;
        entry.state = 'waiting';
        this.emit('waiting', dir);
        resolve(null);
      }, this.waitMs);
      timer.unref?.();
      entry.check = this.open(dir).then(() => null, (err) => (REFUSED.has(err.code) ? err : null)).then((refusal) => {
        clearTimeout(timer);
        const waited = entry.state === 'waiting';
        entry.state = refusal ? 'refused' : 'readable';
        entry.at = Date.now();
        if (refusal) this.emit('refused', dir, refusal);
        else this.emit('readable', dir, waited);
        return !refusal;
      });
    });
    this.folders.set(dir, entry);
    return entry;
  }
}
