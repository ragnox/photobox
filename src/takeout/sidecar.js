// Google Takeout writes one JSON "sidecar" next to each photo, but the name
// mapping between photo and sidecar is anything but 1:1:
//
//   IMG_1.jpg              -> IMG_1.jpg.json  |  IMG_1.jpg.supplemental-metadata.json
//   IMG_1(1).jpg           -> IMG_1.jpg(1).json  |  IMG_1.jpg.supplemental-metadata(1).json
//   IMG_1-edited.jpg       -> IMG_1.jpg.json   (suffix is localized: -bearbeitet, -modifié, ...)
//   very long names        -> sidecar name cut at ~51 chars: "…Some Very Long Appl.json", "….jpg.supp.json"
//   IMG_1.MP4 (live photo) -> IMG_1.HEIC.json
//   title field            -> the original name, even when the file on disk was renamed/sanitized
//
// On top of that, a photo and its sidecar can land in different zip parts.
// SidecarIndex resolves all of these; it is pure (no I/O) so it is easy to test.

import path from 'node:path';
import { MEDIA_EXT } from '../media.js';

const SUPPLEMENTAL = '.supplemental-metadata';
// Shortest name we trust for prefix matching of truncated sidecar names.
const MIN_TRUNCATED = 20;

export const EDITED_SUFFIXES = [
  '-edited', '-effects', '-smile', '-mix', '-collage', '-animation',
  '-bearbeitet', '-modifié', '-modificato', '-editado', '-ha editado', '-editat',
  '-bewerkt', '-redigerad', '-redigeret', '-redigert', '-muokattu', '-edytowane',
  '-upraveno', '-upravené', '-szerkesztett', '-düzenlendi', '-изменено', '-編集済み',
  '-已编辑', '-已編輯', '-편집됨',
];

const nfc = (s) => s.normalize('NFC');
// Case-, normalization- and punctuation-insensitive form, used as a fallback key.
const loose = (s) => nfc(s).toLowerCase().replace(/[^\p{L}\p{N}.]+/gu, '_');
const key = (name, counter) => `${name}\u0000${counter ?? ''}`;

function stripMediaExt(name) {
  const ext = path.extname(name).toLowerCase();
  return MEDIA_EXT.has(ext) ? name.slice(0, -ext.length) : name;
}

function splitCounter(stem) {
  const m = stem.match(/^(.*)\((\d+)\)$/s);
  return m ? { stem: m[1], counter: Number(m[2]) } : { stem, counter: null };
}

function stripEdited(stem) {
  const lower = nfc(stem).toLowerCase();
  for (const suffix of EDITED_SUFFIXES) {
    if (lower.endsWith(suffix)) return stem.slice(0, stem.length - suffix.length);
  }
  return stem;
}

/** What kind of JSON is this? 'sidecar' (per photo), 'album' (album metadata) or null. */
export function classifyJson(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.albumData) return 'album';
  if (data.photoTakenTime || data.creationTime) return 'sidecar';
  if (typeof data.title === 'string' && ('access' in data || 'date' in data || 'description' in data)) {
    return 'album';
  }
  return null;
}

export function albumTitle(data) {
  return (data.albumData ?? data).title || null;
}

/**
 * Parse a sidecar file name into the (possibly truncated) media name it describes
 * and the duplicate counter Google moved behind the extension.
 *   "IMG_1.jpg.supplemental-metadata(2).json" -> { stem: "IMG_1.jpg", counter: 2 }
 *   "Screenshot_…_Some Very Long Appl.json"   -> { stem: "Screenshot_…_Some Very Long Appl", counter: null }
 */
export function parseSidecarName(jsonName) {
  const { stem: raw, counter } = splitCounter(nfc(jsonName).replace(/\.json$/i, ''));
  let stem = raw;
  const dot = stem.lastIndexOf('.');
  // ".supplemental-metadata" gets truncated anywhere: ".supplemental-met", ".supp", ".s", "."
  if (dot > 0 && SUPPLEMENTAL.startsWith(stem.slice(dot).toLowerCase())) stem = stem.slice(0, dot);
  return { stem, counter };
}

/**
 * Names under which Google may have filed the sidecar for a media file.
 *   "IMG_1(1)-edited.jpg" -> [{ base: "IMG_1(1)-edited.jpg"... }, { base: "IMG_1.jpg", counter: 1 }]
 */
