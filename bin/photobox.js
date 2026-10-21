#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { startPhotobox, scanAll, runningInstance, AlreadyRunning } from '../src/app.js';

const USAGE = `photobox - your photos, on your disk

  photobox serve [folders...] [--port 4567] [--open]
      Start the app. Folders given here are added to the library and watched.
      Point it at an extracted Google Takeout or any folder of photos.

  photobox scan <folders...>
      Index once without starting the server, then print a summary.

Options:
  --data <dir>   Library database + thumbnail cache (default ~/.photobox, or $PHOTOBOX_DATA)
  --port <n>     HTTP port (default 4567)
  --open         Open the browser once the server is up
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string' },
    open: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [command = 'serve', ...args] = positionals;
if (opts.help || !['serve', 'scan'].includes(command)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
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

if (command === 'scan') {
  const config = loadConfig({ dataDir: opts.data });
  const other = runningInstance(config);
  if (other) {
    console.error(`Photobox is running at ${other.url} - add folders there, it will index them.`);
    process.exit(1);
  }
  const library = new Library(config.dbPath);
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
  library.close();
} else {
  let photobox;
  try {
    photobox = await startPhotobox({ dataDir: opts.data, port: opts.port, folders, onScanned: printScan });
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
