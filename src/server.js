import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { BROWSER_IMAGE_EXT, BROWSER_VIDEO_EXT, MEDIA_EXT, isMotionClip } from './media.js';
import { thumbPath, previewPath, makePreview } from './thumbs.js';
import { requestToken, tokenCookie, nativePairingPayload } from './remote.js';
import { exportedCopies } from './manifest.js';
import { sourceProblem } from './config.js';
import { STALE_MS, backupNow, count, indexingNow, nameOfSource } from './activity.js';

const run = promisify(execFile);
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// Photo libraries live in all kinds of places, including our own ~/.photobox cache.
const SEND = { dotfiles: 'allow' };
// Thumbnails and previews never change for a given ?v=.
const CACHED = { ...SEND, maxAge: '365d', immutable: true };
// What an unpaired device may load on the network listener: the pairing page and the CA it needs.
const OPEN_PATHS = new Set(['/pair.html', '/pair.js', '/style.css', '/api/pair', '/photobox-ca.crt']);

const viewFilter = (req) => ({
  view: req.query.view ?? 'all', albumId: Number(req.query.album) || null, sourceId: Number(req.query.source) || null,
});
const sourceName = (body) => (typeof body?.name === 'string' && body.name.trim().slice(0, 100)) || null;

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
 * and can do everything. The network one (`remote`) lets paired devices browse,
 * favorite and delete photos, plus back up originals through the native API; managing
 * the library, the Deleted list, pairing and devices stays on this computer.
 */
const showInFinder = (file) => run('open', ['-R', file]);

/** "Deleted 3 photos", for the activity log; `device` deleted them in its browser. */
const deletedText = (n, waiting, device) => `Deleted ${count(n, 'photo')}${device ? ` on ${device.name}` : ''}` +
  (waiting ? ` · ${count(waiting, 'file')} ${waiting === 1 ? 'waits' : 'wait'} for a drive to be plugged in` : '');

