// Archives: a folder of photos that keeps its own Photobox data in <archive>/.photobox/, the
// way a git repository keeps .git. Photobox finds the archive by walking up from a folder, and
// keeps each archive's rebuildable cache apart in the home folder. See docs/archives.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isInside } from './files.js';

export const ARCHIVE_DIR = '.photobox';
const ARCHIVE_FILE = 'archive.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const archiveFile = (root) => path.join(root, ARCHIVE_DIR, ARCHIVE_FILE);

/** The archive whose root is `root`: { root, id, createdAt }, or null if `root` isn't one. */
export function readArchive(root) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(archiveFile(root), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw new Error(`Cannot read the archive file ${archiveFile(root)}: ${err.message}`);
  }
  if (data?.version !== 1 || !UUID.test(data.id)) throw new Error(`Not a Photobox archive file: ${archiveFile(root)}`);
  return { root, id: data.id, createdAt: typeof data.createdAt === 'string' ? data.createdAt : null };
}

/** The nearest archive at or above `dir`, the way git finds .git; null outside any archive. */
export function findArchive(dir) {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const archive = readArchive(current);
    if (archive) return archive;
    if (path.dirname(current) === current) return null;
  }
}

/**
 * Make `folder` an archive: `.photobox/archive.json` with a random id that copies keep.
 * Refuses a folder already in an archive, the home folder (its `.photobox` is Photobox's own
 * data), a disk's root, and Photobox's data folder.
 */
export function initArchive(folder, { dataDir, home = os.homedir() } = {}) {
  const root = path.resolve(folder);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${root}`);
  const existing = findArchive(root);
  if (existing) {
    throw new Error(existing.root === root ? `${root} is already an archive` : `${root} is inside the archive at ${existing.root}`);
  }
  if (root === path.resolve(home)) throw new Error('The home folder itself can\'t be an archive - choose a folder in it, like ~/Pictures');
  if (path.dirname(root) === root) throw new Error('A disk\'s root can\'t be an archive - choose a folder on it');
  if (dataDir && (root === path.resolve(dataDir) || isInside(root, dataDir) || isInside(dataDir, root))) {
    throw new Error(`An archive can't hold Photobox's own data folder (${dataDir}) or be inside it`);
  }
  fs.mkdirSync(path.join(root, ARCHIVE_DIR), { recursive: true });
  const archive = { version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  fs.writeFileSync(archiveFile(root), `${JSON.stringify(archive, null, 2)}\n`, { flag: 'wx' });
  return readArchive(root);
}
