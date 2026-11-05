const $ = (sel) => document.querySelector(sel);

// Native features when running inside the desktop app (see desktop/preload.cjs).
const desktop = window.photobox ?? null;
if (desktop) document.documentElement.classList.add('desktop', `platform-${desktop.platform}`);

// --- icons (lucide-style strokes) -------------------------------------------

const ICONS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  albums: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  hdd: '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11zM6 16h.01M10 16h.01"/>',
  live: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2.4"/>',
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
for (const el of document.querySelectorAll('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));

// --- helpers -----------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const init = { method };
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, init);
  // A phone whose pairing was removed on the computer: back to the pairing page.
  if (res.status === 401 && state.remote) location.href = '/pair.html';
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const thumbUrl = (id, v) => `/api/media/${id}/thumb?v=${v}`;
const fullUrl = (id) => `/api/media/${id}/full`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const locale = navigator.language;
// local_time is the wall clock where the photo was taken; render it as-is.
const wallClock = (s) => {
  const [y, mo, d, h = 12, mi = 0, se = 0] = s.split(/[- :]/).map(Number);
  return new Date(y, mo - 1, d, h, mi, se);
};
const fmtMonth = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtFull = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' });
const fmtDuration = (sec) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtBytes = (n) => {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};
const DATE_SOURCES = {
  exif: 'from the photo (EXIF)',
  takeout: 'from Google Takeout',
  capture: 'capture time from the phone',
  filename: 'guessed from the file name',
  upload: 'upload date (Google Takeout)',
  file: 'file modification time',
};
// "~/Photos/2024/03/x.jpg" rather than "/Users/name/Photos/2024/03/x.jpg".
const homePath = (p) => p.replace(/^\/(Users|home)\/[^/]+(?=\/)/, '~');
/** What a source is called: the name given to it, else its folder. */
const sourceLabel = (s) => s.name || (s.managed === 'backup' ? 'Phone backup' : s.path.split(/[\\/]/).filter(Boolean).at(-1) ?? s.path);
const sourceById = (id) => state.sources.find((s) => s.id === id);

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// --- timeline state ------------------------------------------------------------

const PAGE = 400;
const timelineEl = $('#timeline');
const state = {
  view: 'all',
  album: null,
  source: null,
  albums: [],
  items: [],
  hasOlder: true,
  hasNewer: false,
  startCursor: null,
  loading: false,
  generation: 0,
  platform: null,
  sources: [],
  running: false,
  remote: false,
  network: null,
  canDelete: false,
};
const months = new Map(); // 'YYYY-MM' -> { el }
const days = new Map(); // 'YYYY-MM-DD' -> { el, header, rows, items }
const tiles = new Map(); // media id -> tile element

const cursorOf = (item) => `${item.taken_at}:${item.id}`;

function query(extra = {}) {
  const p = new URLSearchParams({ view: state.view, ...extra });
  if (state.album) p.set('album', state.album);
  if (state.source) p.set('source', state.source);
  return p.toString();
}

function resetTimeline() {
  state.generation++;
  state.items = [];
  state.hasOlder = true;
  state.hasNewer = false;
  state.startCursor = null;
  state.loading = false;
  months.clear();
  days.clear();
  tiles.clear();
  timelineEl.replaceChildren();
  clearSelection();
}

async function loadOlder() {
  if (state.loading || !state.hasOlder) return;
  state.loading = true;
  const gen = state.generation;
  const last = state.items.at(-1);
  const cursor = last ? cursorOf(last) : state.startCursor;
  try {
    const { items, more } = await api(`/api/timeline?${query({ limit: PAGE, ...(cursor && { cursor }) })}`);
    if (gen !== state.generation) return;
    state.items.push(...items);
    state.hasOlder = more;
    addItems(items, false);
  } finally {
    if (gen === state.generation) state.loading = false;
  }
  updateChrome();
  if (gen === state.generation) fillViewport();
}

async function loadNewer() {
  if (state.loading || !state.hasNewer || !state.items.length) return;
  state.loading = true;
  const gen = state.generation;
  try {
    const { items, more } = await api(`/api/timeline?${query({ limit: PAGE, direction: 'newer', cursor: cursorOf(state.items[0]) })}`);
    if (gen !== state.generation) return;
    // Keep what's on screen in place while content grows above it.
    const before = document.documentElement.scrollHeight;
    state.items.unshift(...items);
    state.hasNewer = more;
    addItems(items, true);
    window.scrollBy(0, document.documentElement.scrollHeight - before);
  } finally {
    if (gen === state.generation) state.loading = false;
  }
  updateChrome();
}

function fillViewport() {
  if ($('#sentinel').getBoundingClientRect().top < innerHeight + 1500) loadOlder();
}

new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && loadOlder(), { rootMargin: '1500px' })
  .observe($('#sentinel'));

addEventListener('scroll', () => {
  if (scrollY < 600 && state.hasNewer) loadNewer();
  scheduleScrubberUpdate();
}, { passive: true });

// --- rendering: months > days > justified rows ------------------------------

function dayFor(item, atStart) {
  const dayKey = item.local_time.slice(0, 10);
  const monthKey = dayKey.slice(0, 7);
  let month = months.get(monthKey);
  if (!month) {
    const el = document.createElement('section');
    el.className = 'month';
    el.dataset.month = monthKey;
    el.innerHTML = `<h2>${esc(fmtMonth.format(wallClock(dayKey)))}</h2><div class="days"></div>`;
    atStart ? timelineEl.prepend(el) : timelineEl.append(el);
    month = { el, days: el.querySelector('.days') };
    months.set(monthKey, month);
  }
  let day = days.get(dayKey);
  if (!day) {
    const el = document.createElement('section');
    el.className = 'day';
    const header = document.createElement('h3');
    const label = fmtDay.format(wallClock(dayKey));
    header.innerHTML = `<span>${esc(label)}</span><button class="day-pick" data-day="${esc(dayKey)}" aria-label="Select the photos of ${esc(label)}" aria-pressed="false">${icon('check')}</button>`;
    const rows = document.createElement('div');
    el.append(header, rows);
    atStart ? month.days.prepend(el) : month.days.append(el);
    day = { el, header, rows, items: [] };
    days.set(dayKey, day);
  }
  return day;
}

function addItems(items, atStart) {
  const touched = new Set();
  for (const item of atStart ? [...items].reverse() : items) {
    const day = dayFor(item, atStart);
    atStart ? day.items.unshift(item) : day.items.push(item);
    touched.add(day);
  }
  for (const day of touched) layoutDay(day);
}

function rowMetrics() {
  const w = timelineEl.clientWidth;
  return { width: w, target: w < 600 ? 120 : w < 1100 ? 190 : 230, gap: 4 };
}

const aspect = (item) => Math.min(5, Math.max(0.3, (item.thumb_w || item.width || 4) / (item.thumb_h || item.height || 3)));

/** Justified rows: fill each row to the container width, keep the last row at target height. */
function justify(items, { width, target, gap }) {
  const rows = [];
  let row = [];
  let sum = 0;
  for (const item of items) {
    const a = aspect(item);
    row.push({ item, a });
    sum += a;
    if (sum * target + gap * (row.length - 1) >= width) {
      const h = (width - gap * (row.length - 1)) / sum;
      rows.push({ h, tiles: row });
      row = [];
      sum = 0;
    }
  }
  if (row.length) rows.push({ h: target, tiles: row });
  return rows;
}

