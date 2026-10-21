// Wires library, indexer, watcher and HTTP server together.
// Shared by the CLI (`photobox serve`) and the desktop app.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Library } from './db.js';
import { Indexer } from './indexer.js';
import { SourceWatcher } from './watcher.js';
import { createApp } from './server.js';

export class AlreadyRunning extends Error {
  constructor(url) {
    super(`Photobox is already running at ${url}`);
    this.url = url;
  }
}

const lockPath = (config) => path.join(config.dataDir, 'instance.json');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Another live process serving this library: { pid, url } or null. */
export function runningInstance(config) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath(config), 'utf8'));
    return lock.pid !== process.pid && alive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

export async function scanAll(library, indexer, onScanned = () => {}) {
  for (const source of library.sources()) onScanned(source, await indexer.scanSource(source));
}

/**
 * Start a library server. Two processes indexing one library would fight over
 * it, so this throws AlreadyRunning (with the other instance's URL) instead.
 */
export async function startPhotobox({ dataDir, port, folders = [], onScanned } = {}) {
  const config = loadConfig({ dataDir, port });
  const other = runningInstance(config);
  if (other) throw new AlreadyRunning(other.url);

  const library = new Library(config.dbPath);
  for (const folder of folders) library.addSource(path.resolve(folder));
  const indexer = new Indexer(library, config);
  const watcher = new SourceWatcher(library, indexer);
  const server = await listen(createApp({ library, indexer, watcher, config }), config.port, config.host);
  const url = `http://localhost:${server.address().port}`;
  fs.writeFileSync(lockPath(config), JSON.stringify({ pid: process.pid, url }));

  watcher.start();
  const scanned = scanAll(library, indexer, onScanned);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    server.closeAllConnections?.();
    server.close();
    await watcher.close();
    if (runningInstance(config) === null) fs.rmSync(lockPath(config), { force: true });
    library.close();
  }
  return { url, config, library, indexer, scanned, close };
}
