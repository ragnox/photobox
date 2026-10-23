#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { startPhotobox, scanAll, runningInstance, AlreadyRunning } from '../src/app.js';
import { exportLibrary, MANIFEST } from '../src/export.js';

const USAGE = `photobox - your photos, on your disk

  photobox serve [folders...] [--port 4567] [--open] [--listen <address>]
      Start the app. Folders given here are added to the library and watched.
      Point it at an extracted Google Takeout or any folder of photos.
      With --listen, phones can pair and browse the library over HTTPS on
      <address> (0.0.0.0 for every network, or e.g. a WireGuard address).

  photobox scan <folders...>
      Index once without starting the server, then print a summary.

  photobox export <dest> [folders...] [--dry-run]
      Copy every photo and video into <dest>/YYYY/MM/, once each, dated by when it
      was taken, with albums and other details in <dest>/${MANIFEST}.
      Rescans the library first; run it again to copy only what's new.

Options:
  --data <dir>   Library database + thumbnail cache (default ~/.photobox, or $PHOTOBOX_DATA)
  --port <n>     HTTP port (default 4567)
  --open         Open the browser once the server is up
  --listen <a>   Also serve paired devices on address <a>, over HTTPS on port + 1
  --remote-port <n>
                 Port for --listen instead of port + 1
  --tls-cert <file> --tls-key <file>
                 Your own certificate for --listen (e.g. from tailscale cert)
  --dry-run      export: list what would be copied, copy nothing
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    open: { type: 'boolean', default: false },
    listen: { type: 'string' },
    'remote-port': { type: 'string' },
    'tls-cert': { type: 'string' },
    'tls-key': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command = 'serve', ...args] = positionals;
const dest = command === 'export' && args.length ? path.resolve(args.shift()) : null;
if (opts.help || !['serve', 'scan', 'export'].includes(command) || (command === 'export' && !dest)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

if (Boolean(opts['tls-cert']) !== Boolean(opts['tls-key'])) {
  console.error('--tls-cert and --tls-key go together');
  process.exit(1);
}

const folders = args.map((f) => path.resolve(f));
for (const dir of folders) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Not a folder: ${dir}`);
    process.exit(1);
  }
}

const openBrowser = (url) => opts.open && process.platform === 'darwin' && execFile('open', [url]);
const printScan = (source, { files, added, offline }) => {
  console.log(offline ? `! ${source.path}: not available, skipped` : `✓ ${source.path}: ${files} media files, ${added} new`);
};

function logProgress(indexer) {
  let last = 0;
  indexer.on('status', (s) => {
    if (s.phase !== 'indexing' || Date.now() - last < 1000) return;
    last = Date.now();
    console.log(`  ${s.phase} ${s.source}: ${s.done}/${s.total} (${s.added} new)`);
  });
}

async function runExport(library) {
  let last = 0;
  const onProgress = ({ phase, done, total }) => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    console.log(`  ${phase} ${done}/${total}`);
  };
  const dryRun = opts['dry-run'];
  const result = await exportLibrary(library, dest, { dryRun, onProgress });
  if (dryRun) {
    console.log(`Would copy ${result.planned.length} of ${result.total} items to ${dest} (${result.present} already there)`);
    for (const p of result.planned.slice(0, 20)) console.log(`  ${p.rel}  <-  ${p.source}`);
    if (result.planned.length > 20) console.log(`  … and ${result.planned.length - 20} more`);
  } else {
    console.log(`✓ Exported to ${dest}: ${result.copied} copied, ${result.present} already there (${result.total} items)`);
  }
  if (result.skipped.length) console.log(`  ${result.skipped.length} not exported:`);
  for (const s of result.skipped.slice(0, 10)) console.log(`  ! ${s.name}: ${s.reason}`);
  return result.skipped.length ? 1 : 0;
}

if (command === 'scan' || command === 'export') {
  const config = loadConfig({ dataDir: opts.data });
  const other = runningInstance(config);
  // A running Photobox keeps the library up to date itself; an export can just read it.
  if (other && (command === 'scan' || folders.length)) {
    console.error(`Photobox is running at ${other.url} - add folders there, it will index them.`);
    process.exit(1);
  }
  const library = new Library(config.dbPath);
  if (other) {
    console.log(`Exporting the library of the Photobox running at ${other.url}`);
  } else {
    for (const dir of folders) library.addSource(dir);
    if (!library.sources().length) {
      console.log(USAGE);
      process.exit(1);
    }
    const indexer = new Indexer(library, config);
    logProgress(indexer);
    await scanAll(library, indexer, printScan);
    const stats = library.stats();
    console.log(`Library: ${stats.photos} photos, ${stats.videos} videos, ${stats.live} live photo clips, ${library.albums().length} albums`);
    for (const e of indexer.status.errors.slice(0, 10)) console.log(`  ! ${e.file}: ${e.message}`);
  }
  if (command === 'export') {
    try {
      process.exitCode = await runExport(library);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  }
  library.close();
} else {
  let photobox;
  try {
    photobox = await startPhotobox({
      dataDir: opts.data, port: opts.port, folders, onScanned: printScan,
      listen: opts.listen, remotePort: opts['remote-port'] ? Number(opts['remote-port']) : undefined,
      tlsCert: opts['tls-cert'], tlsKey: opts['tls-key'],
    });
  } catch (err) {
    if (err instanceof AlreadyRunning) {
      console.log(`${err.message}${folders.length ? ' - add the folders there.' : ''}`);
      openBrowser(err.url);
      process.exit(0);
    }
    console.error(err.code === 'EADDRINUSE' ? `Port ${opts.port ?? 4567} is busy - try --port` : err.message);
    process.exit(1);
  }
  console.log(`Photobox running at ${photobox.url}  (library: ${photobox.config.dataDir})`);
  if (photobox.network) {
    console.log(`Paired devices can connect at ${photobox.network.urls.join(', ') || '(no network address found)'}`);
    console.log('  To pair a phone, open Photobox on this computer and choose "Connect a phone".');
    if (photobox.network.fingerprint) console.log(`  Certificate authority fingerprint: ${photobox.network.fingerprint}`);
  }
  logProgress(photobox.indexer);
  openBrowser(photobox.url);
  photobox.scanned.catch((err) => console.error(err));

  const shutdown = async () => {
    await photobox.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