export function createApp({ library, indexer, watcher, config, network = null, uploads = null, backup = null, deletions = null, hostControl = null, activity = null, reveal = showInFinder }, { remote = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // A phone backing up: shown in the status bar while it does (see activity.js).
  const phoneSeen = (req) => {
    if (!remote || !activity || !uploads) return;
    try { activity.phone(uploads.authenticate(req.headers.authorization).device); } catch { /* Not paired: the route answers that. */ }
  };
  const deviceName = (id) => library.devices().find((d) => d.id === id)?.name ?? 'a phone';

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
  // Native tus requests bypass JSON parsing, but require a bearer token in addition
  // to the listener's device authentication. Cookies cannot authorize binary writes.
  app.all(['/api/uploads', '/api/uploads/:id'], async (req, res) => {
    if (!remote || !uploads) return res.status(403).json({ error: 'Uploads require the paired HTTPS listener' });
    phoneSeen(req);
    await uploads.handle(req, res);
  });

  // Only JSON writes outside the authenticated native upload routes.
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return res.status(415).json({ error: 'Expected application/json' });
    }
    next();
  });
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  app.post('/api/assets/check', async (req, res) => {
    if (!remote || !uploads) return res.status(403).json({ error: 'Backup checks require the paired HTTPS listener' });
    phoneSeen(req);
    res.json(await uploads.check(req.headers.authorization, req.body?.sha256));
  });

  app.get('/api/backup/capabilities', (req, res) => {
    if (!remote || !uploads) return res.status(403).json({ error: 'Backup capabilities require the paired HTTPS listener' });
    uploads.authenticate(req.headers.authorization);
    phoneSeen(req);
    res.json({ version: 1, tusVersion: '1.0.0', maxFileBytes: config.uploadMaxBytes, extensions: [...MEDIA_EXT].sort() });
  });

  // What a phone needs to delete its copies of photos deleted in Photobox, and to say what it did.
  app.get('/api/backup/deletions', (req, res) => {
    if (!remote || !uploads || !deletions) return res.status(403).json({ error: 'Deletions require the paired HTTPS listener' });
    uploads.authenticate(req.headers.authorization);
    phoneSeen(req);
    res.json(deletions.feed(req.query.after));
  });

  app.post('/api/backup/deletions/report', (req, res) => {
    if (!remote || !uploads || !deletions) return res.status(403).json({ error: 'Deletions require the paired HTTPS listener' });
    const { device } = uploads.authenticate(req.headers.authorization);
    phoneSeen(req);
    const result = deletions.reported(device, req.body?.items);
    const trashed = req.body.items.filter((i) => i.state === 'trashed').length;
    const kept = req.body.items.length - trashed;
    if (trashed) activity?.add(`${device.name} deleted ${count(trashed, 'photo')} you deleted in Photobox`);
    if (kept) activity?.add(`${device.name} kept ${count(kept, 'photo')} you deleted in Photobox`);
    res.json(result);
  });

  const hostOnly = (req, res, next) => {
    if (remote) return res.status(403).json({ error: 'Only available on the computer running Photobox' });
    next();
  };

  // Other programs on this computer saying what they're doing: `photobox export`, a backup script (`photobox activity`).
  app.post('/api/activity', hostOnly, (req, res) => {
    if (!activity) return res.status(503).json({ error: 'No activity log' });
    const { id, state, text, done = null, total = null } = req.body ?? {};
    const number = (n) => n === null || (Number.isSafeInteger(n) && n >= 0);
    if (typeof id !== 'string' || !/^[\w.:-]{1,64}$/.test(id) || !['running', 'done', 'failed'].includes(state) ||
        typeof text !== 'string' || !text.trim() || text.length > 300 || !number(done) || !number(total)) {
      return res.status(400).json({ error: 'Expected { id, state: "running" | "done" | "failed", text, done?, total? }' });
    }
    const key = `ext:${id}`;
    if (state === 'running') activity.start(key, text.trim(), { done, total, staleMs: STALE_MS });
    else activity.end(key, text.trim(), { failed: state === 'failed' });
    res.json({ ok: true });
  });

  app.get('/api/host', hostOnly, (req, res) => {
    if (!hostControl) return res.status(503).json({ error: 'Host control is unavailable' });
    res.json(hostControl.info());
  });
  app.post('/api/host/backup-directory', hostOnly, async (req, res) => {
    if (!hostControl) return res.status(503).json({ error: 'Host control is unavailable' });
    res.json(await hostControl.setBackupDirectory(req.body?.path));
  });
  app.post('/api/host/retry', hostOnly, (req, res) => {
    backup?.request(true);
    res.json({ ok: true });
  });
  app.post('/api/host/shutdown', hostOnly, (req, res) => {
    if (!hostControl) return res.status(503).json({ error: 'Host control is unavailable' });
    res.once('finish', () => setImmediate(() => hostControl.shutdown().catch(console.error)));
    res.status(202).json({ ok: true });
  });

  const scanInBackground = (source) => indexer.scanSource(source).catch((err) => indexer.error(source.path, err));

  const mediaOr404 = (req, res) => {
    const media = library.media(Number(req.params.id));
    if (!media) res.status(404).json({ error: 'Not found' });
    return media;
  };

  // The copy in your library folder, found through its manifest: the archive, else where phone backups are exported to.
  const libraryFolder = config.archive?.root ?? config.backupDir;
  const libraryCopy = libraryFolder ? exportedCopies(libraryFolder) : async () => null;

  /** Details plus where the photo is: the copy in the library folder first, then the originals it was read from. */
  async function details(id) {
    const d = library.mediaDetails(id);
    if (!d) return null;
    const copy = d.sha256 ? await libraryCopy(d.sha256) : null;
    const exists = async (file) => (await fs.promises.stat(file).catch(() => null))?.isFile() ?? false;
    return { ...d, copy: copy && await exists(copy) ? copy : null };
  }

  app.get('/api/status', (req, res) => {
    res.json({
      version: indexer.version, indexing: indexer.status, stats: library.stats(), sources: library.sources(), platform: process.platform,
      remote, device: req.device?.name ?? null, network: !remote && network ? network.info() : null,
      backup: !remote && backup ? { ...backup.status, destination: config.backupDir } : null,
      uploads: !remote && uploads ? uploads.progress() : null,
      deleted: deletions?.counts() ?? null,
      activity: !remote && activity ? activity.snapshot([
        ...indexingNow(indexer.status, (folder) => nameOfSource(library, folder)),
        ...backupNow(uploads?.progress(), backup?.status, deviceName, config.backupDir),
      ]) : null,
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

  app.get('/api/media/:id', async (req, res) => {
    const d = await details(Number(req.params.id));
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(d);
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
    backup?.request(true);
    res.json({ favorite: Boolean(req.body?.favorite), version: indexer.version });
  });

  // Delete the photo from all devices: its files here go to the Trash, phones delete theirs (see deletions.js).
  app.delete('/api/media/:id', async (req, res) => {
    if (!deletions) return res.status(503).json({ error: 'Deleting is unavailable' });
    const result = await deletions.delete(Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Not found' });
    activity?.add(deletedText(1, result.waiting, req.device));
    res.json({ ...result, version: indexer.version });
  });

  // Delete several photos from all devices: a selection in the timeline.
  app.post('/api/media/delete', async (req, res) => {
    if (!deletions) return res.status(503).json({ error: 'Deleting is unavailable' });
    const list = req.body?.ids;
    if (!Array.isArray(list) || !list.length || list.length > 10_000 || !list.every((id) => Number.isSafeInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'ids must be a list of photo ids' });
    }
    const result = await deletions.deleteMany(list);
    if (result.deleted.length) activity?.add(deletedText(result.deleted.length, result.waiting, req.device));
    if (result.failed.length) activity?.add(`Couldn't delete ${count(result.failed.length, 'photo')} yet`, { failed: true });
    res.json({ ...result, version: indexer.version });
  });

  app.get('/api/deletions', (req, res) => res.json(deletions?.list() ?? []));

  // Clear photos from the Deleted list (all of them without `photos`): Photobox forgets them.
  app.post('/api/deletions/clear', hostOnly, (req, res) => {
    if (!deletions) return res.status(503).json({ error: 'Deleting is unavailable' });
    const cleared = deletions.clear(req.body?.all === true ? null : req.body?.photos);
    indexer.changed();
    res.json({ cleared, version: indexer.version });
  });

  // Show one of the photo's files in Finder: the one asked for, else the copy in the library folder, else an original.
  app.post('/api/media/:id/reveal', hostOnly, async (req, res) => {
    const d = await details(Number(req.params.id));
    if (!d) return res.status(404).json({ error: 'Not found' });
    const known = [d.copy, ...d.files.map((f) => f.path), ...d.versions.flatMap((v) => v.files.map((f) => f.path))].filter(Boolean);
    const file = req.body?.path ? known.find((p) => p === req.body.path) : known[0];
    if (process.platform !== 'darwin') return res.status(501).json({ error: 'Only supported on macOS' });
    if (!file) return res.status(404).json({ error: 'File is no longer on disk' });
    await reveal(file).catch(() => {});
    res.json({ ok: true });
  });

  // The user says this photo and one shown as its version are different photos.
  app.post('/api/media/:id/separate', hostOnly, async (req, res) => {
    const media = mediaOr404(req, res);
    if (!media) return;
    const other = library.media(Number(req.body?.from));
    if (!other || (other.superseded_by !== media.id && media.superseded_by !== other.id)) {
      return res.status(400).json({ error: 'Not a version of this photo' });
    }
    await indexer.keepApart(media.id, other.id);
    res.json({ ok: true, version: indexer.version });
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
    const problem = sourceProblem(dir, config);
    if (problem) return res.status(400).json({ error: problem });
    const source = library.addSource(dir, null, sourceName(req.body));
    watcher.watchSource(source);
    scanInBackground(source);
    res.json(source);
  });

  app.post('/api/sources/:id/name', hostOnly, (req, res) => {
    const source = library.source(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Not found' });
    library.setSourceName(source.id, sourceName(req.body));
    indexer.changed();
    res.json(library.source(source.id));
  });

  app.delete('/api/sources/:id', hostOnly, async (req, res) => {
    const source = library.source(Number(req.params.id));
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.managed) return res.status(409).json({ error: source.managed === 'archive' ? "That's the archive's own photos" : 'Backup inbox sources are managed by Photobox' });
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
      const payload = nativePairingPayload(network, base, code, expiresAt);
      return {
        url, qr: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
        native: { payload, qr: await QRCode.toString(payload, { type: 'svg', margin: 4, errorCorrectionLevel: 'M' }) },
      };
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
