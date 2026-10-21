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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

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
  filename: 'guessed from the file name',
  upload: 'upload date (Google Takeout)',
  file: 'file modification time',
};

// --- timeline state ------------------------------------------------------------

const PAGE = 400;
const timelineEl = $('#timeline');
const state = {
  view: 'all',
  album: null,
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
};
const months = new Map(); // 'YYYY-MM' -> { el }
const days = new Map(); // 'YYYY-MM-DD' -> { el, header, rows, items }
const tiles = new Map(); // media id -> tile element

function query(extra = {}) {
  const p = new URLSearchParams({ view: state.view, ...extra });
  if (state.album) p.set('album', state.album);
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
}

async function loadOlder() {
  if (state.loading || !state.hasOlder) return;
  state.loading = true;
  const gen = state.generation;
  const last = state.items.at(-1);
  const cursor = last ? `${last.taken_at}:${last.id}` : state.startCursor;
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
  const first = state.items[0];
  try {
    const { items, more } = await api(`/api/timeline?${query({ limit: PAGE, direction: 'newer', cursor: `${first.taken_at}:${first.id}` })}`);
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
    const header = document.createElement('h4');
    header.textContent = fmtDay.format(wallClock(dayKey));
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
    img.src = `/api/media/${item.id}/thumb?v=${item.v}`;
    el.append(img);
  } else {
    el.innerHTML = `<div class="placeholder">${icon(item.kind === 'video' ? 'play' : 'image')}</div>`;
  }
  if (item.kind === 'video') el.insertAdjacentHTML('beforeend', `<span class="badge tr">${item.duration ? fmtDuration(item.duration) : ''}${icon('play')}</span>`);
  else if (item.live) el.insertAdjacentHTML('beforeend', `<span class="badge tr">${icon('live')}</span>`);
  el.insertAdjacentHTML('beforeend', `<span class="badge bl fav" ${item.favorite ? '' : 'hidden'}>${icon('heart')}</span>`);
  tiles.set(item.id, el);
  return el;
}

timelineEl.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) openLightbox(Number(tile.dataset.id));
});

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
  if (album) return { view: 'all', album: Number(album[1]) };
  return { view: ['favorites', 'videos', 'archive'].includes(h) ? h : 'all', album: null };
}

function setView() {
  const { view, album } = parseHash();
  state.view = view;
  state.album = album;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', !album && a.dataset.view === view);
  for (const a of document.querySelectorAll('#albums a')) a.classList.toggle('active', Number(a.dataset.album) === album);
  const albumName = state.albums.find((a) => a.id === album)?.name;
  const title = album ? albumName ?? 'Album' : { favorites: 'Favorites', videos: 'Videos', archive: 'Archive' }[view];
  $('#view-title').hidden = !title;
  $('#view-title').textContent = title ?? '';
  document.body.classList.remove('menu-open');
  resetTimeline();
  scrollTo(0, 0);
  loadMonths();
  loadOlder();
}

addEventListener('hashchange', setView);

async function loadAlbums() {
  state.albums = await api('/api/albums');
  $('#albums').innerHTML = state.albums.length
    ? state.albums.map((a) => `
        <a href="#album/${a.id}" data-album="${a.id}" class="${state.album === a.id ? 'active' : ''}">
          ${a.cover ? `<img src="/api/media/${a.cover}/thumb?v=${a.v}" alt="" loading="lazy">` : '<span class="cover"></span>'}
          <span class="name">${esc(a.name)}</span><span class="count">${a.count}</span>
        </a>`).join('')
    : '<p class="muted small">Albums from Google Takeout show up here</p>';
  if (state.album) $('#view-title').textContent = state.albums.find((a) => a.id === state.album)?.name ?? 'Album';
}

