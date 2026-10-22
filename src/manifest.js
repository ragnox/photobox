// photobox-export.json: what `photobox export` knows about every file it copied.
// export.js writes it; the indexer reads it back, so an exported folder added as a
// source keeps its albums, favorites, descriptions, people and dates.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST = 'photobox-export.json';

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_SOURCES = new Set(['exif', 'takeout', 'filename', 'upload', 'file']);

/** The manifest in `dir`, or null if there is none (or it isn't one of ours). */
export async function readManifest(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8'));
    return data?.version === 1 && data.items && typeof data.items === 'object' ? data : null;
  } catch {
    return null;
  }
}

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : []);
const coord = (n) => (Number.isFinite(n) ? n : null);

/** A manifest entry as sidecar metadata (the shape sidecarMeta returns, plus the resolved date and albums). */
export function manifestMeta(entry) {
  const takenAt = Date.parse(entry.takenAt);
  const dated = Number.isFinite(takenAt) && LOCAL_TIME.test(entry.localTime ?? '');
  return {
    fromManifest: true,
    title: typeof entry.originalName === 'string' ? entry.originalName.normalize('NFC') : null,
    takenAt: dated ? takenAt : null,
    localTime: dated ? entry.localTime : null,
    dateSource: DATE_SOURCES.has(entry.dateSource) ? entry.dateSource : 'takeout',
    uploadedAt: null,
    lat: coord(entry.lat) != null && coord(entry.lon) != null ? entry.lat : null,
    lon: coord(entry.lat) != null && coord(entry.lon) != null ? entry.lon : null,
    description: typeof entry.description === 'string' ? entry.description.trim() || null : null,
    favorite: entry.favorite === true,
    archived: entry.archived === true,
    trashed: false,
    people: strings(entry.people),
    camera: typeof entry.camera === 'string' ? entry.camera : null,
    albums: strings(entry.albums),
  };
}

/**
 * The manifest of one exported folder, to look files up by their path in it or,
 * for files moved or renamed since the export, by their content hash. Each item's
 * `key` changes whenever its entry does, so the indexer knows to read it again.
 */
export class ManifestIndex {
  constructor(root, data) {
    this.root = root;
    this.path = path.join(root, MANIFEST);
    this.byPath = new Map();
    this.byHash = new Map();
    for (const [rel, entry] of Object.entries(data.items)) {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') continue;
      const item = { entry, key: `${this.path}#${createHash('sha1').update(JSON.stringify(entry)).digest('hex').slice(0, 12)}` };
      this.byPath.set(rel.normalize('NFC'), item);
      if (!this.byHash.has(entry.hash)) this.byHash.set(entry.hash, item);
    }
  }

  covers(file) {
    const rel = path.relative(this.root, file);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  find(file) {
    return this.byPath.get(path.relative(this.root, file).split(path.sep).join('/').normalize('NFC')) ?? null;
  }
}
