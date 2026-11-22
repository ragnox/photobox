// Wires library, indexer, watcher and HTTP server together.
// Shared by the CLI (`photobox serve`) and the desktop app.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { loadConfig, sourceProblem } from './config.js';
import { Library } from './db.js';
import { Indexer } from './indexer.js';
import { SourceWatcher } from './watcher.js';
import { createApp } from './server.js';
import { networkAccess } from './remote.js';
import { announce } from './announce.js';
import { Activity, count, nameOfSource, tilde } from './activity.js';
import { Uploads } from './uploads.js';
import { BackupQueue } from './backup.js';
import { Deletions } from './deletions.js';
import { saveHostSettings } from './host-settings.js';

export class AlreadyRunning extends Error {
  constructor(url) {
    super(`Photobox is already running at ${url}`);
    this.url = url;
  }
}

const lockPath = (config) => path.join(config.libraryDir, 'instance.json');
const RENEW_MS = 30_000; // how soon a new address of this computer gets into its certificate

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

/** The library for `config`, with `folders` added as sources, and its indexer. An archive's library also has the archive's own photos. */
export function openLibrary(config, folders = [], { access } = {}) {
  for (const folder of folders) {
    const problem = sourceProblem(path.resolve(folder), config);
    if (problem) throw new Error(`${problem}: ${path.resolve(folder)}`);
  }
  const library = new Library(config.dbPath);
  if (config.archive) library.archiveSource(config.archive.root);
  for (const folder of folders) library.addSource(path.resolve(folder));
  return { library, indexer: new Indexer(library, config, access ? { access } : {}) };
}

/**
 * Scans every source, one after another. A folder that can't be read yet (macOS is asking you about it,
 * see access.js) doesn't hold up the rest: it's scanned once it can be.
 */
export async function scanAll(library, indexer, onScanned = () => {}) {
  const sources = library.sources();
  const scan = async (source) => onScanned(source, await indexer.scanSource(source));
  const answers = sources.map((source) => indexer.access.answer(source.path)); // all reads at once
  const later = [];
  for (const [i, source] of sources.entries()) {
    if (await answers[i] === null) later.push(scan(source));
    else await scan(source);
  }
  await Promise.all(later);
}

/** What the indexer and phone backups did, for the activity log (see activity.js). */
function reportActivity(activity, { library, indexer, uploads, backup }) {
  let lastScan = indexer.status.lastScan;
  indexer.on('status', (s) => {
    if (!s.lastScan || s.lastScan === lastScan) return;
    lastScan = s.lastScan;
    const name = nameOfSource(library, s.lastScan.source);
    const errors = s.errors.filter((e) => e.at >= Date.now() - s.lastScan.ms - 1000).length;
    if (s.lastScan.added) activity.add(`Imported ${count(s.lastScan.added, 'new photo')} from ${name}`);
    if (errors) activity.add(`Couldn't read ${count(errors, 'file')} in ${name}`, { failed: true });
  });
  const queued = uploads.onReceived;
  uploads.onReceived = (row) => {
    queued?.(row);
    const device = library.devices().find((d) => d.id === row.device_id);
    if (device) activity.phone(device, true);
  };
  // A folder macOS is asking you about: shown while it waits, and why it's skipped if you said no.
  const mac = process.platform === 'darwin';
  const folder = (dir) => nameOfSource(library, dir);
  indexer.access.on('waiting', (dir) => activity.start(`access:${dir}`,
    mac ? `Waiting to read ${folder(dir)}: if your Mac asks whether Photobox may, click Allow` : `Waiting to read ${folder(dir)}`));
  indexer.access.on('readable', (dir) => activity.end(`access:${dir}`));
  indexer.access.on('refused', (dir, err) => activity.end(`access:${dir}`, mac && err.code === 'EPERM'
    ? `Photobox may not read ${folder(dir)}: allow it in System Settings › Privacy & Security › Files & Folders`
    : `Photobox may not read ${folder(dir)} (${err.code})`, { failed: true }));
  backup.onRun = ({ copied, checked, error, destination }) => {
    const where = destination ? tilde(destination) : 'the export folder';
    // A recheck (after a restart, say) that finds the photos there already copied nothing.
    if (copied) activity.add(`Exported ${count(copied, 'phone photo')} into ${where}`);
    else if (checked) activity.add(`Checked ${count(checked, 'phone photo')} in ${where}: already there`);
    if (error) activity.add(`Phone photos couldn't be exported into ${where}: ${error}`, { failed: true });
  };
}