function renderSources(sources) {
  const key = JSON.stringify(sources.map((s) => [s.id, s.files]));
  if (key === renderSources.last) return;
  renderSources.last = key;
  $('#sources').innerHTML = sources.length
    ? sources.map((s) => `
        <div class="source" title="${esc(s.path)}">
          <span class="path">‎${esc(s.path)}</span>
          <span class="muted small">${s.files}</span>
          <button class="icon-btn" data-remove="${s.id}" aria-label="Stop showing ${esc(s.path)}">${icon('x')}</button>
        </div>`).join('')
    : '<p class="muted small" style="margin:4px 12px">No folders yet</p>';
}

$('#sources').addEventListener('click', async (e) => {
  const id = e.target.closest('[data-remove]')?.dataset.remove;
  if (!id) return;
  const source = state.sources.find((s) => s.id === Number(id));
  if (!confirm(`Remove ${source?.path} from Photobox?\n\nYour files stay where they are; only the library entries and thumbnails are removed.`)) return;
  await api(`/api/sources/${id}`, { method: 'DELETE' });
  pollNow();
});

function renderStatus({ indexing }) {
  const el = $('#status');
  el.hidden = !indexing.running;
  // Dock/taskbar progress: >1 is indeterminate, <0 hides it.
  desktop?.setProgress(!indexing.running ? -1 : indexing.total ? indexing.done / indexing.total : 2);
  if (!indexing.running) return;
  const name = indexing.source?.split('/').filter(Boolean).at(-1) ?? '';
  $('#status-text').textContent = indexing.phase === 'scanning'
    ? `Scanning ${name}…`
    : `Importing ${name} · ${indexing.done.toLocaleString()} of ${indexing.total.toLocaleString()}`;
  $('#status-fill').style.width = indexing.total ? `${(100 * indexing.done) / indexing.total}%` : '4%';
}

function renderStats(stats) {
  const parts = [`${stats.photos.toLocaleString()} photos`, `${stats.videos.toLocaleString()} videos`];
  $('#stats').textContent = parts.join(' · ');
}

function updateChrome() {
  $('#load-newer').hidden = !state.hasNewer;
  const empty = $('#empty');
  const isEmpty = !state.items.length && !state.hasOlder && !state.loading;
  empty.hidden = !isEmpty;
  if (!isEmpty) return;
  if (!state.sources.length) {
    empty.innerHTML = `
      <div class="art">${icon('image')}</div>
      <h2>Bring your photos home</h2>
      <p>Add an extracted Google Takeout or any folder of photos. Photobox reads dates, places and albums from the Takeout JSON files, removes duplicates, and keeps watching the folder.</p>
      <button class="btn primary" data-action="add">${icon('plus')}Add folder</button>`;
  } else if (state.running) {
    empty.innerHTML = `<div class="art">${icon('hdd')}</div><h2>Importing…</h2><p>Photos appear here as they're processed.</p>`;
  } else {
    const what = { favorites: 'No favorites yet', videos: 'No videos', archive: 'Nothing archived' }[state.view] ?? 'Nothing here';
    empty.innerHTML = `<div class="art">${icon(state.view === 'favorites' ? 'heart' : 'image')}</div><h2>${what}</h2>`;
  }
}

$('#empty').addEventListener('click', (e) => e.target.closest('[data-action="add"]') && openAddDialog());
$('#newest-btn').addEventListener('click', () => setView());
$('#menu-btn').addEventListener('click', () => document.body.classList.toggle('menu-open'));

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
    $('#lb-reveal').setAttribute('aria-label', revealLabel());
    state.sources = s.sources;
    state.running = s.indexing.running;
    renderStatus(s);
    renderSources(s.sources);
    renderStats(s.stats);
    if (lastVersion !== null && s.version !== lastVersion) libraryChanged();
    if (wasRunning && !state.running) {
      loadAlbums();
      if (Date.now() - lastReload > 500) libraryChanged(true);
    }
    lastVersion = s.version;
    updateChrome();
  } catch {
    // server restarting; try again shortly
  }
  pollTimer = setTimeout(poll, state.running ? 1500 : 5000);
}
const pollNow = () => poll();

