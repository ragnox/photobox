// photobox-export.json: what `photobox export` knows about every file it copied.
// export.js writes it; the indexer reads it back, so an exported folder added as a
// source keeps its albums, favorites, descriptions, people and dates.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATE_RANK } from './dates.js';
import { readJson, isInside, relPosix } from './files.js';

export const MANIFEST = 'photobox-export.json';

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** The manifest in `dir`, or null if there is none (or it isn't one of ours). */
export async function readManifest(dir) {
  const data = await readJson(path.join(dir, MANIFEST));
  return data?.version === 1 && data.items && typeof data.items === 'object' ? data : null;
}

const strings = (list) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : []);

/** A manifest entry as sidecar metadata: the shape sidecarMeta returns, plus the resolved date, camera and albums. */
export function manifestMeta(entry) {
  const takenAt = Date.parse(entry.takenAt);
  const dated = Number.isFinite(takenAt) && LOCAL_TIME.test(entry.localTime ?? '');
  const placed = Number.isFinite(entry.lat) && Number.isFinite(entry.lon);
  return {
    fromManifest: true,
    title: typeof entry.originalName === 'string' ? entry.originalName.normalize('NFC') : null,
    takenAt: dated ? takenAt : null,
    localTime: dated ? entry.localTime : null,
    dateSource: Object.hasOwn(DATE_RANK, entry.dateSource) ? entry.dateSource : 'takeout',
    lat: placed ? entry.lat : null,
    lon: placed ? entry.lon : null,
    description: typeof entry.description === 'string' ? entry.description.trim() || null : null,
    favorite: entry.favorite === true,
    archived: entry.archived === true,
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
    const file = path.join(root, MANIFEST);
    this.byPath = new Map();
    this.byHash = new Map();
    for (const [rel, entry] of Object.entries(data.items)) {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') continue;
      const item = { entry, key: `${file}#${createHash('sha1').update(JSON.stringify(entry)).digest('hex').slice(0, 12)}` };
      this.byPath.set(rel.normalize('NFC'), item);
      if (!this.byHash.has(entry.hash)) this.byHash.set(entry.hash, item);
    }
  }

  covers(file) {
    return isInside(file, this.root);
  }

  find(file) {
    return this.byPath.get(relPosix(this.root, file).normalize('NFC')) ?? null;
  }
}