/**
 * Start a library server. Two processes indexing one library would fight over
 * it, so this throws AlreadyRunning (with the other instance's URL) instead.
 * With `listen`, phones can pair and connect over the network too.
 */
export async function startPhotobox({ dataDir, archive, port, folders = [], onScanned, listen: address, remotePort, tlsCert, tlsKey, backupDir, managedBy = 'cli', trash, access } = {}) {
  const config = loadConfig({ dataDir, archive, port, backupDir, listen: address, remotePort, tlsCert, tlsKey });
  address = config.listen;
  remotePort = config.remotePort;
  tlsCert = config.tlsCert;
  tlsKey = config.tlsKey;
  const other = runningInstance(config);
  if (other) throw new AlreadyRunning(other.url);

  const { library, indexer } = openLibrary(config, folders, { access });
  const watcher = new SourceWatcher(library, indexer);
  const network = address ? networkAccess(config, library, { address, tlsCert, tlsKey }) : null;
  const uploads = new Uploads(library, config);
  const backup = new BackupQueue(library, indexer, uploads, config);
  const deletions = new Deletions(library, indexer, config, { uploads, trash });
  const activity = new Activity(path.join(config.libraryDir, 'activity.json'));
  reportActivity(activity, { library, indexer, uploads, backup });
  const hostControl = {
    info: () => ({ pid: process.pid, dataDir: config.dataDir, archive: config.archive?.root ?? null, managedBy, port: config.port,
      listen: address, remotePort: network?.port ?? null, backupDir: config.backupDir }),
    async setBackupDirectory(value) {
      if (value !== null && (typeof value !== 'string' || !path.isAbsolute(value))) {
        throw Object.assign(new Error('Choose an absolute export directory'), { status: 400, expose: true });
      }
      const root = value === null ? null : path.resolve(value);
      try { if (root) await backup.destination(root); }
      catch { throw Object.assign(new Error('Export folder must exist, be separate from Photobox data, and have a valid destination marker'), { status: 400, expose: true }); }
      saveHostSettings(config.dataDir, { backupDir: root });
      config.backupDir = root;
      backup.status.configured = Boolean(root);
      backup.request(true);
      return hostControl.info();
    },
    async shutdown() { await close(); },
  };
  const deps = { library, indexer, watcher, config, network, uploads, backup, deletions, hostControl, activity };
  const servers = [];
  let renew = null;
  let announced = null;
  try {
    servers.push(await listen(http.createServer(createApp(deps)), config.port, config.host));
    if (network) {
      const remote = https.createServer({ key: network.tls.key, cert: network.tls.cert }, createApp(deps, { remote: true }));
      servers.push(await listen(remote, remotePort != null ? Number(remotePort) : config.port ? config.port + 1 : 0, address));
      network.port = remote.address().port;
      // Paired phones reach this computer at whatever address it has now.
      renew = setInterval(() => {
        try { if (network.refresh()) remote.setSecureContext({ key: network.tls.key, cert: network.tls.cert }); }
        catch (err) { console.error(`Could not renew the certificate for this computer's new address: ${err.message}`); }
      }, RENEW_MS).unref();
      if (network.everywhere) announced = announce(network.port);
    }
    // The archive too, so the desktop app opens the library the host last served.
    saveHostSettings(config.dataDir, { port: config.port, listen: address, remotePort: remotePort ?? null, backupDir: config.backupDir, archive: config.archive?.root ?? null,
      tlsCert: tlsCert ? path.resolve(tlsCert) : null, tlsKey: tlsKey ? path.resolve(tlsKey) : null });
  } catch (err) {
    clearInterval(renew);
    announced?.close();
    for (const s of servers) s.close();
    await deletions.close();
    await backup.close();
    await uploads?.close();
    library.close();
    throw err;
  }
  const url = `http://localhost:${servers[0].address().port}`;
  fs.writeFileSync(lockPath(config), JSON.stringify({ pid: process.pid, url }));

  watcher.start();
  const scanned = scanAll(library, indexer, onScanned).catch((err) => console.error(err));
  backup.request();
  deletions.request();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(renew);
    announced?.close();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
    await watcher.close();
    await deletions.close();
    await backup.close();
    await uploads.close();
    await indexer.stop();
    activity.close();
    if (runningInstance(config) === null) fs.rmSync(lockPath(config), { force: true });
    library.close();
  }
  // `scanned`: every source was scanned once (a folder still waiting to be read, once it was).
  return { url, network: network?.info() ?? null, config, indexer, backup, hostControl, scanned, close };
}
