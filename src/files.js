// File helpers shared by the indexer, the export, the manifest and the watcher:
// which names to skip, walking folders, the content fingerprint, small path utilities.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Folders that hold system or app clutter, never photos: Synology thumbnails, recycle bins, ...
const SKIP_DIRS = new Set(['node_modules', '@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information']);
const HASH_CHUNK = 64 * 1024;

/** Hidden files and folders, and clutter folders: never looked at. */
export const isSkipped = (name) => name.startsWith('.') || SKIP_DIRS.has(name);

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

/** The files in `dir`, and with `recursive` in every folder below it. A folder that can't be read yields nothing. */
export async function* walk(dir, { recursive = true } = {}) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isSkipped(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export async function statOrNull(file) {
  try {
    return await fs.stat(file);
  } catch {
    return null;
  }
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Is `file` somewhere below `dir` (and not `dir` itself)? */
export function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `file` relative to `root`, with forward slashes on every platform. */
export const relPosix = (root, file) => path.relative(root, file).split(path.sep).join('/');