function libraryChanged(final = false) {
  const atTop = scrollY < 400 && !state.hasNewer && $('#lightbox').hidden;
  if (!state.items.length || atTop) {
    if (final || Date.now() - lastReload > 3000) {
      lastReload = Date.now();
      loadAlbums();
      setView();
    }
  } else {
    $('#new-pill').hidden = false;
  }
}

$('#new-pill').addEventListener('click', () => {
  $('#new-pill').hidden = true;
  loadAlbums();
  setView();
});

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

async function addSource(path) {
  const source = await api('/api/sources', { method: 'POST', body: { path } });
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
    await addSource(path);
    $('#add-path').value = '';
    dialog.close();
  } catch (err) {
    $('#add-error').textContent = err.message;
  }
});

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

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
  $('#lb-prev').disabled = lb.index === 0;
  $('#lb-next').disabled = lb.index === state.items.length - 1 && !state.hasOlder;
  if (lb.index > state.items.length - 10) loadOlder();

  if (item.kind === 'video') {
    const video = document.createElement('video');
    Object.assign(video, { controls: true, autoplay: true, playsInline: true, src: `/api/media/${item.id}/full` });
    if (item.thumb_w) video.poster = `/api/media/${item.id}/thumb?v=${item.v}`;
    video.onerror = () => showStageMessage("This video format can't play in the browser.", item);
    stage.replaceChildren(video);
  } else {
    // Show the thumbnail immediately, swap in the full image once it's decoded.
    const img = document.createElement('img');
    img.alt = '';
    if (item.thumb_w) img.src = `/api/media/${item.id}/thumb?v=${item.v}`;
    stage.replaceChildren(img);
    const full = new Image();
    full.src = `/api/media/${item.id}/full`;
    full.decode().then(() => token === lb.token && (img.src = full.src)).catch(() => {
      if (token === lb.token && !item.thumb_w) showStageMessage("This file couldn't be decoded.", item);
    });
    // Warm up the neighbours.
    for (const n of [state.items[lb.index + 1], state.items[lb.index - 1]]) {
      if (n?.kind === 'image') new Image().src = `/api/media/${n.id}/full`;
    }
  }

  const when = wallClock(item.local_time);
  $('#lb-date').textContent = `${fmtFull.format(when)} · ${fmtTime.format(when)}`;
  $('#lb-name').textContent = '';
  $('#lb-fav').classList.toggle('on', Boolean(item.favorite));
  $('#lb-live').hidden = true;
  $('#lb-reveal').hidden = !canReveal();

  const details = await api(`/api/media/${item.id}`).catch(() => null);
  if (token !== lb.token || !details) return;
  lb.details = details;
  $('#lb-name').textContent = details.filename;
  $('#lb-live').hidden = !details.live_video;
  renderInfo(details);
}

const canReveal = () => Boolean(desktop) || state.platform === 'darwin';
const revealLabel = () => (state.platform === 'darwin' ? 'Show in Finder' : 'Show in folder');

async function reveal(item) {
  if (!desktop) return api(`/api/media/${item.id}/reveal`, { method: 'POST' });
  const details = lb.details?.id === item.id ? lb.details : await api(`/api/media/${item.id}`);
  if (details.files[0]) desktop.reveal(details.files[0].path);
}

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
    field('hdd', `${d.files.length} ${d.files.length === 1 ? 'copy' : 'copies'} on disk`, d.files.map((f) => esc(f.path)).join('<br>')),
  ];
  $('#lb-info').innerHTML = html.join('');
}

async function toggleFavorite() {
  const item = state.items[lb.index];
  const favorite = !item.favorite;
  const { version } = await api(`/api/media/${item.id}/favorite`, { method: 'POST', body: { favorite } });
  item.favorite = favorite ? 1 : 0;
  lastVersion = version; // our own change - no need to refresh the view
  $('#lb-fav').classList.toggle('on', favorite);
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
$('#lb-info-btn').addEventListener('click', () => lightbox.classList.toggle('info-open'));

addEventListener('keydown', (e) => {
  if (lightbox.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'i') lightbox.classList.toggle('info-open');
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
