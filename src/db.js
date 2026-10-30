import { DatabaseSync } from 'node:sqlite';
import { isMotionClip } from './media.js';
import { pairKey } from './versions.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  added_at INTEGER NOT NULL,
  last_scan_at INTEGER
);

-- One row per unique piece of content (Takeout puts the same photo in several folders).
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                 -- image | video
  filename TEXT NOT NULL,
  taken_at INTEGER NOT NULL,          -- epoch ms, sort key
  local_time TEXT NOT NULL,           -- 'YYYY-MM-DD HH:MM:SS' wall clock where it was taken
  date_source TEXT NOT NULL,          -- exif | takeout | capture | filename | upload | file
  width INTEGER,
  height INTEGER,
  duration REAL,
  lat REAL,
  lon REAL,
  camera TEXT,
  description TEXT,
  people TEXT,                        -- JSON array of names
  favorite INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  live_of INTEGER REFERENCES media(id) ON DELETE SET NULL,  -- video half of a live photo
  thumb_w INTEGER,
  thumb_h INTEGER,
  bytes INTEGER,
  added_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_timeline ON media(taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS media_live_of ON media(live_of);

-- An album belongs to the source it was read from: two Google accounts can each have a "Trip".
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE
);

-- Pairs of files (by SHA-256) the user said are different photos, not versions of one.
CREATE TABLE IF NOT EXISTS separate_versions (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  PRIMARY KEY (a, b)
);

-- Every file on disk that maps to a media row.
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  sidecar TEXT
);
CREATE INDEX IF NOT EXISTS files_media ON files(media_id);
CREATE INDEX IF NOT EXISTS files_source ON files(source_id);

-- A Takeout file sits in one album folder; an exported file can be listed in several albums.
CREATE TABLE IF NOT EXISTS file_albums (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, album_id)
);
CREATE INDEX IF NOT EXISTS file_albums_album ON file_albums(album_id);

-- Phones and other devices paired for network access. Only a hash of each token is kept.
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- Original-byte backup receipts are independent of the sampled-fingerprint media index.
-- Keep originals/receipts after device revocation; ownership uses the immutable token hash.
CREATE TABLE IF NOT EXISTS backup_uploads (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  captured_at TEXT,
  media_store_id TEXT,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading', 'received', 'rejected', 'cancelled')),
  received_at INTEGER
);
CREATE INDEX IF NOT EXISTS backup_uploads_owner ON backup_uploads(owner_hash, sha256);
CREATE INDEX IF NOT EXISTS backup_uploads_state ON backup_uploads(state);

