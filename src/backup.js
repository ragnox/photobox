// Verified inbox -> media index -> plain-files export. SQLite is the retry queue;
// files and a destination marker, not historical receipts, determine current proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digestFile, isInside, syncDirectory, statOrNull } from './files.js';
import { exportLibrary, regularDestination } from './export.js';

const MARKER = '.photobox-backup.json';

async function markerAt(root) {
  if (!(await fs.stat(root)).isDirectory()) throw new Error('Backup destination is not a directory');
  const markerFile = path.join(root, MARKER);
  if (!(await fs.lstat(markerFile)).isFile()) throw new Error('Backup destination marker is not a regular file');
  const value = JSON.parse(await fs.readFile(markerFile, 'utf8'));
  if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) throw new Error('Invalid backup destination marker');
  return value.id;
}

export class BackupQueue {
  constructor(library, indexer, uploads, config) {
    Object.assign(this, { library, indexer, uploads, config });
    this.closed = false;
    this.pending = false;
    this.running = null;
    this.refreshMetadata = false;
    this.repair = new Set();
    this.status = { running: false, configured: Boolean(config.backupDir), phase: 'idle', done: 0, total: 0, currentFile: null,
      received: 0, indexed: 0, exported: 0, failed: 0, error: null, lastRun: null, lastSuccess: null };
    uploads.onReceived = () => this.request();
    this.onRun = null; // ({ copied, failed, error, destination }) after each run
    uploads.assetState = (row) => this.proof(row);
    this.retry = setInterval(() => this.request(), config.backupRetryMs);
    this.retry.unref();
  }

  request(refreshMetadata = false) {
    if (this.closed) return;
    this.pending = true;
    this.refreshMetadata ||= refreshMetadata;
    if (!this.running && !this.soon) {
      this.soon = setTimeout(() => { this.soon = null; this.flush().catch(() => {}); }, 200);
      this.soon.unref();
    }
  }

  async flush() {
    clearTimeout(this.soon);
    this.soon = null;
    if (this.closed) return;
    this.pending = true;
    if (!this.running) {
      this.running = (async () => {
        while (this.pending && !this.closed) {
          this.pending = false;
          this.status.running = true;
          try { await this.run(); } catch (err) {
            this.status.error = err.message;
            this.onRun?.({ copied: 0, failed: 0, error: err.message, destination: this.config.backupDir });
          }
          this.status.running = false;
          Object.assign(this.status, { phase: 'idle', currentFile: null });
        }
      })().finally(() => { this.running = null; });
    }
    await this.running;
  }

  async close() {
    this.closed = true;
    clearInterval(this.retry);
    clearTimeout(this.soon);
    await this.running;
  }

