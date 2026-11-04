// The web UI end to end: two "Google accounts" made of generated photos, the real indexer, export and server,
// and the page in a hidden Electron window clicked through like a person would. Never touches your library,
// Finder or the clipboard. Run with `npm run test:ui`; PHOTOBOX_UI_SCREENSHOTS=<dir> keeps a screenshot per step.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../../src/config.js';
import { Library } from '../../src/db.js';
import { Indexer } from '../../src/indexer.js';
import { exportLibrary } from '../../src/export.js';
import { createApp } from '../../src/server.js';
import { Deletions } from '../../src/deletions.js';
import { openPage } from './page.js';

const [W, H] = [480, 360];
/** A JPEG of a pattern with a phone's EXIF; `quality` changes the bytes, not the picture. */
const photo = (pattern, quality, taken) => {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(pattern(x, y), (y * W + x) * 3);
  const [when, subsec] = taken.split('.');
  return sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .withExif({ IFD0: { Make: 'Google', Model: 'Pixel 5' }, IFD2: { DateTimeOriginal: when, SubSecTimeOriginal: subsec } })
    .jpeg({ quality }).toBuffer();
};
const gradient = (x, y) => [40 + (160 * x) / W, 90 + (120 * y) / H, 200];
const stripes = (x) => (Math.floor(x / 40) % 2 ? [30, 110, 60] : [220, 230, 200]);
const checks = (x, y) => ((Math.floor(x / 60) + Math.floor(y / 60)) % 2 ? [200, 90, 60] : [250, 220, 160]);

const ctx = {};
const tiles = () => ctx.page.evaluate(() => [...document.querySelectorAll('.tile')].map((t) => Number(t.dataset.id)).sort((a, b) => a - b));
const texts = (selector) => ctx.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\s+/g, ' ').trim()), selector);
const sorted = (ids) => [...ids].sort((a, b) => a - b);
/** Each album in the sidebar as "name · source". */
const albums = () => ctx.page.evaluate(() => [...document.querySelectorAll('#albums .album-text')].map((a) => [...a.children].map((c) => c.textContent).join(' · ')));

/** Back to all photos, the viewer closed, so a test doesn't depend on where the one before it stopped. */
async function home() {
  const { page } = ctx;
  if (await page.evaluate(() => !document.querySelector('#lightbox').hidden)) await page.key('Escape');
  await page.click('#nav a[data-view="all"]');
  await page.waitFor(() => document.querySelector('#view-title').hidden && document.querySelector('.tile'), null, 'all photos');
}

/** Opens a photo from the timeline with its info showing. */
async function openPhoto(id) {
  const { page } = ctx;
  await home();
  await page.click(`.tile[data-id="${id}"]`);
  await page.waitFor(() => document.querySelector('#lb-name').textContent && document.querySelector('#lb-info .place'), null, 'the photo\'s details');
  if (!await page.evaluate(() => document.querySelector('#lightbox').classList.contains('info-open'))) await page.click('#lb-info-btn');
}

