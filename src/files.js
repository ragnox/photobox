// File helpers shared by the indexer, the export, the manifest and the watcher:
// which names to skip, walking folders, the content fingerprint, small path utilities.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Folders that hold system or app clutter, never photos: Synology thumbnails, recycle bins, ...
const SKIP_DIRS = new Set(['node_modules', '@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information']);
// Photo-app libraries (Apple Photos, iPhoto, Aperture) and app bundles: other apps' internals,
// full of thumbnails and renders. Their originals would be a source of their own.
const SKIP_BUNDLES = /\.(photoslibrary|photolibrary|migratedphotolibrary|aplibrary|app)$/i;
const HASH_CHUNK = 64 * 1024;

/** Hidden files and folders, clutter folders and app libraries: never looked at. */
export const isSkipped = (name) => name.startsWith('.') || SKIP_DIRS.has(name) || SKIP_BUNDLES.test(name);

/** Sampled candidate/cache hint: never use this as proof of identical content. */
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

export async function syncDirectory(dir) {
  const handle = await fs.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Full content identity of a stable, regular file, with high-resolution change stamps. */
export async function digestFile(file, flush = false, onProgress = null) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Not a regular file');
    const hash = createHash('sha256');
    let done = 0;
    onProgress?.(done, Number(before.size));
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      done += chunk.length;
      onProgress?.(done, Number(before.size));
    }
    if (flush) await handle.sync();
    const after = await handle.stat({ bigint: true });
    const named = await fs.stat(file, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        named.dev !== after.dev || named.ino !== after.ino || named.size !== after.size ||
        named.mtimeNs !== after.mtimeNs || named.ctimeNs !== after.ctimeNs) {
      throw Object.assign(new Error('File changed during verification'), { status: 409, expose: true });
    }
    return {
      sha256: hash.digest('hex'), size: Number(after.size),
      mtimeNs: String(after.mtimeNs), ctimeNs: String(after.ctimeNs),
      mtimeMs: Number(after.mtimeNs) / 1e6,
    };
  } finally {
    await handle.close();
  }
}

/** The files in `dir`, and with `recursive` in every folder below it. A folder that can't be read yields nothing. */
export async function* walk(dir, { recursive = true, exclude = () => false } = {}) {
  if (exclude(dir)) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (isSkipped(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (exclude(full)) continue;
    if (entry.isDirectory()) {
      if (recursive) yield* walk(full, { exclude });
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
