#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { startPhotobox, openLibrary, scanAll, runningInstance, AlreadyRunning } from '../src/app.js';
import { exportLibrary } from '../src/export.js';
import { MANIFEST } from '../src/manifest.js';

const USAGE = `photobox - your photos, on your disk

  photobox serve [folders...] [--port 4567] [--open] [--listen <address>]
      Start the app. Folders given here are added to the library and watched.
      Point it at an extracted Google Takeout or any folder of photos.
      With --listen, phones can pair and browse the library over HTTPS on
      <address> (0.0.0.0 for every network, or e.g. a WireGuard address).

  photobox scan [folders...]
      Index once without starting the server, then print a summary.
      Without folders it rescans every folder the library already has.

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

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** `fn`, but at most once a second. */
function throttle(fn) {
  let last = 0;
  return (...args) => {
    if (Date.now() - last < 1000) return;
    last = Date.now();
    fn(...args);
  };
}

const [command = 'serve', ...args] = positionals;
const dest = command === 'export' && args.length ? path.resolve(args.shift()) : null;
if (opts.help || !['serve', 'scan', 'export'].includes(command) || (command === 'export' && !dest)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}
if (Boolean(opts['tls-cert']) !== Boolean(opts['tls-key'])) fail('--tls-cert and --tls-key go together');

const folders = args.map((f) => path.resolve(f));
for (const dir of folders) if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`Not a folder: ${dir}`);

const openBrowser = (url) => opts.open && process.platform === 'darwin' && execFile('open', [url]);
const printScan = (source, { files, added, offline }) => {
  console.log(offline ? `! ${source.path}: not available, skipped` : `✓ ${source.path}: ${files} media files, ${added} new`);
};

function logProgress(indexer) {
  const log = throttle((s) => console.log(`  ${s.phase} ${s.source}: ${s.done}/${s.total} (${s.added} new)`));
  indexer.on('status', (s) => s.phase === 'indexing' && log(s));
}

async function runExport(library) {
  const dryRun = opts['dry-run'];
  const onProgress = throttle(({ phase, done, total }) => console.log(`  ${phase} ${done}/${total}`));
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

/** `scan` and `export`: index the library's folders (unless a running Photobox does that), then export. */
async function scanOrExport() {
  const config = loadConfig({ dataDir: opts.data });
  const other = runningInstance(config);
  // A running Photobox keeps the library up to date itself; an export can just read it.
  if (other && (command === 'scan' || folders.length)) fail(`Photobox is running at ${other.url} - add folders there, it will index them.`);
  const { library, indexer } = openLibrary(config, other ? [] : folders);
  try {
    if (other) {
      console.log(`Exporting the library of the Photobox running at ${other.url}`);
    } else {
      if (!library.sources().length) {
        console.log(USAGE);
        return 1;
      }
      logProgress(indexer);
      await scanAll(library, indexer, printScan);
      const stats = library.stats();
      console.log(`Library: ${stats.photos} photos, ${stats.videos} videos, ${stats.live} live photo clips, ${library.albums().length} albums`);
      for (const e of indexer.status.errors.slice(0, 10)) console.log(`  ! ${e.file}: ${e.message}`);
    }
    return command === 'export' ? await runExport(library) : 0;
  } catch (err) {
    console.error(err.message);
    return 1;
  } finally {
    library.close();
  }
}

async function serve() {
  let photobox;
  try {
    photobox = await startPhotobox({
      dataDir: opts.data, port: opts.port, folders, onScanned: printScan,
      listen: opts.listen, remotePort: opts['remote-port'], tlsCert: opts['tls-cert'], tlsKey: opts['tls-key'],
    });
  } catch (err) {
    if (err instanceof AlreadyRunning) {
      console.log(`${err.message}${folders.length ? ' - add the folders there.' : ''}`);
      openBrowser(err.url);
      process.exit(0);
    }
    fail(err.code === 'EADDRINUSE' ? `Port ${err.port} is busy - try ${opts.listen ? '--port or --remote-port' : '--port'}` : err.message);
  }
  console.log(`Photobox running at ${photobox.url}  (library: ${photobox.config.dataDir})`);
  if (photobox.network) {
    console.log(`Paired devices can connect at ${photobox.network.urls.join(', ') || '(no network address found)'}`);
    console.log('  To pair a phone, open Photobox on this computer and choose "Connect a phone".');
    if (photobox.network.fingerprint) console.log(`  Certificate authority fingerprint: ${photobox.network.fingerprint}`);
  }
  logProgress(photobox.indexer);
  openBrowser(photobox.url);

  const shutdown = async () => {
    await photobox.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (command === 'serve') await serve();
else process.exitCode = await scanOrExport();