function layoutDay(day) {
  const metrics = rowMetrics();
  const frag = document.createDocumentFragment();
  const rows = justify(day.items, metrics);
  // Days that don't fill a row sit next to each other, like a contact sheet.
  const compact = rows.length === 1 && rows[0].h === metrics.target;
  day.el.classList.toggle('compact', compact);
  let height = 0;
  let rowWidth = 0;
  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    rowEl.style.height = `${row.h}px`;
    rowWidth = metrics.gap * (row.tiles.length - 1);
    for (const { item, a } of row.tiles) {
      const tile = tiles.get(item.id) ?? createTile(item);
      tile.style.width = `${a * row.h}px`;
      rowWidth += a * row.h;
      rowEl.append(tile);
    }
    frag.append(rowEl);
    height += row.h + metrics.gap;
  }
  day.rows.replaceChildren(frag);
  // Exact sizes, so content-visibility never causes layout or scroll jumps.
  const width = Math.max(rowWidth, 110);
  day.el.style.width = compact ? `${width}px` : '';
  day.el.style.containIntrinsicSize = compact ? `${width}px ${Math.round(height + 44)}px` : `auto ${Math.round(height + 44)}px`;
}

function createTile(item) {
  const el = document.createElement('button');
  el.className = 'tile';
  el.dataset.id = item.id;
  el.setAttribute('aria-label', `${item.kind === 'video' ? 'Video' : 'Photo'}, ${fmtFull.format(wallClock(item.local_time))}`);
  if (item.thumb_w) {
    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = () => img.classList.add('loaded');
    img.src = thumbUrl(item.id, item.v);
    el.append(img);
  } else {
    el.innerHTML = `<div class="placeholder">${icon(item.kind === 'video' ? 'play' : 'image')}</div>`;
  }
  if (item.kind === 'video') el.insertAdjacentHTML('beforeend', `<span class="badge tr">${item.duration ? fmtDuration(item.duration) : ''}${icon('play')}</span>`);
  else if (item.live) el.insertAdjacentHTML('beforeend', `<span class="badge tr">${icon('live')}</span>`);
  el.insertAdjacentHTML('beforeend', `<span class="badge bl fav" ${item.favorite ? '' : 'hidden'}>${icon('heart')}</span>`);
  el.insertAdjacentHTML('beforeend', `<span class="pick" aria-hidden="true">${icon('check')}</span>`);
  if (selected.has(item.id)) el.classList.add('selected');
  tiles.set(item.id, el);
  return el;
}

// A click opens the photo. Its check mark, ⌘- or Ctrl-click, or any click while photos are
// selected selects it instead; Shift-click selects every photo up to it. A day's check selects the day.
timelineEl.addEventListener('click', (e) => {
  const dayPick = e.target.closest('.day-pick');
  if (dayPick) {
    const day = days.get(dayPick.dataset.day);
    if (day) select(day.items, !day.items.every((i) => selected.has(i.id)));
    return;
  }
  const tile = e.target.closest('.tile');
  const item = tile && state.items.find((i) => i.id === Number(tile.dataset.id));
  if (!item) return;
  if (e.shiftKey && selecting()) selectRange(item);
  else if (selecting() || e.shiftKey || e.metaKey || e.ctrlKey || e.target.closest('.pick')) toggleSelected(item);
  else openLightbox(item.id);
});

// --- selecting -------------------------------------------------------------------

const selected = new Set(); // ids of the selected photos
let anchor = null; // the photo a Shift-click selects from
const selecting = () => selected.size > 0;

/** Select (on) or deselect every photo of `items`. */
function select(items, on) {
  const changed = new Set();
  for (const item of items) {
    if (on) selected.add(item.id);
    else selected.delete(item.id);
    tiles.get(item.id)?.classList.toggle('selected', on);
    changed.add(item.local_time.slice(0, 10));
  }
  for (const key of changed) {
    const day = days.get(key);
    const all = Boolean(day?.items.length) && day.items.every((i) => selected.has(i.id));
    day?.header.classList.toggle('selected', all);
    day?.header.querySelector('.day-pick')?.setAttribute('aria-pressed', all);
  }
  showSelection();
}

function toggleSelected(item) {
  select([item], !selected.has(item.id));
  anchor = item;
}

/** Select the photos from the last one clicked to `item`, as they're shown. */
function selectRange(item) {
  const from = state.items.indexOf(anchor);
  const to = state.items.indexOf(item);
  if (from < 0) return toggleSelected(item);
  select(state.items.slice(Math.min(from, to), Math.max(from, to) + 1), true);
  anchor = item;
}

function clearSelection() {
  select(state.items.filter((i) => selected.has(i.id)), false);
  selected.clear();
  anchor = null;
  showSelection();
}

function showSelection() {
  document.body.classList.toggle('selecting', selecting());
  $('#select-bar').hidden = !selecting();
  $('#select-count').textContent = selected.size === 1 ? '1 selected' : `${selected.size} selected`;
}

$('#select-clear').addEventListener('click', clearSelection);
$('#select-delete').addEventListener('click', () => deleteSelected());

let lastWidth = 0;
new ResizeObserver(() => {
  const w = timelineEl.clientWidth;
  if (Math.abs(w - lastWidth) < 1) return;
  lastWidth = w;
  for (const day of days.values()) layoutDay(day);
}).observe(timelineEl);

// --- scrubber ----------------------------------------------------------------

let monthBuckets = [];

async function loadMonths() {
  monthBuckets = await api(`/api/months?${query()}`);
  const years = [...new Set(monthBuckets.map((m) => m.month.slice(0, 4)))];
  $('#scrubber').innerHTML = years.length > 1 ? years.map((y) => `<button data-year="${y}">${y}</button>`).join('') : '';
  scheduleScrubberUpdate();
}

$('#scrubber').addEventListener('click', (e) => {
  const year = e.target.closest('button')?.dataset.year;
  if (year) jumpToYear(year);
});

function jumpToYear(year) {
  const inYear = monthBuckets.filter((m) => m.month.startsWith(year));
  if (!inYear.length) return;
  const loaded = [...months.keys()].find((k) => k.startsWith(year));
  if (loaded) {
    months.get(loaded).el.scrollIntoView({ block: 'start' });
    scrollBy(0, -70);
    return;
  }
  const newest = Math.max(...inYear.map((m) => m.newest));
  resetTimeline();
  state.startCursor = `${newest}:${Number.MAX_SAFE_INTEGER}`;
  state.hasNewer = monthBuckets[0].month.slice(0, 4) !== year;
  scrollTo(0, 0);
  loadOlder();
}

let scrubberQueued = false;
function scheduleScrubberUpdate() {
  if (scrubberQueued) return;
  scrubberQueued = true;
  requestAnimationFrame(() => {
    scrubberQueued = false;
    const top = 160;
    let current = null;
    for (const [key, { el }] of months) {
      if (el.getBoundingClientRect().bottom > top) {
        current = key.slice(0, 4);
        break;
      }
    }
    for (const b of document.querySelectorAll('#scrubber button')) b.classList.toggle('active', b.dataset.year === current);
  });
}

// --- views, sidebar, status ----------------------------------------------------

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const album = h.match(/^album\/(\d+)/);
  if (album) return { view: 'all', album: Number(album[1]), source: null };
  const source = h.match(/^source\/(\d+)/);
  if (source) return { view: 'all', album: null, source: Number(source[1]) };
  return { view: ['favorites', 'videos', 'archive', 'deleted'].includes(h) ? h : 'all', album: null, source: null };
}

function viewTitle() {
  if (state.album) {
    const album = state.albums.find((a) => a.id === state.album);
    return album ? `${album.name}${albumSource(album) ? ` · ${albumSource(album)}` : ''}` : 'Album';
  }
  if (state.source) return sourceById(state.source) ? `From ${sourceLabel(sourceById(state.source))}` : 'Source';
  return { favorites: 'Favorites', videos: 'Videos', archive: 'Archive', deleted: 'Deleted' }[state.view];
}

