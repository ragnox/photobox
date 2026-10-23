import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { BROWSER_IMAGE_EXT, BROWSER_VIDEO_EXT, isMotionClip } from './media.js';
import { thumbPath, previewPath, makePreview } from './thumbs.js';
import { requestToken, tokenCookie } from './remote.js';

const run = promisify(execFile);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Photo libraries live in all kinds of places, including our own ~/.photobox cache.
const SEND = { dotfiles: 'allow' };
// Thumbnails and previews never change for a given ?v=.
const CACHED = { ...SEND, maxAge: '365d', immutable: true };
// What an unpaired device may load on the network listener: the pairing page and the CA it needs.
const OPEN_PATHS = new Set(['/pair.html', '/pair.js', '/style.css', '/api/pair', '/photobox-ca.crt']);

const viewFilter = (req) => ({ view: req.query.view ?? 'all', albumId: Number(req.query.album) || null });

/** Send a photo or video file; motion clips ("X.MP") are MP4s under a name browsers don't know. */
function sendMedia(res, file) {
  if (isMotionClip(file)) res.type('video/mp4');
  res.sendFile(file, SEND);
}

function parseCursor(value) {
  const m = typeof value === 'string' && value.match(/^(-?\d+):(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * The app for one listener. The local one (127.0.0.1) answers only to localhost
 * and can do everything. The network one (`remote`) lets paired devices browse
 * and favorite; managing the library, pairing and devices stays on this computer.
 */
export function createApp({ library, indexer, watcher, config, network = null }, { remote = false } = {}) {
  const app = express();
  app.disable('x-powered-by');

  if (remote) {
    app.use((req, res, next) => {
      req.device = network.pairing.authenticate(requestToken(req));
      if (req.device || OPEN_PATHS.has(req.path)) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'This device is not paired with Photobox' });
      res.redirect(303, '/pair.html');
    });
  } else {
    // Answer only to localhost: blocks DNS rebinding from reaching your photos or the API.
    app.use((req, res, next) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!LOCAL_HOSTS.has(host)) return res.status(403).send('Forbidden');
      next();
    });
  }
  // Only JSON writes: blocks cross-site form posts.
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return res.status(415).json({ error: 'Expected application/json' });
    }
    next();
  });
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  const hostOnly = (req, res, next) => {
    if (remote) return res.status(403).json({ error: 'Only available on the computer running Photobox' });
    next();
  };

  const scanInBackground = (source) => indexer.scanSource(source).catch((err) => indexer.error(source.path, err));

  const mediaOr404 = (req, res) => {
    const media = library.media(Number(req.params.id));
    if (!media) res.status(404).json({ error: 'Not found' });
    return media;
  };

  app.get('/api/status', (req, res) => {
    res.json({
      version: indexer.version, indexing: indexer.status, stats: library.stats(), sources: library.sources(), platform: process.platform,
      remote, device: req.device?.name ?? null, network: !remote && network ? network.info() : null,
    });
  });

  app.get('/api/timeline', (req, res) => {
    res.json(library.timeline({
      ...viewFilter(req),
      cursor: parseCursor(req.query.cursor),
      direction: req.query.direction === 'newer' ? 'newer' : 'older',
      limit: Math.min(Number(req.query.limit) || 300, 1000),
    }));
  });

  app.get('/api/months', (req, res) => res.json(library.months(viewFilter(req))));

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
    res.sendFile(thumbPath(config, media.hash), CACHED, (err) => {
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
      return sendMedia(res, file);
    }
    if (BROWSER_IMAGE_EXT.has(ext)) return res.sendFile(file, SEND);
    const preview = previewPath(config, media.hash);
    try {
      if (!fs.existsSync(preview)) await makePreview(file, preview);
      res.sendFile(preview, CACHED);
    } catch (err) {
      res.status(415).json({ error: `Can't decode ${ext}: ${err.message}` });
    }
  });

  app.get('/api/media/:id/live', (req, res) => {
    const video = library.mediaDetails(Number(req.params.id))?.live_video;
    const file = video && library.primaryPath(video);
    if (!file) return res.status(404).end();
    sendMedia(res, file);
  });

  app.post('/api/media/:id/favorite', (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    library.setFavorite(media.id, Boolean(req.body?.favorite));
    indexer.changed();
    res.json({ favorite: Boolean(req.body?.favorite), version: indexer.version });
  });

  app.post('/api/media/:id/reveal', hostOnly, async (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    const file = library.primaryPath(media.id);
    if (process.platform !== 'darwin') return res.status(501).json({ error: 'Only supported on macOS' });
    if (!file) return res.status(404).json({ error: 'File is no longer on disk' });
    await run('open', ['-R', file]).catch(() => {});
    res.json({ ok: true });
  });

  app.post('/api/sources', hostOnly, async (req, res) => {
    const raw = String(req.body?.path ?? '').trim().replace(/^~(?=$|\/)/, os.homedir());
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
    scanInBackground(source);
    res.json(source);
  });

  app.delete('/api/sources/:id', hostOnly, async (req, res) => {
    const source = library.source(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Not found' });
    await watcher.unwatch(source.id);
    await indexer.removeSource(source.id);
    res.json({ ok: true });
  });

  app.post('/api/rescan', hostOnly, (req, res) => {
    for (const source of library.sources()) scanInBackground(source);
    res.json({ ok: true });
  });

  // Native folder picker - the browser can't hand us a real path.
  app.post('/api/pick-folder', hostOnly, async (req, res) => {
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

  // --- pairing and devices ---------------------------------------------------

  // A one-time code, as a link and QR code per address this computer can be reached at.
  app.post('/api/pairing', hostOnly, async (req, res) => {
    if (!network) return res.status(409).json({ error: 'Network access is off. Start Photobox with --listen to connect a phone.' });
    const { code, expiresAt } = network.pairing.create();
    const info = network.info();
    const links = await Promise.all(info.urls.map(async (base) => {
      const url = `${base}/pair.html#${code}`;
      return { url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
    }));
    res.json({ expiresAt, links, fingerprint: info.fingerprint });
  });

  if (remote) {
    app.post('/api/pair', (req, res) => {
      const paired = network.pairing.redeem(req.body?.code, req.body?.name);
      if (!paired) return res.status(401).json({ error: 'This pairing code was already used or has expired. Make a new one on your computer.' });
      res.setHeader('Set-Cookie', tokenCookie(paired.token));
      res.json({ token: paired.token, device: paired.device, ownCertificate: Boolean(network.tls.ca) });
    });
  }

  app.get('/api/devices', hostOnly, (req, res) => res.json(library.devices()));

  app.delete('/api/devices/:id', hostOnly, (req, res) => {
    if (!library.removeDevice(Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // Photobox's own CA, for installing on a phone (only when Photobox made the certificate).
  app.get('/photobox-ca.crt', (req, res) => {
    if (!network?.tls.ca) return res.status(404).end();
    res.attachment('photobox-ca.crt').type('application/x-x509-ca-cert').send(network.tls.caDer);
  });

  // Errors as a short JSON message: a stack trace or file path must never reach a browser,
  // least of all an unpaired device on the network (malformed JSON bodies land here too).
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (!err.expose) console.error(err);
    res.status(err.status ?? 500).json({ error: err.expose ? err.message : 'Internal error' });
  });

  return app;
}
