// Wires library, indexer, watcher and HTTP server together.
// Shared by the CLI (`photobox serve`) and the desktop app.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Library } from './db.js';
import { Indexer } from './indexer.js';
import { SourceWatcher } from './watcher.js';
import { createApp } from './server.js';
import { Pairing, networkAddresses } from './remote.js';
import { ensureCertificates, loadCertificates } from './tls.js';

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

export async function scanAll(library, indexer, onScanned = () => {}) {
  for (const source of library.sources()) onScanned(source, await indexer.scanSource(source));
}

/**
 * Access from phones: HTTPS on `address` (one address, or 0.0.0.0 for every
 * network this computer is on), answering only paired devices. Uses your own
 * certificate if given, otherwise one from Photobox's own CA.
 */
function networkAccess(config, library, { address, tlsCert, tlsKey }) {
  const everywhere = address === '0.0.0.0' || address === '::';
  const addresses = everywhere ? networkAddresses() : [address];
  const tls = tlsCert
    ? loadCertificates(tlsCert, tlsKey)
    : ensureCertificates(path.join(config.dataDir, 'tls'), ['localhost', os.hostname(), ...addresses]);
  // A brought certificate is only valid for its own names; ours covers the addresses.
  const hosts = tls.ca ? addresses : tls.names.filter((n) => !n.startsWith('*'));
  const network = {
    pairing: new Pairing(library),
    tls,
    port: null,
    info: () => ({
      urls: hosts.map((h) => `https://${h.includes(':') ? `[${h}]` : h}:${network.port}`),
      fingerprint: tls.fingerprint,
    }),
  };
  return network;
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

  const library = new Library(config.dbPath);
  for (const folder of folders) library.addSource(path.resolve(folder));
  const indexer = new Indexer(library, config);
  const watcher = new SourceWatcher(library, indexer);
  const network = address ? networkAccess(config, library, { address, tlsCert, tlsKey }) : null;
  const deps = { library, indexer, watcher, config, network };
  const server = await listen(http.createServer(createApp(deps)), config.port, config.host);
  const url = `http://localhost:${server.address().port}`;
  let remoteServer = null;
  if (network) {
    const app = createApp(deps, { remote: true });
    remoteServer = await listen(https.createServer({ key: network.tls.key, cert: network.tls.cert }, app),
      remotePort ?? (config.port ? config.port + 1 : 0), address);
    network.port = remoteServer.address().port;
  }
  fs.writeFileSync(lockPath(config), JSON.stringify({ pid: process.pid, url }));

  watcher.start();
  const scanned = scanAll(library, indexer, onScanned);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const s of [server, remoteServer].filter(Boolean)) {
      s.closeAllConnections?.();
      s.close();
    }
    await watcher.close();
    if (runningInstance(config) === null) fs.rmSync(lockPath(config), { force: true });
    library.close();
  }
  return { url, network: network?.info() ?? null, config, library, indexer, scanned, close };
}