function setView() {
  // A link in the photo info (one of its sources) leads out of the viewer.
  if (!$('#lightbox').hidden) closeLightbox();
  const { view, album, source } = parseHash();
  state.view = view;
  state.album = album;
  state.source = source;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', !album && !source && a.dataset.view === view);
  renderAlbums();
  renderSources(state.sources);
  const title = viewTitle();
  $('#view-title').hidden = !title;
  $('#view-title').textContent = title ?? '';
  document.body.classList.remove('menu-open');
  $('#new-pill').hidden = true;
  resetTimeline();
  scrollTo(0, 0);
  // The Deleted list is a list of files, not a timeline.
  const deleted = view === 'deleted';
  for (const el of [$('#timeline'), $('#scrubber')]) el.hidden = deleted;
  $('#deleted-view').hidden = !deleted;
  if (deleted) {
    state.hasOlder = false;
    deletedKey = '';
    updateChrome();
    renderDeleted();
    return;
  }
  loadMonths();
  loadOlder();
}

addEventListener('hashchange', setView);

/** Albums come from more than one source, so each says which one ("Trip" from two Google accounts). */
const albumsFromManySources = () => new Set(state.albums.map((a) => a.source_id)).size > 1;
/** In an archive's library, the archive's own photos: its albums are the library's. */
const archiveSource = () => state.sources.find((s) => s.managed === 'archive');
/** Which source an album is from, when that needs saying; the archive's albums go by their name. */
const albumSource = (a) => (albumsFromManySources() && a.source_id !== archiveSource()?.id && sourceById(a.source_id) ? sourceLabel(sourceById(a.source_id)) : null);

/**
 * The albums to list: a picked source's own; else all, but an album the archive has too (an
 * export put it there) only once, as the archive's.
 */
function listedAlbums() {
  if (state.source) return state.albums.filter((a) => a.source_id === state.source);
  const archive = archiveSource()?.id;
  const inArchive = new Set(state.albums.filter((a) => a.source_id === archive).map((a) => a.name));
  return state.albums.filter((a) => a.source_id === archive || !inArchive.has(a.name));
}

async function loadAlbums() {
  state.albums = await api('/api/albums');
  renderAlbums();
}

function renderAlbums() {
  const shown = listedAlbums();
  $('#albums').innerHTML = shown.length
    ? shown.map((a) => `
        <a href="#album/${a.id}" data-album="${a.id}" class="${state.album === a.id ? 'active' : ''}">
          ${a.cover ? `<img src="${thumbUrl(a.cover, a.v)}" alt="" loading="lazy">` : '<span class="cover"></span>'}
          <span class="album-text"><span class="name">${esc(a.name)}</span>${albumSource(a) ? `<span class="src">${esc(albumSource(a))}</span>` : ''}</span>
          <span class="count">${a.count}</span>
        </a>`).join('')
    : '<p class="muted small note">Albums from Google Takeout show up here</p>';
  if (state.album) $('#view-title').textContent = viewTitle();
}

let sourcesKey = '';
let renaming = false; // a source's name is being edited: don't redraw the list under it
function renderSources(sources) {
  const key = JSON.stringify([state.source, state.remote, sources.map((s) => [s.id, s.files, s.name])]);
  if (key === sourcesKey || renaming) return;
  sourcesKey = key;
  $('#sources').innerHTML = sources.length
    ? sources.map((s) => `
        <div class="source ${state.source === s.id ? 'active' : ''}" data-source="${s.id}" title="${esc(s.path)}">
          <a class="src-link" href="#source/${s.id}">
            <span class="name">${esc(sourceLabel(s))}</span>
            <span class="path">‎${esc(homePath(s.path))}</span>
          </a>
          <span class="muted small">${s.files}</span>
          ${state.remote ? '' : `<button class="icon-btn" data-rename="${s.id}" aria-label="Rename ${esc(sourceLabel(s))}">${icon('pencil')}</button>`}
          ${s.managed ? '' : `<button class="icon-btn" data-remove="${s.id}" aria-label="Stop showing ${esc(s.path)}">${icon('x')}</button>`}
        </div>`).join('')
    : '<p class="muted small note">No folders yet</p>';
}

$('#sources').addEventListener('click', async (e) => {
  const rename = e.target.closest('[data-rename]')?.dataset.rename;
  if (rename) return renameSource(e.target.closest('.source'), sourceById(Number(rename)));
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id) return;
  const source = state.sources.find((s) => s.id === Number(id));
  if (!confirm(`Remove ${source?.path} from Photobox?\n\nYour files stay where they are; only the library entries and thumbnails are removed.`)) return;
  await api(`/api/sources/${id}`, { method: 'DELETE' });
  poll();
});

/** Edit a source's name in its row (the desktop app has no prompt()): Enter or leaving the field saves, Esc cancels. */
function renameSource(row, source) {
  const input = document.createElement('input');
  Object.assign(input, { className: 'rename', value: source.name ?? '', placeholder: sourceLabel({ ...source, name: null }), maxLength: 100 });
  input.title = 'For example "Google, main account". Leave empty to show the folder name.';
  input.setAttribute('aria-label', `Name for ${source.path}`);
  row.querySelector('.src-link').replaceWith(input);
  row.classList.add('renaming');
  renaming = true;
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() !== (source.name ?? '')) {
      await api(`/api/sources/${source.id}/name`, { method: 'POST', body: { name: input.value } }).catch((err) => toast(err.message));
    }
    renaming = false;
    sourcesKey = ''; // draw the row again, also when nothing changed
    await poll();
    loadAlbums();
    $('#view-title').textContent = viewTitle() ?? '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    else return;
    e.preventDefault();
  });
  input.addEventListener('blur', () => finish(true));
}

function renderStatus({ indexing }) {
  const el = $('#status');
  el.hidden = !indexing.running;
  // Dock/taskbar progress: >1 is indeterminate, <0 hides it.
  desktop?.setProgress(indexing.running ? (indexing.total ? indexing.done / indexing.total : 2) : -1);
  if (!indexing.running) return;
  const name = indexing.source?.split('/').filter(Boolean).at(-1) ?? '';
  const progress = `${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}`;
  $('#status-text').textContent = indexing.phase === 'scanning' ? `Scanning ${name}…`
    : indexing.phase === 'comparing' ? `Looking for versions of the same photo · ${progress}`
    : `Importing ${name} · ${progress}`;
  $('#status-fill').style.width = indexing.total ? `${(100 * indexing.done) / indexing.total}%` : '4%';
}

function renderStats(stats) {
  $('#stats').textContent = `${stats.photos.toLocaleString()} photos · ${stats.videos.toLocaleString()} videos` +
    (stats.versions ? ` · ${stats.versions.toLocaleString()} older ${stats.versions === 1 ? 'version' : 'versions'} set aside` : '');
}

function renderBackup(backup) {
  $('#backup-section').hidden = !backup || (!backup.configured && !backup.received);
  if (!backup) return;
  $('#backup-summary').textContent = `${backup.received} received · ${backup.indexed} indexed · ${backup.exported} export verified` +
    (backup.running ? ' · processing…' : !backup.configured ? ' · export destination not configured' : '');
  $('#backup-error').hidden = !backup.error;
  $('#backup-error').textContent = backup.error ?? '';
}

