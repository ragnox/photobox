import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Where the library lives unless told otherwise; the CLI and the desktop app share it. */
export const defaultDataDir = () => path.resolve(process.env.PHOTOBOX_DATA ?? path.join(os.homedir(), '.photobox'));

export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ? path.resolve(overrides.dataDir) : defaultDataDir();
  const config = {
    dataDir,
    dbPath: path.join(dataDir, 'library.db'),
    thumbsDir: path.join(dataDir, 'thumbs'),
    previewsDir: path.join(dataDir, 'previews'),
    port: Number(overrides.port ?? process.env.PHOTOBOX_PORT ?? 4567),
    host: '127.0.0.1',
    concurrency: Math.max(2, Math.min(8, os.availableParallelism() - 2)),
  };
  for (const dir of [config.dataDir, config.thumbsDir, config.previewsDir]) fs.mkdirSync(dir, { recursive: true });
  return config;
}