export function mediaNameVariants(mediaName) {
  const name = nfc(mediaName);
  const ext = path.extname(name);
  const { stem, counter } = splitCounter(ext ? name.slice(0, -ext.length) : name);
  const variants = [{ base: stem + ext, counter }];
  const unedited = stripEdited(stem);
  if (unedited !== stem) {
    const inner = splitCounter(unedited);
    variants.push({ base: inner.stem + ext, counter: counter ?? inner.counter });
  }
  return variants;
}

export class SidecarIndex {
  constructor() {
    this.entries = [];
    this.exact = new Map();
    this.loose = new Map();
    this.titles = new Map();
  }

  get size() {
    return this.entries.length;
  }

  add(jsonPath, data) {
    const { stem, counter } = parseSidecarName(path.basename(jsonPath));
    const entry = { path: jsonPath, data, stem, counter, looseStem: loose(stem) };
    this.entries.push(entry);
    if (!this.exact.has(key(stem, counter))) this.exact.set(key(stem, counter), entry);
    if (!this.loose.has(key(entry.looseStem, counter))) this.loose.set(key(entry.looseStem, counter), entry);
    if (typeof data.title === 'string') {
      const t = loose(data.title);
      if (!this.titles.has(t)) this.titles.set(t, []);
      this.titles.get(t).push(entry);
    }
    return entry;
  }

  /**
   * Find the sidecar for a media file name. Returns { entry, method } or null.
   * method 'partner' means the sidecar belongs to a sibling with the same name but
   * another extension (live photo video, or a converted file) - its date and
   * location apply, but its title does not.
   */
  find(mediaName) {
    const variants = mediaNameVariants(mediaName);

    for (const { base, counter } of variants) {
      const hit = this.exact.get(key(base, counter)) ?? this.loose.get(key(loose(base), counter));
      if (hit) return { entry: hit, method: 'name' };
    }

    for (const { base, counter } of variants) {
      const hits = (this.titles.get(loose(base)) ?? []).filter((e) => e.counter === counter);
      if (hits.length === 1) return { entry: hits[0], method: 'title' };
    }

    // Truncated names: one name is a prefix of the other once extensions are gone
    // (the sidecar name was cut, and sometimes the media name too).
    let best = null;
    for (const { base, counter } of variants) {
      const mediaStem = stripMediaExt(loose(base));
      for (const e of this.entries) {
        if (e.counter !== counter) continue;
        const sidecarStem = stripMediaExt(e.looseStem);
        const shorter = Math.min(mediaStem.length, sidecarStem.length);
        if (shorter < MIN_TRUNCATED || shorter === Math.max(mediaStem.length, sidecarStem.length)) continue;
        if (mediaStem.startsWith(sidecarStem) || sidecarStem.startsWith(mediaStem)) {
          if (!best || shorter > best.score) best = { entry: e, score: shorter };
        }
      }
    }
    if (best) return { entry: best.entry, method: 'truncated' };

    for (const { base, counter } of variants) {
      const mediaStem = stripMediaExt(loose(base));
      const partner = this.entries.find((e) => e.counter === counter && stripMediaExt(e.looseStem) === mediaStem);
      if (partner) return { entry: partner, method: 'partner' };
    }
    return null;
  }
}

function pickGeo(geo) {
  if (!geo) return null;
  const lat = Number(geo.latitude);
  const lon = Number(geo.longitude);
  // Takeout writes 0.0/0.0 for "no location".
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** Normalize the fields we use from a photo sidecar. */
export function sidecarMeta(data) {
  const taken = Number(data.photoTakenTime?.timestamp);
  const uploaded = Number(data.creationTime?.timestamp);
  const geo = pickGeo(data.geoData) ?? pickGeo(data.geoDataExif);
  return {
    title: typeof data.title === 'string' ? nfc(data.title) : null,
    takenAt: taken > 0 ? taken * 1000 : null,
    uploadedAt: uploaded > 0 ? uploaded * 1000 : null,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    description: data.description?.trim() || null,
    favorite: Boolean(data.favorited),
    archived: Boolean(data.archived),
    trashed: Boolean(data.trashed),
    people: (data.people ?? []).map((p) => p?.name).filter(Boolean),
  };
}

/**
 * Identity of a folder inside an export that is stable across zip parts:
 *   /x/takeout-001/Takeout/Google Photos/Trip -> "Google Photos/Trip"
 * Folders outside a Takeout tree are identified by their full path.
 */
export function takeoutFolderKey(dir) {
  const parts = dir.split(path.sep);
  const i = parts.lastIndexOf('Takeout');
  return i >= 0 && i < parts.length - 1 ? parts.slice(i + 1).join('/') : dir;
}