function updateChrome() {
  $('#load-newer').hidden = !state.hasNewer;
  const empty = $('#empty');
  const isEmpty = !state.items.length && !state.hasOlder && !state.loading && state.view !== 'deleted';
  empty.hidden = !isEmpty;
  if (!isEmpty) return;
  const show = (art, title, text = '', extra = '') =>
    (empty.innerHTML = `<div class="art">${icon(art)}</div><h2>${title}</h2>${text && `<p>${text}</p>`}${extra}`);
  if (!state.sources.length && state.remote) show('image', 'No photos yet', 'Add folders in Photobox on your computer.');
  else if (!state.sources.length) {
    show('image', 'Bring your photos home',
      'Add an extracted Google Takeout or any folder of photos. Photobox reads dates, places and albums from the Takeout JSON files, removes duplicates, and keeps watching the folder.',
      `<button class="btn primary" data-action="add">${icon('plus')}Add folder</button>`);
  } else if (state.running) show('hdd', 'Importing…', "Photos appear here as they're processed.");
  else {
    const what = { favorites: 'No favorites yet', videos: 'No videos', archive: 'Nothing archived' }[state.view] ?? 'Nothing here';
    show(state.view === 'favorites' ? 'heart' : 'image', what);
  }
}

$('#empty').addEventListener('click', (e) => e.target.closest('[data-action="add"]') && openAddDialog());
$('#newest-btn').addEventListener('click', () => setView());
$('#menu-btn').addEventListener('click', (e) => {
  e.currentTarget.setAttribute('aria-expanded', document.body.classList.toggle('menu-open'));
});

// Poll for import progress; refresh the view when new photos land.
let lastVersion = null;
let pollTimer = null;
let lastReload = 0;

async function poll() {
  clearTimeout(pollTimer);
  try {
    const s = await api('/api/status');
    const wasRunning = state.running;
    state.platform = s.platform;
    document.documentElement.classList.toggle('remote', s.remote);
    state.remote = s.remote;
    state.network = s.network;
    $('#devices-section').hidden = s.remote;
    $('#lb-reveal').setAttribute('aria-label', revealLabel());
    state.sources = s.sources;
    state.running = s.indexing.running;
    renderStatus(s);
    renderSources(s.sources);
    renderStats(s.stats);
    renderBackup(s.backup);
    // A host from before deleting doesn't say: it can't delete.
    state.canDelete = s.deleted != null;
    $('#select-delete').hidden = !state.canDelete;
    $('#nav-deleted').hidden = !s.deleted?.photos && state.view !== 'deleted';
    $('#deleted-count').textContent = s.deleted?.photos || '';
    if (state.view === 'deleted') renderDeleted();
    if (lastVersion !== null && s.version !== lastVersion) libraryChanged();
    if (wasRunning && !state.running && Date.now() - lastReload > 500) libraryChanged(true);
    lastVersion = s.version;
    updateChrome();
  } catch {
    // server restarting; try again shortly
  }
  pollTimer = setTimeout(poll, state.running ? 1500 : 5000);
}
function reload() {
  lastReload = Date.now();
  loadAlbums();
  setView();
}

/** New photos arrived: reload when nothing would jump under the user, otherwise offer to. */
function libraryChanged(final = false) {
  // Not under a selection either: reloading would clear it.
  const atTop = scrollY < 400 && !state.hasNewer && $('#lightbox').hidden && !selecting();
  if (!state.items.length || atTop) {
    if (final || Date.now() - lastReload > 3000) reload();
  } else {
    $('#new-pill').hidden = false;
    if (final) loadAlbums();
  }
}

$('#new-pill').addEventListener('click', reload);

// --- add folder dialog ---------------------------------------------------------

const dialog = $('#add-dialog');

const canPickFolder = () => Boolean(desktop) || state.platform === 'darwin';
const pickFolder = async () => (desktop ? desktop.pickFolder() : (await api('/api/pick-folder', { method: 'POST' })).path);

function openAddDialog() {
  $('#add-error').textContent = '';
  $('#browse-btn').hidden = !canPickFolder();
  dialog.showModal();
  $('#add-path').focus();
}

async function addSource(path, name = null) {
  const source = await api('/api/sources', { method: 'POST', body: { path, name } });
  state.running = true;
  poll();
  return source;
}

$('#add-btn').addEventListener('click', openAddDialog);
$('#add-cancel').addEventListener('click', () => dialog.close());

$('#browse-btn').addEventListener('click', async () => {
  try {
    const path = await pickFolder();
    if (path) $('#add-path').value = path;
  } catch (err) {
    $('#add-error').textContent = err.message;
  }
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = $('#add-path').value.trim();
  if (!path) return;
  try {
    await addSource(path, $('#add-name').value.trim() || null);
    $('#add-path').value = '';
    $('#add-name').value = '';
    dialog.close();
  } catch (err) {
    $('#add-error').textContent = err.message;
  }
});

// --- connect a phone (on the computer running Photobox) -----------------------

const pairDialog = $('#pair-dialog');
const pairBody = $('#pair-body');
const fmtAgo = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
const ago = (ms) => {
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return fmtAgo.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return fmtAgo.format(Math.round(minutes / 60), 'hour');
  return fmtAgo.format(Math.round(minutes / 1440), 'day');
};
let pairTimer = null;

async function loadDevices() {
  const devices = await api('/api/devices').catch(() => []);
  $('#devices').innerHTML = devices.length
    ? devices.map((d) => `
        <div class="device">
          ${icon('phone')}<span class="name">${esc(d.name)}</span>
          <span class="muted small">${d.last_seen_at ? `seen ${esc(ago(d.last_seen_at))}` : 'not used yet'}</span>
          <button class="icon-btn" data-disconnect="${d.id}" aria-label="Disconnect ${esc(d.name)}">${icon('x')}</button>
        </div>`).join('')
    : '<p class="muted small note">No devices connected</p>';
  return devices;
}

$('#devices').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-disconnect]')?.dataset.disconnect;
  if (!id || !confirm('Disconnect this device? It will need a new pairing code to see your photos again.')) return;
  await api(`/api/devices/${id}`, { method: 'DELETE' });
  loadDevices();
});

function renderPairing({ links, fingerprint, expiresAt }) {
  if (!links.length) {
    pairBody.innerHTML = '<p>This computer has no network address right now. Connect it to Wi-Fi or your VPN, then try again.</p>';
    return;
  }
  pairBody.innerHTML = `
    <label>Connect using <select id="pair-client"><option value="browser">Phone browser</option><option value="android">Photobox for Android</option></select></label>
    <ol class="steps" id="pair-browser-steps">
      <li>On your phone, open the camera and scan this code. The phone needs to be on the same Wi-Fi or VPN.</li>
      ${fingerprint ? '<li>The first time, the browser warns that the connection is not private, because Photobox uses its own certificate. Tap <b>Advanced</b>, then <b>Proceed</b>.</li>' : ''}
      <li>Name the phone and tap <b>Connect</b>.</li>
    </ol>
    <p id="pair-android-steps" hidden>In Photobox for Android, tap <b>Scan host QR</b>. This code includes the host's public trust certificate; no browser certificate installation is needed.</p>
    <div class="qr" id="pair-qr">${links[0].qr}</div>
    ${links.length > 1 ? `<select id="pair-address" aria-label="Address">${links.map((l, i) => `<option value="${i}">${esc(new URL(l.url).host)}</option>`).join('')}</select>` : ''}
    <p class="muted small mono" id="pair-url">${esc(links[0].url)}</p>
    <details id="pair-native-copy" hidden><summary>Copy Android pairing data</summary><textarea id="pair-native-payload" rows="4" readonly aria-label="Android pairing data"></textarea><button class="btn" id="pair-copy-native" type="button">Copy pairing data</button></details>
    <p class="muted small">The code works once, until ${esc(fmtTime.format(new Date(expiresAt)))}.</p>
    ${fingerprint ? `<details class="muted small"><summary>Certificate fingerprint</summary>
      <p>When you install the Photobox certificate on your phone, its SHA-256 fingerprint must be:</p><p class="mono">${esc(fingerprint)}</p></details>` : ''}`;
  const update = () => {
    const link = links[Number($('#pair-address')?.value ?? 0)];
    const native = $('#pair-client').value === 'android';
    $('#pair-browser-steps').hidden = native;
    $('#pair-android-steps').hidden = !native;
    $('#pair-native-copy').hidden = !native;
    $('#pair-qr').classList.toggle('native-qr', native);
    $('#pair-qr').innerHTML = native ? link.native.qr : link.qr;
    $('#pair-url').textContent = native ? new URL(link.url).origin : link.url;
    $('#pair-native-payload').value = link.native.payload;
  };
  $('#pair-address')?.addEventListener('change', update);
  $('#pair-client').addEventListener('change', update);
  $('#pair-copy-native').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#pair-native-payload').value); }
    catch { $('#pair-native-payload').select(); }
  });
  update();
}

