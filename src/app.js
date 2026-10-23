// Wires library, indexer, watcher and HTTP server together.
// Shared by the CLI (`photobox serve`) and the desktop app.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Library } from './db.js';
import { Indexer } from './indexer.js';
import { SourceWatcher } from './watcher.js';
import { createApp } from './server.js';
import { networkAccess } from './remote.js';

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

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The library for `config`, with `folders` added as sources, and its indexer. */
export function openLibrary(config, folders = []) {
  const library = new Library(config.dbPath);
  for (const folder of folders) library.addSource(path.resolve(folder));
  return { library, indexer: new Indexer(library, config) };
}

export async function scanAll(library, indexer, onScanned = () => {}) {
  for (const source of library.sources()) onScanned(source, await indexer.scanSource(source));
}

/**
 * Start a library server. Two processes indexing one library would fight over
 * it, so this throws AlreadyRunning (with the other instance's URL) instead.
 * With `listen`, phones can pair and connect over the network too.
 */
export async function startPhotobox({ dataDir, port, folders = [], onScanned, listen: address, remotePort, tlsCert, tlsKey } = {}) {
  const config = loadConfig({ dataDir, port });
  const other = runningInstance(config);
  if (other) throw new AlreadyRunning(other.url);

  const { library, indexer } = openLibrary(config, folders);
  const watcher = new SourceWatcher(library, indexer);
  const network = address ? networkAccess(config, library, { address, tlsCert, tlsKey }) : null;
  const deps = { library, indexer, watcher, config, network };
  const servers = [];
  try {
    servers.push(await listen(http.createServer(createApp(deps)), config.port, config.host));
    if (network) {
      const remote = https.createServer({ key: network.tls.key, cert: network.tls.cert }, createApp(deps, { remote: true }));
      servers.push(await listen(remote, remotePort != null ? Number(remotePort) : config.port ? config.port + 1 : 0, address));
      network.port = remote.address().port;
    }
  } catch (err) {
    for (const s of servers) s.close();
    library.close();
    throw err;
  }
  const url = `http://localhost:${servers[0].address().port}`;
  fs.writeFileSync(lockPath(config), JSON.stringify({ pid: process.pid, url }));

  watcher.start();
  scanAll(library, indexer, onScanned).catch((err) => console.error(err));

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    await watcher.close();
    if (runningInstance(config) === null) fs.rmSync(lockPath(config), { force: true });
    library.close();
  }
  return { url, network: network?.info() ?? null, config, indexer, close };
}