CREATE TABLE IF NOT EXISTS backup_destinations (
  path TEXT PRIMARY KEY,
  marker TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_exports (
  upload_id TEXT PRIMARY KEY REFERENCES backup_uploads(id),
  root TEXT NOT NULL,
  marker TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL,
  ctime_ns TEXT NOT NULL
);

-- Exported files whose SHA-256 an export checked, and the file's stamps then: unchanged, it isn't read again for a while.
CREATE TABLE IF NOT EXISTS export_checks (
  path TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  dev TEXT NOT NULL,
  ino TEXT NOT NULL,
  mtime_ns TEXT NOT NULL,
  ctime_ns TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
`;

// A superseded version counts as the version that replaced it: it stays in its album and source.
const SHOWN_AS = 'coalesce(v.superseded_by, v.id)';
const IN_ALBUM = `SELECT ${SHOWN_AS} FROM files f JOIN file_albums fa ON fa.file_id = f.id JOIN media v ON v.id = f.media_id WHERE fa.album_id = ?`;
const IN_SOURCE = `SELECT ${SHOWN_AS} FROM files f JOIN media v ON v.id = f.media_id WHERE f.source_id = ?`;

const TIMELINE_COLUMNS = `
  m.id, substr(m.hash, 1, 10) AS v, m.kind, m.taken_at, m.local_time, m.thumb_w, m.thumb_h, m.width, m.height, m.duration, m.favorite,
  EXISTS (SELECT 1 FROM media v WHERE v.live_of = m.id) AS live`;

export class Library {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.stmts = new Map();
    this.#migrate();
  }

  #hasColumn(table, name) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
  }

  #migrate() {
    const add = (table, name, type) => {
      if (!this.#hasColumn(table, name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    };
    add('sources', 'managed', 'TEXT');
    add('sources', 'name', 'TEXT');
    add('media', 'sha256', 'TEXT');
    add('media', 'quick_hash', 'TEXT');
    // '' once looked at and found to record too little to match other versions.
    add('media', 'shot_key', 'TEXT');
    add('media', 'dhash', 'TEXT');
    add('media', 'superseded_by', 'INTEGER REFERENCES media(id) ON DELETE SET NULL');
    add('files', 'sha256', 'TEXT');
    add('files', 'mtime_ns', 'TEXT');
    add('files', 'ctime_ns', 'TEXT');
    add('backup_uploads', 'indexed_at', 'INTEGER');
    add('backup_uploads', 'last_error', 'TEXT');
    this.db.exec(`
      UPDATE media SET quick_hash = hash WHERE quick_hash IS NULL AND length(hash) = 40;
      CREATE UNIQUE INDEX IF NOT EXISTS media_sha256 ON media(sha256) WHERE sha256 IS NOT NULL;
      CREATE INDEX IF NOT EXISTS media_quick_hash ON media(quick_hash);
      CREATE INDEX IF NOT EXISTS media_shot_key ON media(shot_key) WHERE shot_key <> '';
      CREATE INDEX IF NOT EXISTS media_superseded_by ON media(superseded_by);
    `);
    // Libraries from before file_albums kept a single album_id on each file.
    if (this.#hasColumn('files', 'album_id')) {
      this.tx(() => {
        this.db.exec('INSERT OR IGNORE INTO file_albums (file_id, album_id) SELECT id, album_id FROM files WHERE album_id IS NOT NULL');
        this.db.exec('DROP INDEX IF EXISTS files_album');
        this.db.exec('ALTER TABLE files DROP COLUMN album_id');
      });
    }
    if (!this.#hasColumn('albums', 'source_id')) this.#splitAlbumsBySource();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS albums_source_name ON albums(coalesce(source_id, 0), name)');
  }

  /**
   * Albums used to be one per name, across all sources. Each becomes one album per source
   * its files came from; the source with the most files keeps the album's id.
   */
  #splitAlbumsBySource() {
    // SQLite can't drop a UNIQUE constraint, so the table is rebuilt (with foreign keys off,
    // which only takes effect outside a transaction).
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.tx(() => {
        this.db.exec('CREATE TABLE albums_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE)');
        const names = new Map(this.db.prepare('SELECT id, name FROM albums').all().map((a) => [a.id, a.name]));
        const parts = this.db.prepare(`
          SELECT fa.album_id, f.source_id, count(*) AS n FROM file_albums fa JOIN files f ON f.id = fa.file_id
          GROUP BY fa.album_id, f.source_id ORDER BY fa.album_id, n DESC, f.source_id`).all();
        const kept = new Set();
        const insert = this.db.prepare('INSERT INTO albums_new (id, name, source_id) VALUES (?, ?, ?)');
        for (const p of parts) {
          if (kept.has(p.album_id)) continue;
          kept.add(p.album_id);
          insert.run(p.album_id, names.get(p.album_id), p.source_id);
        }
        // Only after every kept id is taken, so new ids can't collide with one.
        const seen = new Set();
        for (const p of parts) {
          if (!seen.has(p.album_id)) { seen.add(p.album_id); continue; }
          const id = Number(insert.run(null, names.get(p.album_id), p.source_id).lastInsertRowid);
          this.db.prepare('UPDATE file_albums SET album_id = ? WHERE album_id = ? AND file_id IN (SELECT id FROM files WHERE source_id = ?)')
            .run(id, p.album_id, p.source_id);
        }
        this.db.exec('DROP TABLE albums');
        this.db.exec('ALTER TABLE albums_new RENAME TO albums');
      });
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  q(sql) {
    let stmt = this.stmts.get(sql);
    if (!stmt) this.stmts.set(sql, (stmt = this.db.prepare(sql)));
    return stmt;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // --- sources -------------------------------------------------------------

  sources() {
    return this.q(`
      SELECT s.*, (SELECT count(*) FROM files f WHERE f.source_id = s.id) AS files
      FROM sources s ORDER BY s.path`).all();
  }

  source(id) {
    return this.q('SELECT * FROM sources WHERE id = ?').get(id);
  }

  addSource(path, managed = null, name = null) {
    this.q('INSERT OR IGNORE INTO sources (path, added_at, managed, name) VALUES (?, ?, ?, ?)').run(path, Date.now(), managed, name);
    return this.q('SELECT * FROM sources WHERE path = ?').get(path);
  }

  /**
   * The archive's own photos: a source at the archive's root that Photobox manages, which
   * follows the archive when it moves.
   */
  archiveSource(root) {
    const current = this.q("SELECT id FROM sources WHERE managed = 'archive'").get();
    if (current) this.q('UPDATE sources SET path = ? WHERE id = ?').run(root, current.id);
    else this.q("INSERT INTO sources (path, added_at, managed) VALUES (?, ?, 'archive') ON CONFLICT (path) DO UPDATE SET managed = 'archive'").run(root, Date.now());
    return this.q("SELECT * FROM sources WHERE managed = 'archive'").get();
  }

  /** The name a source is shown under ("Google, main account"); null shows its folder. */
  setSourceName(id, name) {
    this.q('UPDATE sources SET name = ? WHERE id = ?').run(name, id);
  }

  markScanned(id) {
    this.q('UPDATE sources SET last_scan_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Remove a source and everything only it referenced. Returns hashes of deleted media. */
  removeSource(id) {
    return this.tx(() => {
      this.q('DELETE FROM sources WHERE id = ?').run(id);
      return this.pruneOrphans();
    });
  }

  // --- files ---------------------------------------------------------------

  fileByPath(path) {
    return this.q('SELECT * FROM files WHERE path = ?').get(path);
  }

  filePathsForSource(sourceId) {
    return this.q('SELECT path FROM files WHERE source_id = ?').all(sourceId).map((r) => r.path);
  }

  upsertFile({ path, sourceId, mediaId, albumIds = [], size, mtime, sidecar, sha256, mtimeNs, ctimeNs }) {
    this.tx(() => {
      this.q(`
        INSERT INTO files (path, source_id, media_id, size, mtime, sidecar, sha256, mtime_ns, ctime_ns)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (path) DO UPDATE SET
          source_id = excluded.source_id, media_id = excluded.media_id,
          size = excluded.size, mtime = excluded.mtime, sidecar = excluded.sidecar,
          sha256 = excluded.sha256, mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns`)
        .run(path, sourceId, mediaId, size, mtime, sidecar ?? null, sha256 ?? null, mtimeNs ?? null, ctimeNs ?? null);
      this.setFileAlbums(this.q('SELECT id FROM files WHERE path = ?').get(path).id, albumIds);
    });
  }

  /** Put a file in exactly these albums. Returns whether anything changed. */
  setFileAlbums(fileId, albumIds) {
    const now = this.q('SELECT album_id FROM file_albums WHERE file_id = ? ORDER BY album_id').all(fileId).map((r) => r.album_id);
    const wanted = [...new Set(albumIds)].sort((a, b) => a - b);
    if (now.length === wanted.length && now.every((id, i) => id === wanted[i])) return false;
    this.q('DELETE FROM file_albums WHERE file_id = ?').run(fileId);
    for (const albumId of wanted) this.q('INSERT INTO file_albums (file_id, album_id) VALUES (?, ?)').run(fileId, albumId);
    return true;
  }

  /** Delete file rows; returns hashes of media that no longer have any file. */
  removeFiles(paths) {
    return this.tx(() => {
      for (const path of paths) this.q('DELETE FROM files WHERE path = ?').run(path);
      return this.pruneOrphans();
    });
  }

  pruneOrphans() {
    const orphans = this.q('SELECT id, hash FROM media WHERE id NOT IN (SELECT media_id FROM files)').all();
    for (const { id } of orphans) this.q('DELETE FROM media WHERE id = ?').run(id);
    this.q('DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM file_albums)').run();
    return orphans.map((o) => o.hash);
  }

  // --- media ---------------------------------------------------------------

  mediaByHash(hash) {
    return this.q('SELECT * FROM media WHERE hash = ?').get(hash);
  }

  mediaBySha256(sha256) {
    return this.q('SELECT * FROM media WHERE sha256 = ?').get(sha256);
  }

  media(id) {
    return this.q('SELECT * FROM media WHERE id = ?').get(id);
  }

  insertMedia(m) {
    const { lastInsertRowid } = this.q(`
      INSERT INTO media (hash, kind, filename, taken_at, local_time, date_source, width, height, duration,
        lat, lon, camera, description, people, favorite, archived, thumb_w, thumb_h, bytes, added_at, sha256, quick_hash,
        shot_key, dhash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.hash, m.kind, m.filename, m.takenAt, m.localTime, m.dateSource, m.width ?? null, m.height ?? null,
      m.duration ?? null, m.lat ?? null, m.lon ?? null, m.camera ?? null, m.description ?? null,
      m.people?.length ? JSON.stringify(m.people) : null, m.favorite ? 1 : 0, m.archived ? 1 : 0,
      m.thumbW ?? null, m.thumbH ?? null, m.bytes ?? null, Date.now(), m.sha256 ?? null,
      m.quickHash ?? (/^[a-f0-9]{40}$/.test(m.hash) ? m.hash : null), m.shotKey ?? null, m.dhash ?? null,
    );
    return Number(lastInsertRowid);
  }

  /** Replace descriptive metadata with better information (e.g. a sidecar found later). */
  updateMediaMeta(id, m) {
    this.q(`
      UPDATE media SET filename = ?, taken_at = ?, local_time = ?, date_source = ?,
        lat = coalesce(?, lat), lon = coalesce(?, lon), description = coalesce(?, description),
        people = coalesce(?, people), favorite = max(favorite, ?), archived = ?, shot_key = coalesce(?, shot_key)
      WHERE id = ?`).run(
      m.filename, m.takenAt, m.localTime, m.dateSource, m.lat ?? null, m.lon ?? null, m.description ?? null,
      m.people?.length ? JSON.stringify(m.people) : null, m.favorite ? 1 : 0, m.archived ? 1 : 0, m.shotKey ?? null, id,
    );
  }

  hasSidecar(mediaId) {
    return Boolean(this.q('SELECT 1 FROM files WHERE media_id = ? AND sidecar IS NOT NULL').get(mediaId));
  }

  /** What an export last found an exported file to be, by its absolute path (see export_checks). */
  exportCheck(file) {
    return this.q('SELECT * FROM export_checks WHERE path = ?').get(file);
  }

  rememberExportCheck(file, { sha256, size, dev, ino, mtimeNs, ctimeNs }) {
    this.q(`INSERT INTO export_checks (path, sha256, size, dev, ino, mtime_ns, ctime_ns, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, dev = excluded.dev, ino = excluded.ino,
        mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns, checked_at = excluded.checked_at`)
      .run(file, sha256, size, dev, ino, mtimeNs, ctimeNs, Date.now());
  }

  /** Checks older than `before` (epoch ms) are read again anyway, so they go. */
  forgetExportChecks(before) {
    this.q('DELETE FROM export_checks WHERE checked_at < ?').run(before);
  }

  /** Has the item a file outside the archive: an original, not a copy an export made? */
  hasOriginal(mediaId) {
    return Boolean(this.q("SELECT 1 FROM files f JOIN sources s ON s.id = f.source_id WHERE f.media_id = ? AND s.managed IS NOT 'archive'").get(mediaId));
  }

  /** Versions follow: a favorite stays one (or stays not one) whichever version is shown. */
  setFavorite(id, favorite) {
    this.q('UPDATE media SET favorite = ? WHERE id = ? OR superseded_by = ?').run(favorite ? 1 : 0, id, id);
  }

  mediaDetails(id) {
    const m = this.media(id);
    if (!m) return null;
    const files = this.q(`
      SELECT f.path, f.size, f.sidecar, f.source_id FROM files f WHERE f.media_id = ? ORDER BY f.path`).all(id);
    const live = this.q('SELECT id FROM media WHERE live_of = ?').get(id);
    const versions = this.q(`
      SELECT id, filename, kind, bytes, width, height, sha256 FROM media WHERE superseded_by = ? ORDER BY bytes DESC, id`).all(id)
      .map((v) => ({ ...v, files: this.q('SELECT path, size, source_id FROM files WHERE media_id = ? ORDER BY path').all(v.id) }));
    // Every source this photo came from, its versions' sources included. The archive is where it
    // is, not where it came from, unless it came from nowhere else.
    let sources = [...new Set([...files, ...versions.flatMap((v) => v.files)].map((f) => f.source_id))];
    const archive = this.q("SELECT id FROM sources WHERE managed = 'archive'").get()?.id;
    if (sources.length > 1) sources = sources.filter((id) => id !== archive);
    return {
      ...m,
      people: m.people ? JSON.parse(m.people) : [],
      files,
      versions,
      sources,
      albums: this.albumNames(id),
      live_video: live?.id ?? null,
    };
  }

  /** Albums a media item is in, its superseded versions' albums included. */
  albumNames(mediaId) {
    return this.q(`
      SELECT DISTINCT a.name FROM albums a JOIN file_albums fa ON fa.album_id = a.id JOIN files f ON f.id = fa.file_id
      WHERE f.media_id = ? OR f.media_id IN (SELECT id FROM media WHERE superseded_by = ?) ORDER BY a.name`)
      .all(mediaId, mediaId).map((r) => r.name);
  }

  primaryPath(id) {
    return this.q('SELECT path FROM files WHERE media_id = ? ORDER BY length(path) LIMIT 1').get(id)?.path ?? null;
  }

  /**
   * Every media item with its file paths and album names, oldest first. A live
   * photo's clip comes right after its still, so the still is placed first.
   */
  exportItems() {
    // Superseded versions stay out: the version that replaced them is exported instead.
    const rows = this.q(`
      SELECT m.* FROM media m LEFT JOIN media s ON s.id = m.live_of
      WHERE m.superseded_by IS NULL AND s.superseded_by IS NULL
      ORDER BY coalesce(s.taken_at, m.taken_at), coalesce(m.live_of, m.id), m.live_of IS NOT NULL`).all();
    return rows.map((m) => ({
      ...m,
      paths: this.q('SELECT path FROM files WHERE media_id = ? ORDER BY length(path), path').all(m.id).map((f) => f.path),
      albums: this.albumNames(m.id),
    }));
  }

  /** Mark short videos that sit next to a same-named photo as the motion part of a live photo. */
  linkLivePhotos(sourceId) {
    const rows = this.q(`
      SELECT f.path, f.media_id, m.kind, m.duration, m.live_of FROM files f
      JOIN media m ON m.id = f.media_id WHERE f.source_id = ?`).all(sourceId);
    const key = (p) => p.normalize('NFC').toLowerCase();
    const stem = (p) => key(p).replace(/\.[^./]+$/, '');
    // "IMG_1.HEIC" + "IMG_1.MOV", and a Pixel motion photo from Takeout: "X.MP.jpg" + "X.MP".
    const clipStem = (p) => (isMotionClip(p) ? key(p) : stem(p));
    const stills = new Map();
    for (const r of rows) if (r.kind === 'image') stills.set(stem(r.path), r.media_id);
    this.tx(() => {
      for (const r of rows) {
        if (r.kind !== 'video' || r.live_of || (r.duration != null && r.duration > 6)) continue;
        const still = stills.get(clipStem(r.path));
        if (still) this.q('UPDATE media SET live_of = ? WHERE id = ?').run(still, r.media_id);
      }
    });
  }

  // --- albums & timeline ---------------------------------------------------

  /** The album of this name in this source (null: not read from a source, e.g. in tests). */
  albumId(name, sourceId = null) {
    this.q('INSERT OR IGNORE INTO albums (name, source_id) VALUES (?, ?)').run(name, sourceId);
    return this.q('SELECT id FROM albums WHERE coalesce(source_id, 0) = coalesce(?, 0) AND name = ?').get(sourceId, name).id;
  }

  albums() {
    return this.q(`
      WITH members AS (
        SELECT DISTINCT fa.album_id, ${SHOWN_AS} AS media_id
        FROM file_albums fa JOIN files f ON f.id = fa.file_id JOIN media v ON v.id = f.media_id)
      SELECT a.id, a.name, a.source_id, count(*) AS count,
        (SELECT m2.id FROM members mb2 JOIN media m2 ON m2.id = mb2.media_id
          WHERE mb2.album_id = a.id AND m2.live_of IS NULL AND m2.archived = 0 ORDER BY m2.taken_at DESC LIMIT 1) AS cover
      FROM albums a JOIN members mb ON mb.album_id = a.id JOIN media m ON m.id = mb.media_id
      -- What the album view shows: no live-photo clips, nothing archived.
      WHERE m.live_of IS NULL AND m.archived = 0
      GROUP BY a.id ORDER BY a.name COLLATE NOCASE, a.source_id`).all();
  }

  /** WHERE conditions and parameters for a view ('all', 'favorites', 'videos', 'archive'), an optional album and source. */
  #viewFilter(view, albumId, sourceId) {
    const where = ['m.live_of IS NULL', 'm.superseded_by IS NULL', view === 'archive' ? 'm.archived = 1' : 'm.archived = 0'];
    const params = [];
    if (view === 'favorites') where.push('m.favorite = 1');
    if (view === 'videos') where.push("m.kind = 'video'");
    if (albumId) {
      where.push(`m.id IN (${IN_ALBUM})`);
      params.push(albumId);
    }
    if (sourceId) {
      where.push(`m.id IN (${IN_SOURCE})`);
      params.push(sourceId);
    }
    return { where, params };
  }

  /**
   * Page through the timeline, newest first. `cursor` is [taken_at, id] of the
   * last item already shown; direction 'newer' pages back toward the top.
   */
  timeline({ cursor, direction = 'older', limit = 300, view = 'all', albumId = null, sourceId = null }) {
    const { where, params } = this.#viewFilter(view, albumId, sourceId);
    const older = direction === 'older';
    if (cursor) {
      where.push(older
        ? '(m.taken_at < ? OR (m.taken_at = ? AND m.id < ?))'
        : '(m.taken_at > ? OR (m.taken_at = ? AND m.id > ?))');
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    const order = older ? 'DESC' : 'ASC';
    const rows = this.q(`
      SELECT ${TIMELINE_COLUMNS} FROM media m WHERE ${where.join(' AND ')}
      ORDER BY m.taken_at ${order}, m.id ${order} LIMIT ?`).all(...params, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    if (!older) items.reverse();
    return { items, more };
  }

  /** Month buckets for the scrubber. */
  months({ view = 'all', albumId = null, sourceId = null } = {}) {
    const { where, params } = this.#viewFilter(view, albumId, sourceId);
    return this.q(`
      SELECT substr(m.local_time, 1, 7) AS month, count(*) AS count, max(m.taken_at) AS newest
      FROM media m WHERE ${where.join(' AND ')} GROUP BY month ORDER BY month DESC`).all(...params);
  }

  // --- versions ------------------------------------------------------------

  /** Items that share their shot key with another: what findVersions compares. */
  versionCandidates() {
    return this.q(`
      SELECT id, shot_key, dhash, kind, bytes, duration, sha256 FROM media
      WHERE shot_key <> '' AND live_of IS NULL AND shot_key IN (
        SELECT shot_key FROM media WHERE shot_key <> '' AND live_of IS NULL GROUP BY shot_key HAVING count(*) > 1)`).all()
      .map((m) => {
        const sources = this.q('SELECT DISTINCT f.source_id, s.managed FROM files f JOIN sources s ON s.id = f.source_id WHERE f.media_id = ?').all(m.id);
        return {
          id: m.id, shotKey: m.shot_key, dhash: m.dhash, bytes: m.bytes, sha256: m.sha256,
          duration: m.kind === 'video' ? m.duration : null,
          sources: sources.map((s) => s.source_id),
          original: sources.some((s) => s.managed === 'backup'),
        };
      });
  }

  /** SHA-256 of the version shown in place of the item with this content, if one replaced it. */
  replacementOf(sha256) {
    return this.q('SELECT s.sha256 FROM media v JOIN media s ON s.id = v.superseded_by WHERE v.sha256 = ?').get(sha256)?.sha256 ?? null;
  }

  separatePairs() {
    return new Set(this.q('SELECT a, b FROM separate_versions').all().map((r) => pairKey(r.a, r.b)));
  }

  /** The user says these two are different photos: never treat them as versions of one. */
  keepApart(id1, id2) {
    const [a, b] = [this.media(id1)?.sha256, this.media(id2)?.sha256].sort();
    if (!a || !b) return false;
    this.q('INSERT OR IGNORE INTO separate_versions (a, b) VALUES (?, ?)').run(a, b);
    return true;
  }

  /**
   * Record which items are superseded by which (a Map from findVersions; everything else is
   * shown again), and carry what the superseded versions knew over to the version shown.
   * A live photo's clip goes along: the shown version's own clip replaces it, or it moves
   * over if the shown version has none. Returns whether anything changed.
   */
  applyVersions(superseded) {
    return this.tx(() => {
      let changes = 0;
      const wanted = new Map(superseded);
      for (const [version, shown] of superseded) {
        const clip = this.q('SELECT id FROM media WHERE live_of = ?').get(version)?.id;
        if (!clip) continue;
        const own = this.q('SELECT id FROM media WHERE live_of = ?').get(shown)?.id;
        if (own) wanted.set(clip, own);
        else changes += this.q('UPDATE media SET live_of = ? WHERE id = ?').run(shown, clip).changes;
      }
      for (const { id, superseded_by } of this.q('SELECT id, superseded_by FROM media WHERE superseded_by IS NOT NULL').all()) {
        if (wanted.get(id) !== superseded_by) changes += this.q('UPDATE media SET superseded_by = NULL WHERE id = ?').run(id).changes;
      }
      for (const [id, by] of wanted) {
        changes += this.q('UPDATE media SET superseded_by = ? WHERE id = ? AND superseded_by IS NOT ?').run(by, id, by).changes;
      }
      const merge = this.q(`
        UPDATE media AS m SET favorite = max(m.favorite, v.favorite), archived = max(m.archived, v.archived),
          description = coalesce(m.description, v.description), people = coalesce(m.people, v.people),
          lat = CASE WHEN m.lat IS NULL THEN v.lat ELSE m.lat END, lon = CASE WHEN m.lat IS NULL THEN v.lon ELSE m.lon END
        FROM media AS v WHERE m.id = ? AND v.id = ? AND (v.favorite > m.favorite OR v.archived > m.archived
          OR (m.description IS NULL AND v.description IS NOT NULL) OR (m.people IS NULL AND v.people IS NOT NULL)
          OR (m.lat IS NULL AND v.lat IS NOT NULL))`);
      for (const [version, shown] of superseded) changes += merge.run(shown, version).changes;
      return changes > 0;
    });
  }

  // --- devices -------------------------------------------------------------

  addDevice(name, tokenHash) {
    const { lastInsertRowid } = this.q('INSERT INTO devices (name, token_hash, created_at) VALUES (?, ?, ?)')
      .run(name, tokenHash, Date.now());
    return this.q('SELECT id, name, created_at, last_seen_at FROM devices WHERE id = ?').get(Number(lastInsertRowid));
  }

  deviceByTokenHash(tokenHash) {
    return this.q('SELECT id, name, created_at, last_seen_at FROM devices WHERE token_hash = ?').get(tokenHash);
  }

  devices() {
    return this.q('SELECT id, name, created_at, last_seen_at FROM devices ORDER BY created_at').all();
  }

  touchDevice(id) {
    this.q('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
  }

  removeDevice(id) {
    return this.q('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
  }

  stats() {
    return this.q(`
      SELECT
        (SELECT count(*) FROM media WHERE live_of IS NULL AND superseded_by IS NULL AND kind = 'image') AS photos,
        (SELECT count(*) FROM media WHERE live_of IS NULL AND superseded_by IS NULL AND kind = 'video') AS videos,
        (SELECT count(*) FROM media WHERE live_of IS NOT NULL) AS live,
        (SELECT count(*) FROM media WHERE live_of IS NULL AND superseded_by IS NOT NULL) AS versions,
        (SELECT count(*) FROM files) AS files,
        (SELECT count(*) FROM media WHERE favorite = 1) AS favorites,
        (SELECT count(*) FROM media WHERE archived = 1) AS archived`).get();
  }
}