async function openPairDialog() {
  pairDialog.showModal();
  if (!state.network) {
    pairBody.innerHTML = `
      <p>Phones connect to Photobox over your Wi-Fi or VPN. That is turned off right now.</p>
      <p class="muted">Quit Photobox and start it with network access:</p>
      <pre class="cmd">photobox serve --listen 0.0.0.0</pre>`;
    return;
  }
  pairBody.innerHTML = '<p class="muted">Making a pairing code…</p>';
  try {
    const known = new Set((await loadDevices()).map((d) => d.id));
    const pairing = await api('/api/pairing', { method: 'POST' });
    renderPairing(pairing);
    pairTimer = setInterval(async () => {
      const added = (await loadDevices()).find((d) => !known.has(d.id));
      if (added) {
        clearInterval(pairTimer);
        pairBody.innerHTML = `<p class="paired">${icon('check')}<span><b>${esc(added.name)}</b> is connected.</span></p>
          <p class="muted">In the Android app, choose your backup folders. In the browser, choose <b>Install app</b> or <b>Add to Home screen</b>.</p>`;
      } else if (Date.now() > pairing.expiresAt) {
        clearInterval(pairTimer);
        pairBody.innerHTML = '<p>The pairing code has expired.</p><button type="button" class="btn" id="pair-again">Make a new code</button>';
        $('#pair-again').addEventListener('click', openPairDialog);
      }
    }, 2000);
  } catch (err) {
    pairBody.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

$('#pair-btn').addEventListener('click', openPairDialog);
$('#pair-close').addEventListener('click', () => pairDialog.close());
pairDialog.addEventListener('close', () => clearInterval(pairTimer));

if (desktop) {
  desktop.onMenu(async (action) => {
    try {
      if (action === 'add-folder') {
        const path = await pickFolder();
        if (path) await addSource(path);
      } else if (action === 'rescan') {
        await api('/api/rescan', { method: 'POST' });
        state.running = true;
        poll();
      } else if (action === 'connect-phone') {
        await openPairDialog();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  // Drop folders from Finder onto the window to add them.
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
  addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('#drop-overlay').hidden = false;
  });
  addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) $('#drop-overlay').hidden = true;
  });
  addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    const added = [];
    for (const file of e.dataTransfer.files) {
      try {
        added.push((await addSource(desktop.pathForFile(file))).path);
      } catch (err) {
        toast(err.message);
      }
    }
    if (added.length) toast(`Added ${added.map((p) => p.split('/').at(-1)).join(', ')}`);
  });
}

// --- lightbox ------------------------------------------------------------------

const lb = { index: -1, token: 0, details: null };
const lightbox = $('#lightbox');
const stage = $('#lb-stage');

function openLightbox(id) {
  lb.index = state.items.findIndex((i) => i.id === id);
  if (lb.index < 0) return;
  lightbox.hidden = false;
  document.body.style.overflow = 'hidden';
  $('#lb-close').focus();
  showCurrent();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.style.overflow = '';
  stage.replaceChildren();
  const tile = tiles.get(state.items[lb.index]?.id);
  tile?.focus({ preventScroll: true });
  tile?.scrollIntoView({ block: 'nearest' });
}

function step(delta) {
  const next = lb.index + delta;
  if (next < 0 || next >= state.items.length) return;
  lb.index = next;
  showCurrent();
}

async function showCurrent() {
  const item = state.items[lb.index];
  const token = ++lb.token;
  lb.details = null; // until this item's details arrive, LIVE and reveal must not use the previous one's
  $('#lb-prev').disabled = lb.index === 0;
  $('#lb-next').disabled = lb.index === state.items.length - 1 && !state.hasOlder;
  if (lb.index > state.items.length - 10) loadOlder();

  if (item.kind === 'video') {
    const video = document.createElement('video');
    Object.assign(video, { controls: true, autoplay: true, playsInline: true, src: fullUrl(item.id) });
    if (item.thumb_w) video.poster = thumbUrl(item.id, item.v);
    video.onerror = () => showStageMessage("This video format can't play in the browser.", item);
    stage.replaceChildren(video);
  } else {
    // Show the thumbnail immediately, swap in the full image once it's decoded.
    const img = document.createElement('img');
    img.alt = '';
    if (item.thumb_w) img.src = thumbUrl(item.id, item.v);
    stage.replaceChildren(img);
    const full = new Image();
    full.src = fullUrl(item.id);
    full.decode().then(() => token === lb.token && (img.src = full.src)).catch(() => {
      if (token === lb.token && !item.thumb_w) showStageMessage("This file couldn't be decoded.", item);
    });
    // Warm up the neighbours.
    for (const n of [state.items[lb.index + 1], state.items[lb.index - 1]]) {
      if (n?.kind === 'image') new Image().src = fullUrl(n.id);
    }
  }

  const when = wallClock(item.local_time);
  $('#lb-date').textContent = `${fmtFull.format(when)} · ${fmtTime.format(when)}`;
  $('#lb-name').textContent = '';
  showFavorite(item.favorite);
  $('#lb-live').hidden = true;
  $('#lb-copy').hidden = item.kind !== 'image' || !canCopy();
  $('#lb-reveal').hidden = !canReveal();
  $('#lb-delete').hidden = !state.canDelete;

  const details = await api(`/api/media/${item.id}`).catch(() => null);
  if (token !== lb.token || !details) return;
  lb.details = details;
  $('#lb-name').textContent = details.filename;
  $('#lb-live').hidden = !details.live_video;
  renderInfo(details);
}

const canReveal = () => Boolean(desktop) || (state.platform === 'darwin' && !state.remote);
const revealLabel = () => (state.platform === 'darwin' ? 'Show in Finder' : 'Show in folder');

/** Show a file of the photo in Finder: `file` if given, else the copy in the library folder, else an original. */
async function reveal(item, file = null) {
  if (!desktop) return api(`/api/media/${item.id}/reveal`, { method: 'POST', body: file ? { path: file } : {} });
  const details = lb.details?.id === item.id ? lb.details : await api(`/api/media/${item.id}`);
  const target = file ?? details.copy ?? details.files[0]?.path;
  if (target) desktop.reveal(target);
}

// The clipboard API needs a secure page: localhost, the desktop app or the paired HTTPS listener.
const canCopy = () => Boolean(navigator.clipboard?.write && window.ClipboardItem);

