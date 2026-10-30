// Versions: the same shot stored as different files. A phone original and the copy Google
// Photos recompressed ("Storage saver"), one photo in two Google accounts, or a Takeout's
// album copy next to its year-folder copy have different bytes, so content hashing keeps
// them all. The camera's record of the moment tells them apart from other shots: the
// capture time to the sub-second, the camera and the shape of the frame, confirmed by how
// alike the thumbnails look. The best version is shown and exported; the others stay in
// the library as its versions and are never deleted.
import path from 'node:path';
import { stripMediaExt } from './media.js';
import { isEditedName } from './takeout/sidecar.js';

// Bits (of 64) in which two thumbnails' difference hashes may differ and still be one shot.
// Recompressed copies differ in 0-3; different photos with the same key in far more.
export const MAX_DISTANCE = 8;
// Two files from one source with the same key are usually two takes of a moment the camera
// recorded only to the second (a burst); they count as one shot only when the camera kept
// sub-seconds and the pictures are near-identical.
const MAX_SAME_SOURCE_DISTANCE = 3;
// Seconds two copies of a video may differ in length (re-encoding trims or pads a frame).
const MAX_DURATION_DIFF = 0.5;

/**
 * Which rendering of a capture a file is: a Pixel writes several files for one press of the
 * shutter ("PXL_1.PORTRAIT-01.COVER.jpg", "PXL_1.PORTRAIT-02.ORIGINAL.jpg"); an edited copy
 * ("IMG_1-edited.jpg", the phone's "IMG_1~2.jpg") is a rendering of its own.
 */
function rendering(file) {
  const name = path.basename(file);
  const stem = stripMediaExt(name);
  const modes = stem.match(/\.[A-Z][A-Z_]*-\d+/g) ?? [];
  const edited = isEditedName(name) || /~\d+$/.test(stem);
  return [...modes, edited ? 'edited' : ''].join('');
}

/**
 * What identifies the shot a file holds, or '' when the file doesn't record enough to tell
 * it from other shots. Photos need the camera's capture time and the camera; videos the
 * creation time they recorded.
 */
export function shotKey({ kind, file, shot, camera, width, height, recordedAt }) {
  const ratio = width && height ? (width / height).toFixed(2) : '';
  if (kind === 'image') return shot && camera ? ['i', shot, camera, ratio, rendering(file)].join('|') : '';
  return recordedAt != null ? ['v', Math.floor(recordedAt / 1000), ratio, rendering(file)].join('|') : '';
}

/** Did the camera record the moment to the sub-second ("2024:03:07 14:15:44.109")? */
const precise = (key) => key.startsWith('i|') && key.split('|')[1].includes('.');

/** Hamming distance between two 64-bit hashes in hex, or null if either is missing. */
export function distance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let bits = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { bits += x & 1; x >>>= 1; }
  }
  return bits;
}

/** The key under which "these two are different photos" is remembered. */
export const pairKey = (sha1, sha2) => [sha1, sha2].sort().join(':');

/**
 * The version to show: a phone backup's original (whose export Photobox vouches for),
 * else the biggest file, which keeps the most of the picture; between equals, the one
 * Photobox knew first.
 */
const best = (a, b) => Number(Boolean(b.original)) - Number(Boolean(a.original)) || (b.bytes ?? 0) - (a.bytes ?? 0) || a.id - b.id;

/** How alike two items with the same key look, or null if they can't be versions of one shot. */
function likeness(a, b, separate) {
  if ((a.original && b.original) || separate.has(pairKey(a.sha256, b.sha256))) return null;
  if ((a.duration != null || b.duration != null) && !(Math.abs(a.duration - b.duration) <= MAX_DURATION_DIFF)) return null;
  const d = distance(a.dhash, b.dhash);
  const sameSource = a.sources.some((s) => b.sources.includes(s));
  if (d == null || d > (sameSource ? MAX_SAME_SOURCE_DISTANCE : MAX_DISTANCE) || (sameSource && !precise(a.shotKey))) return null;
  return d;
}

/**
 * Which items are versions of another. `items`: { id, shotKey, dhash, sources: [source ids],
 * bytes, duration, sha256, original }; `separate`: pair keys the user said are different
 * photos. The closest-looking pairs join first, and a group only takes in an item that
 * could be a version of every item already in it. Returns a Map from the id of each
 * superseded item to the id of the best version.
 */
export function findVersions(items, separate = new Set()) {
  const byKey = new Map();
  for (const item of items) if (item.shotKey) (byKey.get(item.shotKey) ?? byKey.set(item.shotKey, []).get(item.shotKey)).push(item);
  const superseded = new Map();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const alike = new Map();
    const pairs = [];
    for (const [i, a] of group.entries()) {
      for (const b of group.slice(i + 1)) {
        const d = likeness(a, b, separate);
        if (d == null) continue;
        alike.set(pairKey(a.id, b.id), true);
        pairs.push({ a, b, d });
      }
    }
    pairs.sort((x, y) => x.d - y.d);
    const sets = new Map(group.map((item) => [item.id, [item]]));
    for (const { a, b } of pairs) {
      const sa = sets.get(a.id);
      const sb = sets.get(b.id);
      if (sa === sb || !sa.every((x) => sb.every((y) => alike.has(pairKey(x.id, y.id))))) continue;
      sa.push(...sb);
      for (const item of sb) sets.set(item.id, sa);
    }
    for (const set of new Set(sets.values())) {
      if (set.length < 2) continue;
      const [winner, ...others] = set.sort(best);
      for (const other of others) superseded.set(other.id, winner.id);
    }
  }
  return superseded;
}
