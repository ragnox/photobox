import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { BROWSER_IMAGE_EXT, BROWSER_VIDEO_EXT } from './media.js';
import { cachePath, makePreview } from './thumbs.js';

const run = promisify(execFile);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Photo libraries live in all kinds of places, including our own ~/.photobox cache.
const SEND = { dotfiles: 'allow' };

function parseCursor(value) {
  const m = typeof value === 'string' && value.match(/^(-?\d+):(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function createApp({ library, indexer, watcher, config }) {
  const app = express();
  app.disable('x-powered-by');

  // Answer only to localhost and only to JSON writes: blocks DNS rebinding and
  // cross-site form posts from reaching your photos or the API.
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host)) return res.status(403).send('Forbidden');
    if (!['GET', 'HEAD'].includes(req.method) && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return res.status(415).json({ error: 'Expected application/json' });
    }
    next();
  });
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  const mediaOr404 = (req, res) => {
    const media = library.media(Number(req.params.id));
    if (!media) res.status(404).json({ error: 'Not found' });
    return media;
  };

  app.get('/api/status', (req, res) => {
    res.json({
      version: indexer.version, indexing: indexer.status, stats: library.stats(), sources: library.sources(), platform: process.platform,
    });
  });

  app.get('/api/timeline', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const { items, more } = library.timeline({
      cursor: parseCursor(req.query.cursor),
      direction: req.query.direction === 'newer' ? 'newer' : 'older',
      limit,
      view: req.query.view ?? 'all',
      albumId: Number(req.query.album) || null,
    });
    res.json({ items, more });
  });

  app.get('/api/months', (req, res) => {
    res.json(library.months({ view: req.query.view ?? 'all', albumId: Number(req.query.album) || null }));
  });

  app.get('/api/albums', (req, res) => {
    res.json(library.albums().map((a) => ({ ...a, v: a.cover ? library.media(a.cover).hash.slice(0, 10) : null })));
  });

  app.get('/api/media/:id', (req, res) => {
    const details = library.mediaDetails(Number(req.params.id));
    if (!details) return res.status(404).json({ error: 'Not found' });
    res.json(details);
  });

  app.get('/api/media/:id/thumb', (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    res.sendFile(cachePath(config.thumbsDir, media.hash, '.webp'), { ...SEND, maxAge: '365d', immutable: true }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // The original when the browser can show it, otherwise a cached JPEG preview.
  app.get('/api/media/:id/full', async (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    const file = library.primaryPath(media.id);
    if (!file || !fs.existsSync(file)) return res.status(410).json({ error: 'File is no longer on disk' });
    const ext = path.extname(file).toLowerCase();
    if (media.kind === 'video') {
      if (!BROWSER_VIDEO_EXT.has(ext)) return res.status(415).json({ error: `Can't play ${ext} in the browser` });
      return res.sendFile(file, SEND);
    }
    if (BROWSER_IMAGE_EXT.has(ext)) return res.sendFile(file, SEND);
    const preview = cachePath(config.previewsDir, media.hash, '.jpg');
    try {
      if (!fs.existsSync(preview)) await makePreview(file, preview);
      res.sendFile(preview, { ...SEND, maxAge: '365d', immutable: true });
    } catch (err) {
      res.status(415).json({ error: `Can't decode ${ext}: ${err.message}` });
    }
  });

  app.get('/api/media/:id/live', (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    const video = library.mediaDetails(media.id).live_video;
    const file = video && library.primaryPath(video);
    if (!file) return res.status(404).end();
    res.sendFile(file, SEND);
  });

  app.post('/api/media/:id/favorite', (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    library.setFavorite(media.id, Boolean(req.body?.favorite));
    indexer.changed();
    res.json({ favorite: Boolean(req.body?.favorite), version: indexer.version });
  });

  app.post('/api/media/:id/reveal', async (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    const file = library.primaryPath(media.id);
    if (process.platform !== 'darwin' || !file) return res.status(501).json({ error: 'Only supported on macOS' });
    await run('open', ['-R', file]).catch(() => {});
    res.json({ ok: true });
  });

  app.post('/api/sources', async (req, res) => {
    const raw = String(req.body?.path ?? '').trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
    const dir = path.resolve(raw);
    let stat;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      return res.status(400).json({ error: `Folder not found: ${dir}` });
    }
    if (!stat.isDirectory()) return res.status(400).json({ error: `Not a folder: ${dir}` });
    if (dir === config.dataDir || dir.startsWith(config.dataDir + path.sep)) {
      return res.status(400).json({ error: "That's Photobox's own cache folder" });
    }
    const source = library.addSource(dir);
    watcher.watchSource(source);
    indexer.scanSource(source).catch((err) => indexer.error(dir, err));
    res.json(source);
  });

  app.delete('/api/sources/:id', async (req, res) => {
    const source = library.source(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Not found' });
    await watcher.unwatch(source.id);
    await indexer.removeSource(source.id);
    res.json({ ok: true });
  });

  app.post('/api/rescan', (req, res) => {
    for (const source of library.sources()) indexer.scanSource(source).catch((err) => indexer.error(source.path, err));
    res.json({ ok: true });
  });

  // Native folder picker - the browser can't hand us a real path.
  app.post('/api/pick-folder', async (req, res) => {
    if (process.platform !== 'darwin') return res.status(501).json({ error: 'Type the folder path instead' });
    try {
      const { stdout } = await run('osascript', [
        '-e', 'tell application "System Events" to activate',
        '-e', 'POSIX path of (choose folder with prompt "Add a folder or an extracted Google Takeout to Photobox")',
      ]);
      res.json({ path: stdout.trim().replace(/\/$/, '') });
    } catch {
      res.json({ cancelled: true });
    }
  });

  return app;
}