/** Put the photo on the clipboard as an image, at full size (paste it into a mail, a chat, a document). */
async function copyImage(item = state.items[lb.index]) {
  if (!item || item.kind !== 'image' || !canCopy()) return;
  // Browsers take PNG; the photo is drawn into a canvas once it has loaded.
  const png = (async () => {
    const img = new Image();
    img.src = fullUrl(item.id);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('too large'))), 'image/png'));
  })();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Copied');
  } catch (err) {
    toast(`Couldn't copy the image: ${err.message}`);
  }
}

// --- deleting --------------------------------------------------------------------

const askDialog = $('#ask-dialog');
let answer = null; // answers the question that is open

/** A question with Cancel and a (dangerous) action; resolves with whether the action was chosen. */
function ask({ title, body, action }) {
  answer?.(false);
  $('#ask-title').textContent = title;
  $('#ask-body').innerHTML = body;
  $('#ask-ok').textContent = action;
  askDialog.showModal();
  $('#ask-ok').focus();
  return new Promise((resolve) => {
    answer = (yes) => {
      answer = null;
      if (askDialog.open) askDialog.close();
      resolve(yes);
    };
  });
}

$('#ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  answer?.(true);
});
$('#ask-cancel').addEventListener('click', () => answer?.(false));
// Esc, which doesn't always say so with a close event.
askDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  answer?.(false);
});
// A close event can come late, after the next question opened: that one stays.
askDialog.addEventListener('close', () => !askDialog.open && answer?.(false));

/** Every file of the photo on this computer: the copy in the library folder, its originals, its other versions. */
const photoFiles = (d) => [...new Set([d.copy, ...d.files.map((f) => f.path), ...d.versions.flatMap((v) => v.files.map((f) => f.path))].filter(Boolean))];

/** Delete the photo from all devices, once the user says so. */
async function deletePhoto(item = state.items[lb.index]) {
  if (!item || !state.canDelete || askDialog.open) return;
  const d = lb.details?.id === item.id ? lb.details : await api(`/api/media/${item.id}`).catch(() => null);
  if (!d) return;
  const files = photoFiles(d);
  const shown = files.slice(0, 4);
  const yes = await ask({
    title: 'Delete from all devices?',
    action: 'Delete',
    body: `<p><b>${esc(d.filename)}</b>, taken ${esc(fmtFull.format(wallClock(d.local_time)))}.</p>
      <p>${files.length === 1 ? 'Its file on this computer goes' : `Its ${files.length} files on this computer go`} to the Trash${d.versions.length ? ', its other versions too' : ''}:</p>
      <ul class="places">${shown.map((f) => `<li>${esc(homePath(f))}</li>`).join('')}${files.length > shown.length ? `<li>and ${files.length - shown.length} more</li>` : ''}</ul>
      <p>Phones with Photobox for Android delete their copy too, once you confirm it there.</p>
      <p class="muted small">Its fingerprint stays on the Deleted list, so a copy that turns up again is deleted too.</p>`,
  });
  if (!yes) return;
  try {
    const { waiting, version } = await api(`/api/media/${item.id}`, { method: 'DELETE' });
    lastVersion = version; // our own change - the view is updated right here
    removeItem(item);
    toast(waiting ? `Deleted · ${waiting === 1 ? 'a file waits for its folder' : `${waiting} files wait for their folders`} (unplugged drive?)` : 'Deleted');
    poll();
  } catch (err) {
    toast(err.message);
  }
}

/** Take a deleted photo out of the timeline, and the viewer on to the next one. */
function removeItem(item) {
  const index = state.items.findIndex((i) => i.id === item.id);
  if (index < 0) return;
  state.items.splice(index, 1);
  tiles.get(item.id)?.remove();
  tiles.delete(item.id);
  if (selected.delete(item.id)) showSelection();
  if (anchor?.id === item.id) anchor = null;
  const dayKey = item.local_time.slice(0, 10);
  const day = days.get(dayKey);
  if (day) {
    day.items = day.items.filter((i) => i.id !== item.id);
    if (day.items.length) layoutDay(day);
    else {
      day.el.remove();
      days.delete(dayKey);
      const month = months.get(dayKey.slice(0, 7));
      if (month && !month.days.children.length) {
        month.el.remove();
        months.delete(dayKey.slice(0, 7));
      }
    }
  }
  if (!lightbox.hidden) {
    if (!state.items.length) closeLightbox();
    else {
      lb.index = Math.min(index, state.items.length - 1);
      showCurrent();
    }
  }
  updateChrome();
}

/** Delete the selected photos from all devices, once the user says so. */
async function deleteSelected() {
  const items = state.items.filter((i) => selected.has(i.id));
  if (!items.length || !state.canDelete || askDialog.open) return;
  if (items.length === 1) return deletePhoto(items[0]);
  const times = items.map((i) => wallClock(i.local_time)).sort((a, b) => a - b);
  const [first, last] = [fmtFull.format(times[0]), fmtFull.format(times.at(-1))];
  const videos = items.filter((i) => i.kind === 'video').length;
  const what = `${items.length} ${videos === items.length ? 'videos' : videos ? 'photos and videos' : 'photos'}`;
  const yes = await ask({
    title: `Delete ${what} from all devices?`,
    action: `Delete ${items.length}`,
    body: `<p>${esc(what)}, taken ${first === last ? `on ${esc(first)}` : `between ${esc(first)} and ${esc(last)}`}.</p>
      <p>Their files on this computer go to the Trash, their other versions too.</p>
      <p>Phones with Photobox for Android delete their copies too, once you confirm it there.</p>
      <p class="muted small">Their fingerprints stay on the Deleted list, so a copy that turns up again is deleted too.</p>`,
  });
  if (!yes) return;
  try {
    const { deleted, gone, failed, waiting, version } = await api('/api/media/delete', { method: 'POST', body: { ids: items.map((i) => i.id) } });
    lastVersion = version; // our own change - the view is updated right here
    for (const item of items) if (deleted.includes(item.id) || gone.includes(item.id)) removeItem(item);
    // What couldn't be deleted stays selected, to try again.
    toast([
      `Deleted ${deleted.length === 1 ? '1 photo' : `${deleted.length} photos`}`,
      waiting && `${waiting === 1 ? 'a file waits for its folder' : `${waiting} files wait for their folders`} (unplugged drive?)`,
      failed.length && `${failed.length} not deleted: ${failed[0].error}`,
    ].filter(Boolean).join(' · '));
    poll();
  } catch (err) {
    toast(err.message);
  }
}

$('#lb-delete').addEventListener('click', () => deletePhoto());

const FILE_STATES = { deleted: 'Moved to the Trash', pending: 'Waiting', changed: 'Kept' };
const DEVICE_STATES = { waiting: 'Waiting for the phone', trashed: 'Deleted on the phone', kept: 'Kept on the phone' };