before(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-ui-'));
  const put = async (rel, data) => {
    await fs.mkdir(path.dirname(path.join(tmp, rel)), { recursive: true });
    await fs.writeFile(path.join(tmp, rel), data);
  };
  // One shot in both accounts' "Trip" album (the second account has the better file), plus one photo each.
  await put('google-a/Trip/PXL_1.jpg', await photo(gradient, 40, '2024:03:07 14:15:44.109'));
  await put('google-a/Trip/metadata.json', JSON.stringify({ title: 'Trip' }));
  await put('google-a/IMG_2.jpg', await photo(stripes, 90, '2024:03:06 10:00:00.200'));
  await put('google-b/Trip/PXL_1.jpg', await photo(gradient, 95, '2024:03:07 14:15:44.109'));
  await put('google-b/Trip/metadata.json', JSON.stringify({ title: 'Trip' }));
  await put('google-b/IMG_3.jpg', await photo(checks, 90, '2024:03:05 09:00:00.300'));

  const config = loadConfig({ dataDir: path.join(tmp, 'data'), backupDir: path.join(tmp, 'Photos') });
  const library = new Library(config.dbPath);
  const indexer = new Indexer(library, config);
  const a = library.addSource(path.join(tmp, 'google-a'));
  const b = library.addSource(path.join(tmp, 'google-b'), null, 'Google, second account');
  await indexer.scanSource(a);
  await indexer.scanSource(b);
  await fs.mkdir(config.backupDir);
  await exportLibrary(library, config.backupDir);

  const shown = library.timeline({}).items.map((i) => library.mediaDetails(i.id));
  const best = shown.find((m) => m.versions.length);
  const byName = (name) => shown.find((m) => m.filename === name);
  assert.ok(best, 'the indexer found the version');

  const revealed = [];
  // A stand-in for the Trash, so deleting never touches yours.
  const trashed = [];
  const deletions = new Deletions(library, indexer, config, { trash: async (file) => {
    await fs.mkdir(path.join(tmp, 'Trash'), { recursive: true });
    await fs.rename(file, path.join(tmp, 'Trash', `${trashed.length}-${path.basename(file)}`));
    trashed.push(file);
  } });
  const watcher = { watchSource() {}, async unwatch() {} };
  const server = http.createServer(createApp({ library, indexer, watcher, config, deletions, reveal: async (file) => revealed.push(file) }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const screenshots = process.env.PHOTOBOX_UI_SCREENSHOTS ? path.resolve(process.env.PHOTOBOX_UI_SCREENSHOTS) : null;
  if (screenshots) await fs.mkdir(screenshots, { recursive: true });
  const page = await openPage({ profile: path.join(tmp, 'electron'), screenshots });
  Object.assign(ctx, { tmp, config, library, server, page, a, b, best, older: best.versions[0], img2: byName('IMG_2.jpg'), img3: byName('IMG_3.jpg'), revealed, deletions, trashed });

  await page.load(`http://localhost:${server.address().port}/`);
  // A stand-in clipboard that records what would be copied, so the test never touches yours.
  await page.evaluate(() => {
    window.copied = [];
    Object.defineProperty(navigator.clipboard, 'write', {
      configurable: true,
      value: async (items) => {
        for (const item of items) {
          for (const type of item.types) {
            const bitmap = await createImageBitmap(await item.getType(type));
            window.copied.push({ type, width: bitmap.width, height: bitmap.height });
          }
        }
      },
    });
  });
});

let step = 0;
afterEach(async (t) => {
  if (process.env.PHOTOBOX_UI_SCREENSHOTS) await ctx.page.screenshot(`${String(++step).padStart(2, '0')} ${t.name.slice(0, 60)}`);
});

after(async () => {
  await ctx.page?.close();
  ctx.server?.closeAllConnections();
  ctx.server?.close();
  await ctx.deletions?.close();
  ctx.library?.close();
  if (ctx.tmp) await fs.rm(ctx.tmp, { recursive: true, force: true });
});

test('the timeline shows the shot from both accounts once, and the sidebar counts the older version', async () => {
  const { page, best, img2, img3 } = ctx;
  await page.waitFor(() => document.querySelectorAll('.tile').length === 3 && document.querySelector('#stats').textContent.includes('photos'));
  assert.deepEqual(await tiles(), sorted([best.id, img2.id, img3.id]));
  assert.equal(await page.text('#stats'), '3 photos · 0 videos · 1 older version set aside');
});

test('sources are listed by name and renamed in place; albums say which source they are from', async () => {
  const { page, a } = ctx;
  assert.deepEqual(await texts('#sources .source .name'), ['google-a', 'Google, second account']);
  assert.deepEqual(await albums(), ['Trip · google-a', 'Trip · Google, second account']);

  await page.hover(`#sources [data-source="${a.id}"]`);
  await page.click(`#sources [data-rename="${a.id}"]`);
  await page.waitFor(() => document.activeElement?.matches('#sources input'), null, 'the name field');
  await page.type('Google, main account');
  await page.key('Enter');
  await page.waitFor(() => document.querySelector('#albums').textContent.includes('Google, main account'), null, 'the album label');
  assert.deepEqual(await texts('#sources .source .name'), ['Google, main account', 'Google, second account']);
  assert.deepEqual(await albums(), ['Trip · Google, main account', 'Trip · Google, second account']);
});

test('picking a source shows only its photos and albums', async () => {
  const { page, b, best, img3 } = ctx;
  await home();
  await page.click(`#sources [data-source="${b.id}"] .src-link`);
  await page.waitFor(() => document.querySelector('#view-title').textContent === 'From Google, second account' && document.querySelectorAll('.tile').length === 2);
  assert.deepEqual(await tiles(), sorted([best.id, img3.id]));
  assert.deepEqual(await albums(), ['Trip · Google, second account']);
});

test('a photo\'s info says where it is from, where its files are, and which older version was set aside', async () => {
  const { page, config, best, older } = ctx;
  await home();
  await page.click(`.tile[data-id="${best.id}"]`);
  await page.waitFor(() => document.querySelector('#lb-name').textContent === 'PXL_1.jpg');
  await page.click('#lb-info-btn');
  await page.waitFor(() => document.querySelector('#lightbox').classList.contains('info-open') && document.querySelector('#lb-info .place'));

  assert.deepEqual((await texts('#lb-info a.chip')).sort(), ['Google, main account', 'Google, second account']);
  const places = await page.evaluate(() => [...document.querySelectorAll('#lb-info .place')].map((p) => [...p.children].map((c) => c.textContent.trim())));
  assert.deepEqual(places, [
    ['In your library folder', path.join(config.backupDir, '2024/03/PXL_1.jpg')],
    ['Original · Google, second account', best.files[0].path],
    [`${W} × ${H} · ${(older.bytes / 1024).toFixed(1)} KB · Google, main account`, older.files[0].path, 'Not the same photo'],
  ]);
  assert.match(await page.text('#lb-info'), /1 older version The same shot/);
});

test('"Show in Finder" shows the copy in the library folder, or the file that was clicked', { skip: process.platform !== 'darwin' && 'Finder is macOS only' }, async () => {
  const { page, config, best, older, revealed } = ctx;
  await openPhoto(best.id);
  const shown = async (count) => {
    const end = Date.now() + 5000;
    while (revealed.length < count && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await page.click('#lb-reveal');
  await shown(1);
  await page.click(`#lb-info [data-reveal-path="${older.files[0].path}"]`);
  await shown(2);
  assert.deepEqual(revealed, [path.join(config.backupDir, '2024/03/PXL_1.jpg'), older.files[0].path]);
});

test('the copy button and ⌘C put the full-size photo on the clipboard', async () => {
  const { page, best } = ctx;
  await openPhoto(best.id);
  await page.click('#lb-copy');
  await page.waitFor(() => window.copied.length === 1 && document.querySelector('#toast').textContent === 'Copied');
  await page.key('c', [process.platform === 'darwin' ? 'meta' : 'control']);
  await page.waitFor(() => window.copied.length === 2);
  assert.deepEqual(await page.evaluate(() => window.copied), [
    { type: 'image/png', width: W, height: H },
    { type: 'image/png', width: W, height: H },
  ]);
});

const finderLabel = process.platform === 'darwin' ? 'Show in Finder' : 'Show in folder';
/** Waits for something outside the page, like what the desktop bridge recorded. */
async function until(check, what) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('right-clicking a photo offers to copy it, show it in Finder or show its info', async () => {
  const { page, config, best, revealed } = ctx;
  const menu = () => texts('#ctx-menu button');
  const open = () => page.waitFor(() => !document.querySelector('#ctx-menu').hidden, null, 'the menu');
  const finder = process.platform === 'darwin' ? [finderLabel] : [];
  await home();
  const copies = await page.evaluate(() => window.copied.length);
  await page.rightClick(`.tile[data-id="${best.id}"]`);
  await open();
  assert.deepEqual(await menu(), ['Copy Photo', ...finder, 'Get Info', 'Delete…']);
  await page.click('#ctx-menu [data-action="copy"]');
  await page.waitFor((n) => window.copied.length === n + 1 && document.querySelector('#ctx-menu').hidden, copies, 'the copy');

  await page.rightClick(`.tile[data-id="${best.id}"]`);
  await page.click('#ctx-menu [data-action="info"]');
  await page.waitFor(() => document.querySelector('#lb-name').textContent === 'PXL_1.jpg' && document.querySelector('#lightbox').classList.contains('info-open'), null, 'the photo with its info');

  // In the viewer it shows the shortcuts, and Esc closes the menu, not the photo.
  await page.rightClick('#lb-stage img');
  await open();
  assert.deepEqual(await menu(), [`Copy Photo${process.platform === 'darwin' ? '⌘C' : 'Ctrl+C'}`, ...finder, 'Hide InfoI', `Delete…${process.platform === 'darwin' ? '⌘⌫' : 'Ctrl+Backspace'}`]);
  await page.key('Escape');
  await page.waitFor(() => document.querySelector('#ctx-menu').hidden && !document.querySelector('#lightbox').hidden, null, 'only the menu closed');
  if (finder.length) {
    const before = revealed.length;
    await page.rightClick('#lb-stage img');
    await page.click('#ctx-menu [data-action="reveal"]');
    await until(() => revealed.length === before + 1, 'Show in Finder');
    assert.equal(revealed.at(-1), path.join(config.backupDir, '2024/03/PXL_1.jpg'));
  }
});

test('in the desktop app the menu is a native one, and what was picked in it is done', async () => {
  const { tmp, server, config, best } = ctx;
  const page = await openPage({ profile: path.join(tmp, 'electron-desktop'), desktop: true });
  try {
    await page.load(`http://localhost:${server.address().port}/`);
    await page.desktop.answer('reveal');
    await page.rightClick(`.tile[data-id="${best.id}"]`);
    await until(() => page.desktop.revealed.length === 1, 'Show in Finder');
    assert.deepEqual(page.desktop.menus, [[
      { id: 'copy', label: 'Copy Photo', keys: null },
      { id: 'reveal', label: finderLabel, keys: null },
      { id: 'info', label: 'Get Info', keys: null },
      { id: 'delete', label: 'Delete…', keys: null, separator: true },
    ]]);
    assert.deepEqual(page.desktop.revealed, [path.join(config.backupDir, '2024/03/PXL_1.jpg')]);

    await page.desktop.answer('info');
    await page.rightClick(`.tile[data-id="${best.id}"]`);
    await page.waitFor(() => document.querySelector('#lb-name').textContent === 'PXL_1.jpg' && document.querySelector('#lightbox').classList.contains('info-open'), null, 'the photo with its info');
    assert.ok(await page.evaluate(() => document.querySelector('#ctx-menu').hidden), 'no menu in the page');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.close();
  }
});

test('a source in the info panel leads to its photos', async () => {
  const { page, a, best, img2 } = ctx;
  await openPhoto(best.id);
  await page.click(`#lb-info a.chip[href="#source/${a.id}"]`);
  await page.waitFor(() => document.querySelector('#lightbox').hidden && document.querySelector('#view-title').textContent === 'From Google, main account');
  await page.waitFor(() => document.querySelectorAll('.tile').length === 2);
  assert.deepEqual(await tiles(), sorted([best.id, img2.id]));
});

test('"Not the same photo" shows both photos again', async () => {
  const { page, best, older, img2, img3 } = ctx;
  await openPhoto(best.id);
  await page.click(`#lb-info [data-separate="${older.id}"]`);
  await page.waitFor(() => document.querySelector('#toast').textContent === 'Shown as separate photos' && !document.querySelector('#lb-info [data-separate]'));
  await page.key('Escape');
  await page.click('#new-pill');
  await page.waitFor(() => document.querySelectorAll('.tile').length === 4);
  assert.deepEqual(await tiles(), sorted([best.id, older.id, img2.id, img3.id]));
  await page.waitFor(() => document.querySelector('#stats').textContent === '4 photos · 0 videos');
});

test('deleting a photo asks first, takes it out of the timeline and lists its fingerprint under Deleted', async () => {
  const { page, config, img3, trashed } = ctx;
  await openPhoto(img3.id);
  await page.click('#lb-delete');
  await page.waitFor(() => document.querySelector('#ask-dialog').open, null, 'the question');
  assert.match(await page.text('#ask-body'), /IMG_3\.jpg, taken .* Its 2 files on this computer go to the Trash/);
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('#ask-dialog').open, null, 'the question gone');
  assert.ok(await page.evaluate(() => !document.querySelector('#lightbox').hidden), 'Esc closed the question, not the photo');
  assert.deepEqual(trashed, []);

  // ⌫ asks too; deleting moves the viewer on to another photo.
  await page.key('Backspace');
  await page.waitFor(() => document.querySelector('#ask-dialog').open, null, 'the question');
  await page.click('#ask-ok');
  await page.waitFor((id) => !document.querySelector(`.tile[data-id="${id}"]`) && document.querySelector('#toast').textContent === 'Deleted', img3.id, 'the photo gone');
  assert.ok(await page.evaluate(() => !document.querySelector('#lightbox').hidden && document.querySelector('#lb-name').textContent !== 'IMG_3.jpg'));
  assert.deepEqual([...trashed].sort(), [img3.files[0].path, path.join(config.backupDir, '2024/03/IMG_3.jpg')].sort());

  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('#nav-deleted').hidden, null, 'Deleted in the sidebar');
  assert.equal(await page.text('#deleted-count'), '1');
  await page.click('#nav-deleted');
  await page.waitFor(() => document.querySelector('#deleted-view .deleted'), null, 'the Deleted list');
  const entry = await page.text('#deleted-view .deleted');
  assert.match(entry, new RegExp(`^IMG_3\\.jpg\\s*Taken .* · deleted .* Clear Fingerprint ${img3.sha256}`));
  assert.equal((entry.match(/Moved to the Trash/g) ?? []).length, 2);
  assert.ok(await page.evaluate(() => document.querySelector('#timeline').hidden && document.querySelector('#empty').hidden));

  await page.click('#deleted-view [data-clear]');
  await page.waitFor(() => document.querySelector('#ask-dialog').open, null, 'the question');
  await page.click('#ask-ok');
  await page.waitFor(() => document.querySelector('#deleted-view').textContent.includes('Nothing deleted') && document.querySelector('#deleted-count').textContent === '', null, 'an empty list');
  assert.deepEqual(ctx.deletions.list(), []);
});

test('nothing went wrong in the page', () => {
  assert.deepEqual(ctx.page.errors, []);
});
