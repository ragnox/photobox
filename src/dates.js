// Dates are kept twice: an instant (epoch ms) for sorting and the wall-clock
// time where the photo was taken ("2019-07-13 10:15:00") for display/grouping.
// When only the instant is known, the wall clock comes from the time zone at the
// photo's location (zoneAt), or this machine's zone without one; a wall clock
// without an offset is read in this machine's zone (localToInstant).

import tzlookup from '@photostructure/tz-lookup';

const pad = (n) => String(n).padStart(2, '0');
// How much we trust each date source; better information replaces worse.
export const DATE_RANK = { exif: 4, takeout: 4, capture: 3, filename: 2, upload: 1, file: 0 };
const MIN_YEAR = 1990;
const formatters = new Map();

/** Wall-clock time of an instant, in the given IANA zone or this machine's zone. */
export function formatLocal(ms, timeZone = null) {
  let fmt = formatters.get(timeZone ?? '');
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone ?? undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone ?? '', fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(ms).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** IANA time zone at a location, e.g. "Asia/Tokyo". */
export function zoneAt(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    return tzlookup(lat, lon);
  } catch {
    return null;
  }
}

export function localToInstant(local) {
  const [y, mo, d, h, mi, s] = local.split(/[- :]/).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

function valid(y, mo, d, h = 0, mi = 0, s = 0) {
  const nextYear = new Date().getFullYear() + 1;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y >= MIN_YEAR && y <= nextYear && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth && h < 24 && mi < 60 && s < 61;
}

function normalizeOffset(offset) {
  const m = typeof offset === 'string' && offset.trim().match(/^([+-])(\d{2}):?(\d{2})$/);
  return m ? `${m[1]}${m[2]}:${m[3]}` : null;
}

/**
 * Parse "2019:07:13 10:15:00" / "2019-07-13T10:15:00+0200" style timestamps.
 * Returns { local, instant }: instant is null unless the zone is known, local is
 * null for UTC timestamps (they say nothing about the wall clock where it was taken).
 */
export function parseTimestamp(value, offset = null) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return null;
  const [y, mo, d, h, mi, s = 0] = m.slice(1, 7).map(Number);
  if (!valid(y, mo, d, h, mi, s)) return null;
  const local = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${pad(s)}`;
  const zone = m[7]?.toUpperCase() === 'Z' ? 'Z' : normalizeOffset(m[7] ?? offset);
  if (!zone) return { local, instant: null };
  const instant = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(s)}${zone}`);
  return { local: zone === 'Z' ? null : local, instant };
}

// IMG_20190713_101500, PXL_20230115_123456789, Screenshot 2023-01-15 at 12.34.56, IMG-20190101-WA0001 ...
const FILENAME_DATE = /(?:^|\D)((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]*(?:at[ _])?([01]\d|2[0-3])[-_.:h]?([0-5]\d)[-_.:m]?([0-5]\d))?/;

export function dateFromFilename(name) {
  const m = name.match(FILENAME_DATE);
  if (!m) return null;
  const [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  const [h, mi, s] = m[4] ? [m[4], m[5], m[6]].map(Number) : [12, 0, 0];
  if (!valid(y, mo, d, h, mi, s)) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}