  async destination(root = this.config.backupDir) {
    if (!root) return null;
    // Never create a missing root: it may be an unplugged drive's mount point.
    const canonical = await fs.realpath(root);
    const data = await fs.realpath(this.config.dataDir);
    if (canonical === data || isInside(canonical, data) || isInside(data, canonical)) throw new Error('Backup destination must be separate from Photobox data');
    if (!(await fs.stat(root)).isDirectory()) throw new Error('Backup destination is unavailable');
    const known = this.library.q('SELECT marker FROM backup_destinations WHERE path = ?').get(root);
    let marker;
    try { marker = await markerAt(root); } catch (err) {
      if (known || err.code !== 'ENOENT') throw new Error('Backup destination is unavailable or its marker is missing');
      marker = randomUUID();
      const partial = path.join(root, `.${marker}.partial`);
      try {
        const handle = await fs.open(partial, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, id: marker })); await handle.sync(); } finally { await handle.close(); }
        await fs.link(partial, path.join(root, MARKER));
      } finally { await fs.rm(partial, { force: true }); }
      await syncDirectory(root);
    }
    if (known && known.marker !== marker) throw new Error('Backup destination marker changed');
    this.library.q('INSERT OR IGNORE INTO backup_destinations (path, marker) VALUES (?, ?)').run(root, marker);
    return { root, marker };
  }

  async assertDestination({ root, marker }) {
    if (this.config.backupDir !== root || await markerAt(root) !== marker) throw new Error('Backup destination is unavailable or changed');
  }

  indexed(row) {
    const file = this.library.fileByPath(this.uploads.destination(row));
    const media = file && this.library.media(file.media_id);
    return file?.sha256 === row.sha256 && media?.sha256 === row.sha256 ? media : null;
  }

  async proof(row) {
    const indexed = Boolean(this.indexed(row));
    let exported = false;
    const receipt = this.library.q('SELECT * FROM backup_exports WHERE upload_id = ?').get(row.id);
    if (indexed && receipt && this.config.backupDir === receipt.root) {
      try {
        await this.assertDestination(receipt);
        if (await regularDestination(receipt.root, receipt.relative_path)) {
          const current = await digestFile(path.join(receipt.root, receipt.relative_path), false,
            (done) => this.uploads.report(row, 'checking-export', done));
          exported = current.sha256 === row.sha256 && current.size === row.size;
          await this.assertDestination(receipt);
        }
      } catch { exported = false; }
    }
    if (!indexed || (this.config.backupDir && !exported)) { this.repair.add(row.id); this.request(); }
    return { indexed, exported };
  }

  async run() {
    const refreshMetadata = this.refreshMetadata;
    this.refreshMetadata = false;
    this.status.lastRun = Date.now();
    this.status.error = null;
    const rows = [];
    for (const row of this.library.q("SELECT * FROM backup_uploads WHERE state = 'received' ORDER BY created_at, id").all()) {
      if (!this.library.isDeleted(row.sha256)) { rows.push(row); continue; }
      // Deleted in Photobox while it was on its way: the original in the inbox goes too (see deletions.js).
      const file = this.uploads.destination(row);
      if (await statOrNull(file) && this.library.deletedCopy(row.sha256, file, path.join(this.config.inboxDir, String(row.device_id)))) this.indexer.emit('deleted-found');
    }
    Object.assign(this.status, { phase: 'indexing', done: 0, total: rows.length, currentFile: null });
    Object.assign(this.status, { received: rows.length, indexed: 0, exported: 0, failed: 0 });
    let destination = null;
    let destinationError = null;
    try { destination = await this.destination(); } catch (err) { destinationError = err; this.status.error = err.message; }
    const pending = [];
    let copied = 0;
    for (const row of rows) {
      if (this.closed) break;
      this.status.currentFile = row.filename;
      try {
        await this.uploads.locked(row.id, async () => {
          const source = this.uploads.destination(row);
          const stamp = await fs.stat(source, { bigint: true });
          const file = this.library.fileByPath(source);
          let media = this.indexed(row);
          if (!media || file.mtime_ns !== String(stamp.mtimeNs) || file.ctime_ns !== String(stamp.ctimeNs)) {
            const verified = await digestFile(source);
            if (verified.sha256 !== row.sha256 || verified.size !== row.size) throw new Error('Inbox original failed SHA-256 verification');
            const root = path.join(this.config.inboxDir, String(row.device_id));
            const managed = this.library.addSource(root, 'backup');
            if (managed.managed !== 'backup') throw new Error('Inbox is already registered as an ordinary source');
            media = await this.indexer.indexUpload(managed, source, row);
            this.library.q('UPDATE backup_uploads SET indexed_at = ? WHERE id = ?').run(Date.now(), row.id);
          }
          this.status.indexed++;
          if (destinationError) throw destinationError;
          const receipt = this.library.q('SELECT * FROM backup_exports WHERE upload_id = ?').get(row.id);
          let current = false;
          if (destination && receipt?.root === destination.root && receipt.marker === destination.marker &&
              !refreshMetadata && !this.repair.has(row.id) && await regularDestination(receipt.root, receipt.relative_path)) {
            const info = await fs.stat(path.join(receipt.root, receipt.relative_path), { bigint: true });
            current = Number(info.size) === row.size && String(info.mtimeNs) === receipt.mtime_ns && String(info.ctimeNs) === receipt.ctime_ns;
          }
          if (current) this.status.exported++;
          else if (destination) pending.push({ row, media });
          this.library.q('UPDATE backup_uploads SET last_error = NULL WHERE id = ?').run(row.id);
        });
      } catch (err) { this.failed(row, err); }
      this.status.done++;
    }
    if (pending.length && !this.closed) {
      Object.assign(this.status, { phase: 'exporting', done: 0, total: pending.length });
      try {
        const result = await this.indexer.enqueue(() => exportLibrary(this.library, destination.root, {
          mediaIds: pending.map(({ media }) => media.id),
          validateDestination: () => this.assertDestination(destination),
          onProgress: (progress) => Object.assign(this.status, { phase: `export-${progress.phase}`, done: progress.done, total: progress.total }),
        }));
        Object.assign(this.status, { phase: 'export-verifying', done: 0, total: pending.length });
        for (const { row, media } of pending) {
          this.status.currentFile = row.filename;
          try {
            const placed = result.verified.find((item) => item.mediaId === media.id && item.sha256 === row.sha256);
            if (!placed) throw new Error(result.skipped.find((item) => item.name === media.filename)?.reason ?? 'Export did not produce a verified original');
            await this.assertDestination(destination);
            if (!await regularDestination(destination.root, placed.rel)) throw new Error('Exported file is unavailable');
            const verified = await digestFile(path.join(destination.root, placed.rel), true);
            if (verified.sha256 !== row.sha256 || verified.size !== row.size) throw new Error('Export failed SHA-256 verification');
            await this.assertDestination(destination);
            this.library.q(`INSERT INTO backup_exports (upload_id, root, marker, relative_path, verified_at, size, mtime_ns, ctime_ns)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(upload_id) DO UPDATE SET
              root = excluded.root, marker = excluded.marker, relative_path = excluded.relative_path,
              verified_at = excluded.verified_at, size = excluded.size, mtime_ns = excluded.mtime_ns, ctime_ns = excluded.ctime_ns`).run(
              row.id, destination.root, destination.marker, placed.rel, Date.now(), row.size, verified.mtimeNs, verified.ctimeNs,
            );
            this.library.q('UPDATE backup_uploads SET last_error = NULL WHERE id = ?').run(row.id);
            this.repair.delete(row.id);
            this.status.exported++;
            copied++;
          } catch (err) { this.failed(row, err); }
          this.status.done++;
        }
      } catch (err) { for (const { row } of pending) this.failed(row, err); }
    }
    if (!this.status.failed && !this.status.error) this.status.lastSuccess = Date.now();
    this.onRun?.({ copied, failed: this.status.failed, error: this.status.error, destination: destination?.root ?? this.config.backupDir });
  }

  failed(row, err) {
    this.status.failed++;
    this.status.error = err.message;
    this.library.q('UPDATE backup_uploads SET last_error = ? WHERE id = ?').run(err.message, row.id);
  }
}
