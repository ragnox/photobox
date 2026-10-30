// The web UI on an archive's library: the archive's own photos next to a source's, each album
// listed once, and the archive's file as the copy in the library folder. Run with `npm run test:ui`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { loadConfig } from '../../src/config.js';
import { initArchive } from '../../src/archive.js';
import { openLibrary, scanAll } from '../../src/app.js';
import { writeManifest } from '../../src/export.js';
import { createApp } from '../../src/server.js';
import { openPage } from './page.js';

const jpeg = (r, g, b) => sharp({ create: { width: 160, height: 120, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
const ctx = {};
const texts = (selector) => ctx.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\s+/g, ' ').trim()), selector);
const albums = () => ctx.page.evaluate(() => [...document.querySelectorAll('#albums .album-text')].map((a) => [...a.children].map((c) => c.textContent).join(' · ')));

before(async () => {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-ui-archive-')));
  const put = async (file, data) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  };
  // The archive has IMG_1 (also in the Takeout's "Trip") and IMG_2; the Takeout also has IMG_9 in "Lisbon".
  const root = path.join(tmp, 'Pictures');
  const takeout = path.join(tmp, 'Takeout');
  const [red, green] = [await jpeg(200, 0, 0), await jpeg(0, 200, 0)];
  await put(path.join(root, '2019/08/IMG_1.jpg'), red);
  await put(path.join(root, '2019/08/IMG_2.jpg'), green);
  await put(path.join(takeout, 'Trip/IMG_1.jpg'), red);
  await put(path.join(takeout, 'Trip/metadata.json'), JSON.stringify({ title: 'Trip' }));
  await put(path.join(takeout, 'Lisbon/IMG_9.jpg'), await jpeg(0, 0, 200));
  await put(path.join(takeout, 'Lisbon/metadata.json'), JSON.stringify({ title: 'Lisbon' }));
  const entry = (data, localTime, albums) => ({
    hash: `quick-${localTime}`, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, kind: 'image',
    takenAt: new Date(`${localTime.replace(' ', 'T')}Z`).toISOString(), localTime, dateSource: 'filename', albums,
  });
  await writeManifest(root, {
    '2019/08/IMG_1.jpg': entry(red, '2019-08-02 18:00:00', ['Trip']),
    '2019/08/IMG_2.jpg': entry(green, '2019-08-03 09:30:00', ['Sailing']),
  });

  const dataDir = path.join(tmp, 'data');
  const config = loadConfig({ dataDir, archive: initArchive(root, { dataDir }) });
  const { library, indexer } = openLibrary(config, [takeout]);
  await scanAll(library, indexer);
  const byName = (name) => library.timeline({}).items.find((i) => library.media(i.id).filename === name);
  const watcher = { watchSource() {}, async unwatch() {} };
  const server = http.createServer(createApp({ library, indexer, watcher, config, reveal: async () => {} }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const page = await openPage({ profile: path.join(tmp, 'electron') });
  Object.assign(ctx, { tmp, root, takeout, library, server, page, img1: byName('IMG_1.jpg'), source: library.sources().find((s) => s.path === takeout) });
  await page.load(`http://localhost:${server.address().port}/`);
});

after(async () => {
  await ctx.page?.close();
  ctx.server?.closeAllConnections();
  ctx.server?.close();
  ctx.library?.close();
  if (ctx.tmp) await fs.rm(ctx.tmp, { recursive: true, force: true });
});

test("the archive's albums are listed once, by name; a source's album the archive lacks says where it's from", async () => {
  const { page } = ctx;
  await page.waitFor(() => document.querySelectorAll('.tile').length === 3 && document.querySelectorAll('#albums .album-text').length);
  assert.deepEqual(await texts('#sources .source .name'), ['Pictures', 'Takeout']);
  assert.deepEqual(await albums(), ['Lisbon · Takeout', 'Sailing', 'Trip']);
});

test("picking a source lists that source's own albums", async () => {
  const { page, source } = ctx;
  await page.click(`#sources [data-source="${source.id}"] .src-link`);
  await page.waitFor(() => document.querySelector('#view-title').textContent === 'From Takeout' && document.querySelectorAll('.tile').length === 2);
  assert.deepEqual(await albums(), ['Lisbon · Takeout', 'Trip · Takeout']);
  await page.click('#nav a[data-view="all"]');
  await page.waitFor(() => document.querySelector('#view-title').hidden && document.querySelectorAll('.tile').length === 3);
});

test("a photo's info names the source it came from, and the archive's file as the copy in the library folder", async () => {
  const { page, root, takeout, img1 } = ctx;
  await page.click(`.tile[data-id="${img1.id}"]`);
  await page.waitFor(() => document.querySelector('#lb-name').textContent === 'IMG_1.jpg');
  await page.click('#lb-info-btn');
  await page.waitFor(() => document.querySelector('#lightbox').classList.contains('info-open') && document.querySelector('#lb-info .place'));
  assert.deepEqual(await texts('#lb-info a.chip'), ['Takeout']);
  const places = await page.evaluate(() => [...document.querySelectorAll('#lb-info .place')].map((p) => [...p.children].map((c) => c.textContent.trim())));
  assert.deepEqual(places, [
    ['In your library folder', path.join(root, '2019/08/IMG_1.jpg')],
    ['Original · Takeout', path.join(takeout, 'Trip/IMG_1.jpg')],
  ]);
  await page.key('Escape');
});

test('nothing went wrong in the page', () => {
  assert.deepEqual(ctx.page.errors, []);
});
