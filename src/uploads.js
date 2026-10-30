// Native backup transport. Reception proves original bytes in the inbox;
// BackupQueue supplies independent, freshly checked indexing/export proof.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '@tus/file-store';
import { Server, Upload } from '@tus/server';
import { NodeRequest } from 'srvx/node';
import { Readable } from 'node:stream';
import { mediaKind } from './media.js';
import { hashToken } from './remote.js';
import { digestFile as digest, syncDirectory } from './files.js';

const SHA256 = /^[a-f0-9]{64}$/;
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const stat = (file) => fs.stat(file).catch((err) => { if (err.code !== 'ENOENT') throw err; return null; });

class InboxStore extends FileStore {
  constructor(uploads) {
    // SQLite is the sole durable metadata store; tus obtains the offset from the
    // partial file's actual length rather than maintaining a second offset ledger.
    super({
      directory: uploads.config.uploadsDir,
      configstore: {
        async get(id) {
          const row = uploads.row(id);
          if (!row || row.state === 'cancelled') return undefined;
          return new Upload({
            id, size: row.size, offset: 0, metadata: uploads.metadata(row),
            creation_date: new Date(row.created_at).toISOString(),
          });
        },
        async set() {},
        async delete() {},
      },
    });
    this.uploads = uploads;
    // Known lengths and cancellation only. Finished originals never expire.
    this.extensions = ['creation', 'creation-with-upload', 'termination'];
  }

  async create(upload) {
    try {
      const result = await super.create(upload);
      const handle = await fs.open(this.resolve(upload.id), 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.directory);
      return result;
    } catch (err) {
      await this.remove(upload.id);
      throw err;
    }
  }

  async getUpload(id) {
    const row = this.uploads.row(id);
    if (row?.state === 'received') {
      return new Upload({
        id, size: row.size, offset: row.size, metadata: this.uploads.metadata(row),
        creation_date: new Date(row.created_at).toISOString(),
      });
    }
    return super.getUpload(id);
  }

  async write(input, id, offset) {
    const row = this.uploads.row(id);
    const uploads = this.uploads;
    let done = offset;
    uploads.report(row, 'receiving', done);
    const observed = Readable.from((async function* () {
      for await (const chunk of input) {
        done += chunk.length;
        uploads.report(row, 'receiving', done);
        yield chunk;
      }
    })());
    try { return await super.write(observed, id, offset); }
    finally { uploads.report(row, 'waiting', done, false); }
  }

  async remove(id) {
    const row = this.uploads.row(id);
    if (!row || row.state === 'received') throw fail(403, 'Verified originals cannot be terminated');
    // Idempotent if a crash removed the bytes before the ledger was updated.
    await fs.rm(this.resolve(id), { force: true });
    await this.configstore.delete(id);
    await syncDirectory(this.directory);
    this.uploads.library.q("UPDATE backup_uploads SET state = 'cancelled' WHERE id = ?").run(id);
    this.uploads.transfers.delete(id);
  }
}

export class Uploads {
  constructor(library, config) {
    this.library = library;
    this.config = config;
    this.locks = new Map();
    this.active = new Set();
    this.transfers = new Map();
    this.closed = false;
    this.onReceived = null;
    this.assetState = null;
    this.store = new InboxStore(this);
    this.server = new Server({
      path: '/api/uploads', datastore: this.store, maxSize: config.uploadMaxBytes,
      relativeLocation: true, allowedOrigins: [],
      namingFunction: () => crypto.randomBytes(16).toString('hex'),
      onUploadCreate: (req, upload) => this.create(req, upload),
      onUploadFinish: async (req, upload) => {
        this.authenticate(req.headers.get('authorization'));
        await this.receive(this.row(upload.id));
        return {};
      },
      onResponseError: async (req, err) => ({
        status_code: err.status ?? err.status_code ?? 500,
        body: err.expose ? `${err.message}\n` : err.status_code < 500 ? err.body : 'Upload failed\n',
      }),
    });
  }

  row(id) {
    return this.library.q('SELECT * FROM backup_uploads WHERE id = ?').get(id);
  }

  report(row, phase, bytesDone, active = true) {
    if (!row) return;
    this.transfers.set(row.id, { id: row.id, filename: row.filename, deviceId: row.device_id,
      phase, bytesDone, totalBytes: row.size, active, updatedAt: Date.now() });
  }

  progress() {
    for (const [id, item] of this.transfers) if (!item.active && Date.now() - item.updatedAt > 15_000) this.transfers.delete(id);
    return {
      transfers: [...this.transfers.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20),
      pending: this.library.q("SELECT count(*) AS n FROM backup_uploads WHERE state = 'uploading'").get().n,
      failed: this.library.q("SELECT count(*) AS n FROM backup_uploads WHERE state = 'rejected'").get().n,
    };
  }