let deletedKey = '';
/** The Deleted list: each photo with the fingerprint of each of its files, and what became of every copy. */
async function renderDeleted() {
  const list = await api('/api/deletions').catch(() => null);
  const key = JSON.stringify([list, state.remote]);
  if (state.view !== 'deleted' || !list || key === deletedKey) return;
  deletedKey = key;
  const where = (label, state, text) => `<div class="where"><span class="path">${label}</span><span class="state is-${state}">${esc(text)}</span></div>`;
  $('#deleted-view').innerHTML = `
    <div class="deleted-head">
      <p class="muted">Photos you deleted, with the fingerprint (SHA-256) of each file and what became of every copy. While a photo is on this list, a copy that turns up again (a drive plugged back in, a new Takeout, a phone) is deleted too.</p>
      ${list.length && !state.remote ? '<button class="btn" data-clear-all>Clear list</button>' : ''}
    </div>
    ${list.length ? '' : `<div class="empty"><div class="art">${icon('trash')}</div><h2>Nothing deleted</h2></div>`}
    ${list.map((p) => `
      <article class="deleted" data-photo="${esc(p.photo)}">
        <div class="deleted-title">${icon(p.kind === 'video' ? 'play' : 'image')}
          <div><b>${esc(p.filename)}</b><span class="muted small">${esc([p.local_time && `Taken ${fmtFull.format(wallClock(p.local_time))}`, `deleted ${ago(p.deleted_at)}`].filter(Boolean).join(' · '))}</span></div>
          ${state.remote ? '' : `<button class="btn small" data-clear="${esc(p.photo)}">Clear</button>`}
        </div>
        ${p.contents.map((c) => `
          <div class="content">
            <div class="fingerprint"><span class="muted">${c.sha256 === p.photo ? 'Fingerprint' : `${esc(c.filename)} · fingerprint`}</span> <code title="SHA-256">${esc(c.sha256)}</code></div>
            ${c.files.map((f) => where(esc(homePath(f.path)), f.state, f.error && f.state !== 'deleted' ? `${FILE_STATES[f.state]}: ${f.error}` : FILE_STATES[f.state])).join('')}
            ${c.devices.map((d) => where(`${icon('phone')}${esc(d.name)}`, d.state, DEVICE_STATES[d.state])).join('')}
          </div>`).join('')}
      </article>`).join('')}`;
}

$('#deleted-view').addEventListener('click', async (e) => {
  const one = e.target.closest('[data-clear]')?.dataset.clear;
  const all = e.target.closest('[data-clear-all]');
  if (!one && !all) return;
  const n = all ? document.querySelectorAll('#deleted-view .deleted').length : 1;
  const yes = await ask({
    title: all ? `Clear ${n === 1 ? 'the photo' : `all ${n} photos`} from the list?` : 'Clear this photo from the list?',
    action: 'Clear',
    body: `<p>Photobox forgets ${n === 1 ? 'it' : 'them'}. A copy that is still somewhere or turns up again is shown again, and phones that kept a copy back it up again.</p>`,
  });
  if (!yes) return;
  try {
    await api('/api/deletions/clear', { method: 'POST', body: all ? { all: true } : { photos: [one] } });
    deletedKey = '';
    await renderDeleted();
    poll();
  } catch (err) {
    toast(err.message);
  }
});

function showStageMessage(text, item) {
  stage.innerHTML = `<div class="lb-msg"><p>${esc(text)}</p>${canReveal() ? `<button class="btn" data-reveal>${revealLabel()}</button>` : ''}</div>`;
  stage.querySelector('[data-reveal]')?.addEventListener('click', () => reveal(item));
}

function renderInfo(d) {
  const when = wallClock(d.local_time);
  const field = (ic, main, sub) => `<div class="field">${icon(ic)}<div><b>${main}</b>${sub ? `<span>${sub}</span>` : ''}</div></div>`;
  const dims = d.width ? `${d.width} × ${d.height}` : '';
  const html = [
    '<h3>Info</h3>',
    d.description ? `<p class="desc">${esc(d.description)}</p>` : '',
    field('calendar', esc(`${fmtFull.format(when)}, ${fmtTime.format(when)}`), `Local time where it was taken · ${esc(DATE_SOURCES[d.date_source] ?? d.date_source)}`),
    field(d.kind === 'video' ? 'play' : 'file', esc(d.filename), [dims, d.duration ? fmtDuration(d.duration) : '', fmtBytes(d.bytes)].filter(Boolean).join(' · ')),
    d.camera ? field('camera', esc(d.camera)) : '',
    d.lat != null
      ? field('pin', `<a href="https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=14/${d.lat}/${d.lon}" target="_blank" rel="noopener noreferrer">${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}</a>`, 'Opens OpenStreetMap')
      : '',
    d.albums.length ? field('albums', d.albums.map((a) => `<span class="chip">${esc(a)}</span>`).join('')) : '',
    d.people.length ? field('users', d.people.map((p) => `<span class="chip">${esc(p)}</span>`).join('')) : '',
    d.sources?.length ? field('hdd', `From ${d.sources.map((id) => `<a class="chip" href="#source/${id}">${esc(sourceById(id) ? sourceLabel(sourceById(id)) : 'a removed folder')}</a>`).join('')}`) : '',
    renderLocations(d),
    renderVersions(d),
  ];
  $('#lb-info').innerHTML = html.join('');
}

/** A path that shows the file in Finder when clicked, where that's possible. */
const fileLink = (path) => (canReveal()
  ? `<button class="link" data-reveal-path="${esc(path)}" title="${esc(revealLabel())}">${esc(homePath(path))}</button>`
  : `<span class="path">${esc(homePath(path))}</span>`);

function renderLocations(d) {
  const places = [
    ...(d.copy ? [{ what: 'In your library folder', path: d.copy }] : []),
    ...d.files.filter((f) => f.path !== d.copy).map((f) => ({ what: `Original · ${sourceById(f.source_id) ? sourceLabel(sourceById(f.source_id)) : 'removed folder'}`, path: f.path })),
  ];
  return `<div class="field">${icon('folder')}<div><b>Where it is</b>
    ${places.map((p) => `<div class="place"><span>${esc(p.what)}</span>${fileLink(p.path)}</div>`).join('')}</div></div>`;
}

function renderVersions(d) {
  if (!d.versions?.length) return '';
  const n = d.versions.length;
  return `<div class="field">${icon('layers')}<div><b>${n} older ${n === 1 ? 'version' : 'versions'}</b>
    <span>The same shot in other files. Photobox shows and exports this one, the best version; the others stay where they are.</span>
    ${d.versions.map((v) => `<div class="place">
      <span>${esc([v.width && `${v.width} × ${v.height}`, fmtBytes(v.bytes), ...new Set(v.files.map((f) => (sourceById(f.source_id) ? sourceLabel(sourceById(f.source_id)) : '')))].filter(Boolean).join(' · '))}</span>
      ${v.files.map((f) => fileLink(f.path)).join('')}
      ${state.remote ? '' : `<button class="btn small" data-separate="${v.id}">Not the same photo</button>`}
    </div>`).join('')}</div></div>`;
}

$('#lb-info').addEventListener('click', async (e) => {
  const item = state.items[lb.index];
  const path = e.target.closest('[data-reveal-path]')?.dataset.revealPath;
  if (path) return reveal(item, path);
  const other = e.target.closest('[data-separate]')?.dataset.separate;
  if (other) {
    try {
      await api(`/api/media/${item.id}/separate`, { method: 'POST', body: { from: Number(other) } });
      toast('Shown as separate photos');
      showCurrent();
      $('#new-pill').hidden = false;
    } catch (err) {
      toast(err.message);
    }
  }
});

function showFavorite(on) {
  $('#lb-fav').classList.toggle('on', Boolean(on));
  $('#lb-fav').setAttribute('aria-pressed', Boolean(on));
}

function toggleInfo() {
  $('#lb-info-btn').setAttribute('aria-expanded', lightbox.classList.toggle('info-open'));
}

async function toggleFavorite() {
  const item = state.items[lb.index];
  const favorite = !item.favorite;
  const { version } = await api(`/api/media/${item.id}/favorite`, { method: 'POST', body: { favorite } });
  item.favorite = favorite ? 1 : 0;
  lastVersion = version; // our own change - no need to refresh the view
  showFavorite(favorite);
  const badge = tiles.get(item.id)?.querySelector('.fav');
  if (badge) badge.hidden = !favorite;
}

