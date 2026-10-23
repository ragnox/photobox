import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA journal_mode = WAL;
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
  date_source TEXT NOT NULL,          -- exif | takeout | filename | upload | file
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

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
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
`;

const IN_ALBUM = 'SELECT f.media_id FROM files f JOIN file_albums fa ON fa.file_id = f.id WHERE fa.album_id = ?';

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

  /** Libraries from before file_albums kept a single album_id on each file. */
  #migrate() {
    if (!this.db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'album_id')) return;
    this.tx(() => {
      this.db.exec('INSERT OR IGNORE INTO file_albums (file_id, album_id) SELECT id, album_id FROM files WHERE album_id IS NOT NULL');
      this.db.exec('DROP INDEX IF EXISTS files_album');
      this.db.exec('ALTER TABLE files DROP COLUMN album_id');
    });
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

  addSource(path) {
    this.q('INSERT OR IGNORE INTO sources (path, added_at) VALUES (?, ?)').run(path, Date.now());
    return this.q('SELECT * FROM sources WHERE path = ?').get(path);
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

  upsertFile({ path, sourceId, mediaId, albumIds = [], size, mtime, sidecar }) {
    this.tx(() => {
      this.q(`
        INSERT INTO files (path, source_id, media_id, size, mtime, sidecar)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (path) DO UPDATE SET
          source_id = excluded.source_id, media_id = excluded.media_id,
          size = excluded.size, mtime = excluded.mtime, sidecar = excluded.sidecar`)
        .run(path, sourceId, mediaId, size, mtime, sidecar ?? null);
      const { id } = this.q('SELECT id FROM files WHERE path = ?').get(path);
      this.q('DELETE FROM file_albums WHERE file_id = ?').run(id);
      for (const albumId of albumIds) this.q('INSERT OR IGNORE INTO file_albums (file_id, album_id) VALUES (?, ?)').run(id, albumId);
    });
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

  media(id) {
    return this.q('SELECT * FROM media WHERE id = ?').get(id);
  }

  insertMedia(m) {
    const { lastInsertRowid } = this.q(`
      INSERT INTO media (hash, kind, filename, taken_at, local_time, date_source, width, height, duration,
        lat, lon, camera, description, people, favorite, archived, thumb_w, thumb_h, bytes, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.hash, m.kind, m.filename, m.takenAt, m.localTime, m.dateSource, m.width ?? null, m.height ?? null,
      m.duration ?? null, m.lat ?? null, m.lon ?? null, m.camera ?? null, m.description ?? null,
      m.people?.length ? JSON.stringify(m.people) : null, m.favorite ? 1 : 0, m.archived ? 1 : 0,
      m.thumbW ?? null, m.thumbH ?? null, m.bytes ?? null, Date.now(),
    );
    return Number(lastInsertRowid);
  }

  /** Replace descriptive metadata with better information (e.g. a sidecar found later). */
  updateMediaMeta(id, m) {
    this.q(`
      UPDATE media SET filename = ?, taken_at = ?, local_time = ?, date_source = ?,
        lat = coalesce(?, lat), lon = coalesce(?, lon), description = coalesce(?, description),
        people = coalesce(?, people), favorite = max(favorite, ?), archived = ?
      WHERE id = ?`).run(
      m.filename, m.takenAt, m.localTime, m.dateSource, m.lat ?? null, m.lon ?? null, m.description ?? null,
      m.people?.length ? JSON.stringify(m.people) : null, m.favorite ? 1 : 0, m.archived ? 1 : 0, id,
    );
  }

  hasSidecar(mediaId) {
    return Boolean(this.q('SELECT 1 FROM files WHERE media_id = ? AND sidecar IS NOT NULL').get(mediaId));
  }

  setFavorite(id, favorite) {
    this.q('UPDATE media SET favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id);
  }

  mediaDetails(id) {
    const m = this.media(id);
    if (!m) return null;
    const files = this.q('SELECT path, size, sidecar FROM files WHERE media_id = ? ORDER BY path').all(id);
    const live = this.q('SELECT id FROM media WHERE live_of = ?').get(id);
    return {
      ...m,
      people: m.people ? JSON.parse(m.people) : [],
      files,
      albums: this.albumNames(id),
      live_video: live?.id ?? null,
    };
  }

  albumNames(mediaId) {
    return this.q(`
      SELECT DISTINCT a.name FROM albums a JOIN file_albums fa ON fa.album_id = a.id JOIN files f ON f.id = fa.file_id
      WHERE f.media_id = ? ORDER BY a.name`).all(mediaId).map((r) => r.name);
  }

  primaryPath(id) {
    return this.q('SELECT path FROM files WHERE media_id = ? ORDER BY length(path) LIMIT 1').get(id)?.path ?? null;
  }

  /**
   * Every media item with its file paths and album names, oldest first. A live
   * photo's clip comes right after its still, so the still is placed first.
   */
  exportItems() {
    const rows = this.q(`
      SELECT m.* FROM media m LEFT JOIN media s ON s.id = m.live_of
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
    const stem = (p) => p.replace(/\.[^./]+$/, '').normalize('NFC').toLowerCase();
    const stills = new Map();
    for (const r of rows) if (r.kind === 'image') stills.set(stem(r.path), r.media_id);
    let linked = 0;
    this.tx(() => {
      for (const r of rows) {
        if (r.kind !== 'video' || r.live_of || (r.duration != null && r.duration > 6)) continue;
        const still = stills.get(stem(r.path));
        if (still) {
          this.q('UPDATE media SET live_of = ? WHERE id = ?').run(still, r.media_id);
          linked++;
        }
      }
    });
    return linked;
  }

  // --- albums & timeline ---------------------------------------------------

  albumId(name) {
    this.q('INSERT OR IGNORE INTO albums (name) VALUES (?)').run(name);
    return this.q('SELECT id FROM albums WHERE name = ?').get(name).id;
  }

  albums() {
    return this.q(`
      SELECT a.id, a.name, count(DISTINCT f.media_id) AS count,
        (SELECT f2.media_id FROM file_albums fa2 JOIN files f2 ON f2.id = fa2.file_id JOIN media m ON m.id = f2.media_id
          WHERE fa2.album_id = a.id AND m.live_of IS NULL ORDER BY m.taken_at DESC LIMIT 1) AS cover
      FROM albums a JOIN file_albums fa ON fa.album_id = a.id JOIN files f ON f.id = fa.file_id
      GROUP BY a.id ORDER BY a.name COLLATE NOCASE`).all();
  }

  /**
   * Page through the timeline, newest first. `cursor` is [taken_at, id] of the
   * last item already shown; direction 'newer' pages back toward the top.
   */
  timeline({ cursor, direction = 'older', limit = 300, view = 'all', albumId = null }) {
    const where = ['m.live_of IS NULL'];
    const params = [];
    if (view === 'favorites') where.push('m.favorite = 1');
    if (view === 'archive') where.push('m.archived = 1');
    else where.push('m.archived = 0');
    if (view === 'videos') where.push("m.kind = 'video'");
    if (albumId) {
      where.push(`m.id IN (${IN_ALBUM})`);
      params.push(albumId);
    }
    const older = direction === 'older';
    if (cursor) {
      where.push(older
        ? '(m.taken_at < ? OR (m.taken_at = ? AND m.id < ?))'
        : '(m.taken_at > ? OR (m.taken_at = ? AND m.id > ?))');
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    const order = older ? 'DESC' : 'ASC';
    const rows = this.db.prepare(`
      SELECT ${TIMELINE_COLUMNS} FROM media m WHERE ${where.join(' AND ')}
      ORDER BY m.taken_at ${order}, m.id ${order} LIMIT ?`).all(...params, limit + 1);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    if (!older) items.reverse();
    return { items, more };
  }

  /** Month buckets for the scrubber. */
  months({ view = 'all', albumId = null } = {}) {
    const where = ['live_of IS NULL', view === 'archive' ? 'archived = 1' : 'archived = 0'];
    const params = [];
    if (view === 'favorites') where.push('favorite = 1');
    if (view === 'videos') where.push("kind = 'video'");
    if (albumId) {
      where.push(`id IN (${IN_ALBUM})`);
      params.push(albumId);
    }
    return this.db.prepare(`
      SELECT substr(local_time, 1, 7) AS month, count(*) AS count, max(taken_at) AS newest
      FROM media WHERE ${where.join(' AND ')} GROUP BY month ORDER BY month DESC`).all(...params);
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
        (SELECT count(*) FROM media WHERE live_of IS NULL AND kind = 'image') AS photos,
        (SELECT count(*) FROM media WHERE live_of IS NULL AND kind = 'video') AS videos,
        (SELECT count(*) FROM media WHERE live_of IS NOT NULL) AS live,
        (SELECT count(*) FROM files) AS files,
        (SELECT count(*) FROM media WHERE favorite = 1) AS favorites,
        (SELECT count(*) FROM media WHERE archived = 1) AS archived`).get();
  }
}