  metadata(row) {
    return {
      filename: row.filename, sha256: row.sha256,
      ...(row.captured_at ? { capturedAt: row.captured_at } : {}),
      ...(row.media_store_id ? { mediaStoreId: row.media_store_id } : {}),
    };
  }

  authenticate(authorization) {
    if (!authorization?.startsWith('Bearer ')) throw fail(401, 'A paired device bearer token is required');
    const owner = hashToken(authorization.slice(7).trim());
    const device = this.library.deviceByTokenHash(owner);
    if (!device) throw fail(401, 'This device is not paired with Photobox');
    return { owner, device };
  }

  /** One host process owns the library. Serialize an entire request, including publication. */
  async locked(key, fn) {
    if (this.closed) throw fail(503, 'Uploads are shutting down');
    const previous = this.locks.get(key) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(fn);
    this.locks.set(key, job);
    this.active.add(job);
    try { return await job; } finally {
      this.active.delete(job);
      if (this.locks.get(key) === job) this.locks.delete(key);
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active]);
  }

  /** Reserve all unfinished bytes against free disk space, including other devices. */
  async checkSpace(additional = 0) {
    let remaining = BigInt(additional);
    for (const row of this.library.q("SELECT id, size FROM backup_uploads WHERE state = 'uploading'").all()) {
      const partial = await stat(this.store.resolve(row.id));
      remaining += BigInt(Math.max(0, row.size - (partial?.size ?? 0)));
    }
    const disk = await fs.statfs(this.config.uploadsDir, { bigint: true });
    if (remaining + BigInt(this.config.uploadMinFreeBytes) > disk.bavail * disk.bsize) {
      throw fail(507, 'Not enough free space for the reserved uploads');
    }
  }

  async create(req, upload) {
    const { owner, device } = this.authenticate(req.headers.get('authorization'));
    const { filename, sha256, capturedAt, mediaStoreId } = upload.metadata ?? {};
    if (!/^[1-9]\d*$/.test(req.headers.get('upload-length') ?? '') || !Number.isSafeInteger(upload.size) || upload.size <= 0) {
      throw fail(400, 'A known, nonzero Upload-Length is required');
    }
    if (typeof filename !== 'string' || Buffer.byteLength(filename) > 240 ||
        /[\\/<>:"|?*\x00-\x1f\x7f]/.test(filename) || filename.startsWith('.') || !mediaKind(filename)) {
      throw fail(400, 'A plain media filename is required');
    }
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) throw fail(400, 'A lowercase full SHA-256 is required');
    if (Object.keys(upload.metadata).some((key) => !['filename', 'sha256', 'capturedAt', 'mediaStoreId'].includes(key))) {
      throw fail(400, 'Unknown upload metadata');
    }
    if (capturedAt !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(capturedAt) ||
        !Number.isFinite(Date.parse(capturedAt)) ||
        new Date(`${capturedAt.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== capturedAt.slice(0, 10))) {
      throw fail(400, 'capturedAt must be an ISO timestamp with a time zone');
    }
    if (mediaStoreId !== undefined && (mediaStoreId.length > 128 || /[\x00-\x1f\x7f]/.test(mediaStoreId))) {
      throw fail(400, 'Invalid MediaStore ID');
    }
    const used = this.library.q("SELECT coalesce(sum(size), 0) AS bytes FROM backup_uploads WHERE owner_hash = ? AND state != 'cancelled'").get(owner).bytes;
    if (used + upload.size > this.config.uploadDeviceQuotaBytes) throw fail(413, 'Device upload quota exceeded');
    await this.checkSpace(upload.size);
    // Creation requests share one lock, so quota/disk reservations cannot race.
    this.library.q(`INSERT INTO backup_uploads
      (id, owner_hash, device_id, filename, size, sha256, captured_at, media_store_id, created_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading')`).run(
      upload.id, owner, device.id, filename, upload.size, sha256, capturedAt ?? null, mediaStoreId ?? null, Date.now(),
    );
    return { metadata: { filename, sha256, ...(capturedAt ? { capturedAt } : {}), ...(mediaStoreId ? { mediaStoreId } : {}) } };
  }

  destination(row) {
    const date = new Date(row.captured_at ?? row.created_at).toISOString();
    return path.join(this.config.inboxDir, String(row.device_id), date.slice(0, 4), date.slice(5, 7), row.id, row.filename);
  }

  /** Recover either side of the rename/receipt boundary. Call only under the upload lock. */
  async receive(row) {
    if (!row || row.state === 'cancelled') return false;
    if (row.state === 'rejected') throw fail(422, 'Upload failed SHA-256 verification; cancel it and create a new upload');
    if (row.state === 'received') return true;
    const target = this.destination(row);
    const published = await stat(target);
    const source = published ? target : this.store.resolve(row.id);
    const current = published ?? await stat(source);
    if (!current || current.size < row.size) return false;
    this.report(row, 'verifying', 0);
    try {
      const verified = await digest(source, true, (done) => this.report(row, 'verifying', done));
      if (verified.size !== row.size || verified.sha256 !== row.sha256) {
        this.library.q("UPDATE backup_uploads SET state = 'rejected' WHERE id = ?").run(row.id);
        throw fail(422, 'Upload failed SHA-256 verification; cancel it and create a new upload');
      }
      if (!published) {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.rename(source, target);
      }
      // Persist the directory hierarchy and the removal from staging before the receipt.
      for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
        await syncDirectory(dir);
        if (dir === this.config.inboxDir) break;
      }
      await syncDirectory(this.config.uploadsDir);
      await syncDirectory(this.config.dataDir);
      this.library.q("UPDATE backup_uploads SET state = 'received', received_at = ? WHERE id = ?").run(Date.now(), row.id);
      this.onReceived?.();
      return true;
    } finally { this.transfers.delete(row.id); }
  }

  async handle(req, res) {
    const match = /^\/api\/uploads(?:\/([a-f0-9]{32}))?\/?$/.exec(req.path);
    if (!match) throw fail(404, 'Upload not found');
    const id = match[1];
    if (!['OPTIONS', 'POST', 'HEAD', 'PATCH', 'DELETE'].includes(req.method)) throw fail(405, 'Method not allowed');
    this.authenticate(req.headers.authorization);
    return this.locked(id ?? 'create', async () => {
      if (req.destroyed) return;
      const { owner } = this.authenticate(req.headers.authorization);
      if (id) {
        let row = this.row(id);
        if (!row || row.owner_hash !== owner || row.state === 'cancelled') throw fail(404, 'Upload not found');
        // Finish a full staging file when the final request/response was interrupted.
        if (req.method !== 'DELETE') await this.receive(row);
        row = this.row(id);
        if (row.state === 'received' && ['PATCH', 'POST', 'DELETE'].includes(req.method)) {
          throw fail(409, 'Verified originals are immutable');
        }
        if (req.method === 'POST') throw fail(405, 'Create uploads at /api/uploads');
        if (req.method === 'PATCH') await this.checkSpace();
      } else if (!['POST', 'OPTIONS'].includes(req.method)) {
        throw fail(404, 'Upload not found');
      }
      // The tus Node response adapter waits forever for end(callback) on an
      // already destroyed 204 response. Wait for storage to settle via handleWeb,
      // then send its small protocol response only if the socket is still open.
      const response = await this.server.handleWeb(new NodeRequest({ req, res }));
      const body = Buffer.from(await response.arrayBuffer());
      if (!res.destroyed) {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      }
    });
  }

  async check(authorization, hashes) {
    const { owner } = this.authenticate(authorization);
    if (!Array.isArray(hashes) || hashes.length > 100 || hashes.some((hash) => typeof hash !== 'string' || !SHA256.test(hash))) {
      throw fail(400, 'sha256 must be an array of at most 100 lowercase SHA-256 values');
    }
    // Track the whole batch through shutdown, including time between file locks.
    return this.locked(`check:${owner}`, async () => {
      const assets = [];
      for (const sha256 of hashes) {
        let received = false;
        let state = { indexed: false, exported: false };
        const rows = this.library.q("SELECT * FROM backup_uploads WHERE owner_hash = ? AND sha256 = ? AND state IN ('uploading', 'received')").all(owner, sha256);
        for (const row of rows) {
          received = await this.locked(row.id, async () => {
            try {
              if (!await this.receive(this.row(row.id))) return false;
              const verified = await digest(this.destination(row), false, (done) => this.report(row, 'checking', done));
              if (verified.size !== row.size || verified.sha256 !== sha256) return false;
              state = await this.assetState?.(row) ?? state;
              return true;
            } catch (err) {
              if (err.code === 'ENOENT' || err.status === 422 || err.status === 409) return false;
              throw err;
            } finally {
              this.transfers.delete(row.id);
            }
          });
          if (received) break;
        }
        assets.push({ sha256, received, ...state });
      }
      this.authenticate(authorization);
      return { assets };
    });
  }
}