function playLive() {
  const item = state.items[lb.index];
  if (!lb.details?.live_video || stage.querySelector('.lb-live-video')) return;
  const still = stage.querySelector('img');
  const video = document.createElement('video');
  Object.assign(video, { className: 'lb-live-video', autoplay: true, muted: true, playsInline: true, src: `/api/media/${item.id}/live` });
  if (still) Object.assign(video.style, { width: `${still.clientWidth}px`, height: `${still.clientHeight}px` });
  video.onended = video.onerror = () => video.remove();
  stage.append(video);
}

$('#lb-close').addEventListener('click', closeLightbox);
$('#lb-prev').addEventListener('click', () => step(-1));
$('#lb-next').addEventListener('click', () => step(1));
$('#lb-fav').addEventListener('click', toggleFavorite);
$('#lb-live').addEventListener('click', playLive);
$('#lb-live').addEventListener('mouseenter', playLive);
$('#lb-reveal').addEventListener('click', () => reveal(state.items[lb.index]));
$('#lb-copy').addEventListener('click', () => copyImage());
$('#lb-info-btn').addEventListener('click', toggleInfo);

// --- right-click menu ------------------------------------------------------------

/** What a photo's right-click menu offers; `keys` are Electron accelerators, shown as the shortcut. */
function photoActions(item, inViewer) {
  // On one of several selected photos, the menu is about the selection.
  if (!inViewer && selected.has(item.id) && selected.size > 1) {
    return [
      { id: 'deselect', label: 'Deselect', keys: null },
      ...(state.canDelete ? [{ id: 'delete-selected', label: `Delete ${selected.size} Photos…`, keys: 'Backspace', separator: true }] : []),
    ];
  }
  return [
    ...(item.kind === 'image' && canCopy() ? [{ id: 'copy', label: 'Copy Photo', keys: inViewer ? 'CmdOrCtrl+C' : null }] : []),
    ...(canReveal() ? [{ id: 'reveal', label: revealLabel(), keys: null }] : []),
    { id: 'info', label: inViewer && lightbox.classList.contains('info-open') ? 'Hide Info' : 'Get Info', keys: inViewer ? 'I' : null },
    ...(inViewer ? [] : [{ id: selected.has(item.id) ? 'deselect' : 'select', label: selected.has(item.id) ? 'Deselect' : 'Select', keys: null }]),
    ...(state.canDelete ? [{ id: 'delete', label: 'Delete…', keys: inViewer ? 'CmdOrCtrl+Backspace' : null, separator: true }] : []),
  ];
}

function runPhotoAction(id, item, inViewer) {
  if (id === 'copy') copyImage(item);
  else if (id === 'reveal') reveal(item);
  else if (id === 'delete') deletePhoto(item);
  else if (id === 'select' || id === 'deselect') toggleSelected(item);
  else if (id === 'delete-selected') deleteSelected();
  else if (id === 'info' && inViewer) toggleInfo();
  else if (id === 'info') {
    openLightbox(item.id);
    if (!lightbox.classList.contains('info-open')) toggleInfo();
  }
}

const ctxMenu = $('#ctx-menu');
const isMacKeyboard = /Mac|iPhone|iPad/.test(navigator.platform);
const shortcut = (keys) => keys.replace('CmdOrCtrl+', isMacKeyboard ? '⌘' : 'Ctrl+').replace('Backspace', isMacKeyboard ? '⌫' : 'Backspace');

/** The menu outside the desktop app (which shows a native one): resolves with the chosen action's id, or null. */
function pageMenu(actions, e) {
  return new Promise((resolve) => {
    ctxMenu.innerHTML = actions.map((a) => `${a.separator ? '<hr>' : ''}<button role="menuitem" data-action="${a.id}"><span>${esc(a.label)}</span>${a.keys ? `<kbd>${esc(shortcut(a.keys))}</kbd>` : ''}</button>`).join('');
    ctxMenu.hidden = false;
    // At the pointer; opened from the keyboard, at the photo. Never off-screen.
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.target.getBoundingClientRect();
    const { width, height } = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = `${Math.max(4, Math.min(at.x, innerWidth - width - 4))}px`;
    ctxMenu.style.top = `${Math.max(4, Math.min(at.y, innerHeight - height - 4))}px`;
    const buttons = [...ctxMenu.querySelectorAll('button')];
    const returnTo = document.activeElement;
    if (!e.clientX && !e.clientY) buttons[0]?.focus();
    const off = new AbortController();
    const done = (id) => {
      off.abort();
      ctxMenu.hidden = true;
      if (ctxMenu.contains(document.activeElement)) returnTo?.focus({ preventScroll: true });
      resolve(id);
    };
    const listen = (target, type, fn) => target.addEventListener(type, fn, { capture: true, signal: off.signal });
    listen(ctxMenu, 'click', (ev) => { const b = ev.target.closest('button'); if (b) done(b.dataset.action); });
    listen(window, 'pointerdown', (ev) => { if (!ctxMenu.contains(ev.target)) done(null); });
    for (const type of ['blur', 'resize', 'scroll']) listen(window, type, () => done(null));
    // Its keys don't reach the viewer: Esc closes the menu, not the photo. Enter and Space press the focused item.
    listen(window, 'keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || ev.key === 'Tab') {
        ev.preventDefault();
        done(null);
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const i = buttons.indexOf(document.activeElement);
        buttons.at((ev.key === 'ArrowDown' ? i + 1 : (i < 0 ? buttons.length : i) - 1) % buttons.length)?.focus();
      }
    });
  });
}

// Right-click (or a long press, or the menu key) on a photo in the timeline or the viewer.
addEventListener('contextmenu', async (e) => {
  const tile = e.target.closest('.tile');
  const inViewer = !tile && !lightbox.hidden && stage.contains(e.target);
  const item = tile ? state.items.find((i) => i.id === Number(tile.dataset.id)) : inViewer ? state.items[lb.index] : null;
  if (!item) return;
  e.preventDefault();
  const actions = photoActions(item, inViewer);
  const id = desktop?.contextMenu ? await desktop.contextMenu(actions) : await pageMenu(actions, e);
  if (id) runPhotoAction(id, item, inViewer);
});

addEventListener('keydown', (e) => {
  // A dialog over the viewer (deleting) gets its own keys: Esc closes it, not the photo.
  if (askDialog.open) return;
  // With photos selected in the timeline: Esc deselects them, ⌫ or Delete deletes them (after asking).
  if (lightbox.hidden && selecting() && !document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea, [contenteditable]')) {
    if (e.key === 'Escape') clearSelection();
    else if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && state.canDelete) deleteSelected();
    else return;
    e.preventDefault();
    return;
  }
  // ⌫, Delete or ⌘⌫ deletes the photo (after asking).
  if (!lightbox.hidden && (e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && state.canDelete) {
    deletePhoto();
    e.preventDefault();
    return;
  }
  // ⌘C / Ctrl+C copies the photo, unless text is selected (a path in the info panel, say).
  if (!lightbox.hidden && (e.metaKey || e.ctrlKey) && !e.altKey && e.key === 'c' && !getSelection()?.toString()) {
    copyImage();
    e.preventDefault();
    return;
  }
  if (lightbox.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'i') toggleInfo();
  else if (e.key === 'f') toggleFavorite();
  else if (e.key === 'l') playLive();
  else return;
  e.preventDefault();
});

// Swipe between photos on touch screens.
let touchX = null;
stage.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
stage.addEventListener('touchend', (e) => {
  if (touchX == null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  touchX = null;
});

// --- boot ----------------------------------------------------------------------

await poll();
await loadAlbums();
setView();
if (!state.remote) loadDevices();

// Installable as an app, and thumbnails that keep working on a weak connection.
if ('serviceWorker' in navigator && !desktop) navigator.serviceWorker.register('/sw.js').catch(() => {});
