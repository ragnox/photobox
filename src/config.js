import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { loadHostSettings } from './host-settings.js';
import { isInside } from './files.js';

/** Where the library lives unless told otherwise; the CLI and the desktop app share it. */
export const defaultDataDir = () => path.resolve(process.env.PHOTOBOX_DATA ?? path.join(os.homedir(), '.photobox'));

/**
 * Where everything lives. With `archive` (from archive.js), that archive's library - database,
 * thumbnails, previews - is a cache in `<dataDir>/cache/<archive id>`, apart from other archives';
 * without one, the library is in `dataDir` itself, as before archives.
 */
export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : defaultDataDir();
  const archive = overrides.archive ?? null;
  const libraryDir = archive ? path.join(dataDir, 'cache', archive.id) : dataDir;
  const saved = loadHostSettings(dataDir);
  const backupDir = overrides.backupDir !== undefined ? overrides.backupDir : process.env.PHOTOBOX_BACKUP_DIR ?? saved.backupDir;
  const config = {
    dataDir,
    archive,
    libraryDir,
    dbPath: path.join(libraryDir, 'library.db'),
    thumbsDir: path.join(libraryDir, 'thumbs'),
    previewsDir: path.join(libraryDir, 'previews'),
    uploadsDir: path.join(dataDir, 'uploads'),
    inboxDir: path.join(dataDir, 'inbox'),
    backupDir: backupDir ? path.resolve(backupDir) : null,
    listen: overrides.listen !== undefined ? overrides.listen : saved.listen,
    remotePort: overrides.remotePort !== undefined ? overrides.remotePort : saved.remotePort,
    tlsCert: overrides.tlsCert !== undefined ? overrides.tlsCert : saved.tlsCert,
    tlsKey: overrides.tlsKey !== undefined ? overrides.tlsKey : saved.tlsKey,
    backupRetryMs: overrides.backupRetryMs ?? 60_000,
    uploadMaxBytes: Number(overrides.uploadMaxBytes ?? process.env.PHOTOBOX_UPLOAD_MAX_BYTES ?? 50 * 1024 ** 3),
    uploadDeviceQuotaBytes: Number(overrides.uploadDeviceQuotaBytes ?? process.env.PHOTOBOX_UPLOAD_DEVICE_QUOTA_BYTES ?? 500 * 1024 ** 3),
    uploadMinFreeBytes: Number(overrides.uploadMinFreeBytes ?? process.env.PHOTOBOX_UPLOAD_MIN_FREE_BYTES ?? 1024 ** 3),
    port: Number(overrides.port ?? process.env.PHOTOBOX_PORT ?? saved.port),
    host: '127.0.0.1',
    concurrency: Math.max(2, Math.min(8, os.availableParallelism() - 2)),
  };
  for (const key of ['uploadMaxBytes', 'uploadDeviceQuotaBytes', 'uploadMinFreeBytes']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === 'uploadMinFreeBytes' ? 0 : 1)) {
      throw new Error(`Invalid ${key}`);
    }
  }
  for (const dir of [config.dataDir, config.libraryDir, config.thumbsDir, config.previewsDir]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [config.uploadsDir, config.inboxDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return config;
}

/** Why `dir` can't be a source of this library, or null: Photobox's own data, the archive, or a folder holding it. */
export function sourceProblem(dir, config) {
  if (dir === config.dataDir || isInside(dir, config.dataDir)) return "That's Photobox's own data folder";
  const root = config.archive?.root;
  if (root && dir === root) return "That's the archive itself";
  if (root && isInside(root, dir)) return 'That folder holds the archive';
  return null;
}
