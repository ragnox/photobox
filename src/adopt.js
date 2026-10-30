// `photobox adopt`: an archive takes over the library Photobox kept in its data folder before
// archives existed - the sources and their names, favorites, versions, paired phones, backup
// receipts and thumbnails - so nothing is indexed or paired again. That library stays as it was.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Library } from './db.js';

/**
 * Make the library in `config.dataDir` the library of `config.archive`. Refuses when the archive's
 * library has sources or paired devices of its own; what it knows about the archive's own photos
 * is a cache, indexed again by the next scan. Returns { sources, photos, videos, devices }.
 */
export function adoptLibrary(config) {
  if (!config.archive) throw new Error('photobox adopt works in an archive - make one with photobox init <folder>');
  const from = path.join(config.dataDir, 'library.db');
  if (!fs.existsSync(from)) throw new Error(`There is no library in ${config.dataDir} to adopt`);
  const current = new Library(config.dbPath);
  try {
    const sources = current.sources().filter((s) => s.managed !== 'archive').length;
    const devices = current.devices().length;
    if (sources || devices) {
      const has = [sources && `${sources} source${sources === 1 ? '' : 's'}`, devices && `${devices} paired device${devices === 1 ? '' : 's'}`].filter(Boolean);
      throw new Error(`This archive's library has ${has.join(' and ')} of its own - adopting would replace them`);
    }
  } finally {
    current.close();
  }

  // VACUUM INTO makes a consistent copy, even while a running Photobox writes to that library.
  const partial = `${config.dbPath}.adopting`;
  fs.rmSync(partial, { force: true });
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(partial);
  } finally {
    db.close();
  }
  for (const suffix of ['-wal', '-shm', '']) fs.rmSync(`${config.dbPath}${suffix}`, { force: true });
  fs.renameSync(partial, config.dbPath);
  // Thumbnails and previews are named by content, so the copies fit the adopted library.
  for (const [dir, to] of [['thumbs', config.thumbsDir], ['previews', config.previewsDir]]) {
    const cached = path.join(config.dataDir, dir);
    if (fs.existsSync(cached)) fs.cpSync(cached, to, { recursive: true, force: false });
  }

  const library = new Library(config.dbPath);
  try {
    library.archiveSource(config.archive.root);
    const { photos, videos } = library.stats();
    return { sources: library.sources().filter((s) => s.managed !== 'archive'), photos, videos, devices: library.devices().length };
  } finally {
    library.close();
  }
}
