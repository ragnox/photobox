// The library API on this computer: naming sources, showing one source, versions, and where a photo is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Library } from '../src/db.js';
import { Indexer } from '../src/indexer.js';
import { createApp } from '../src/server.js';
import { MANIFEST } from '../src/manifest.js';

async function setup(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-api-'));
  const config = loadConfig({ dataDir: path.join(tmp, 'data'), backupDir: path.join(tmp, 'Photos') });
  const library = new Library(config.dbPath);
  const indexer = new Indexer(library, config);
  const watcher = { watchSource() {}, async unwatch() {} };
  const server = await new Promise((resolve) => {
    const s = http.createServer(createApp({ library, indexer, watcher, config }));
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    library.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const api = async (method, url, body) => {
    const res = await fetch(`http://localhost:${server.address().port}${url}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const add = (source, name, sha256) => {
    const id = library.insertMedia({ hash: sha256, sha256, kind: 'image', filename: name, takenAt: 0, localTime: '2024-03-07 14:15:44', dateSource: 'exif' });
    library.upsertFile({ path: path.join(source.path, name), sourceId: source.id, mediaId: id, size: 1, mtime: 0 });
    return id;
  };
  return { tmp, config, library, api, add };
}

test('sources get names, and the timeline can show one source', async (t) => {
  const { library, api, add } = await setup(t);
  const main = library.addSource('/google-main');
  const second = library.addSource('/google-second');
  const a = add(main, 'a.jpg', 'a'.repeat(64));
  const b = add(second, 'b.jpg', 'b'.repeat(64));

  assert.equal((await api('POST', `/api/sources/${second.id}/name`, { name: '  Google, second account ' })).json.name, 'Google, second account');
  assert.deepEqual((await api('GET', '/api/status')).json.sources.map((s) => s.name), [null, 'Google, second account']);
  assert.deepEqual((await api('GET', `/api/timeline?source=${second.id}`)).json.items.map((i) => i.id), [b]);
  assert.deepEqual((await api('GET', '/api/timeline')).json.items.map((i) => i.id).sort(), [a, b].sort());
  assert.equal((await api('POST', `/api/sources/${second.id}/name`, { name: '' })).json.name, null, 'empty: back to the folder name');
  assert.equal((await api('POST', '/api/sources/99/name', { name: 'x' })).status, 404);
});

test('"not the same photo" shows both again; only a version can be kept apart', async (t) => {
  const { library, api, add } = await setup(t);
  const main = library.addSource('/google-main');
  const second = library.addSource('/google-second');
  const small = add(main, 'PXL_1.jpg', 'a'.repeat(64));
  const big = add(second, 'PXL_1.jpg', 'b'.repeat(64));
  const unrelated = add(second, 'other.jpg', 'c'.repeat(64));
  library.applyVersions(new Map([[small, big]]));

  const details = (await api('GET', `/api/media/${big}`)).json;
  assert.deepEqual(details.versions.map((v) => v.id), [small]);
  assert.deepEqual(details.sources.sort(), [main.id, second.id]);
  assert.equal((await api('POST', `/api/media/${big}/separate`, { from: unrelated })).status, 400);
  assert.equal((await api('POST', `/api/media/${big}/separate`, { from: small })).status, 200);
  assert.deepEqual((await api('GET', '/api/timeline')).json.items.map((i) => i.id).sort(), [small, big, unrelated].sort());
});

test('a photo\'s details say where its copy in the library folder is; only its own files can be shown in Finder', async (t) => {
  const { config, library, api, add } = await setup(t);
  const source = library.addSource('/google-main');
  const id = add(source, 'PXL_1.jpg', 'a'.repeat(64));
  assert.equal((await api('GET', `/api/media/${id}`)).json.copy, null);

  await fs.mkdir(path.join(config.backupDir, '2024/03'), { recursive: true });
  await fs.writeFile(path.join(config.backupDir, '2024/03/PXL_1.jpg'), 'x');
  await fs.writeFile(path.join(config.backupDir, MANIFEST), JSON.stringify({
    version: 1, items: { '2024/03/PXL_1.jpg': { hash: 'h', sha256: 'a'.repeat(64) }, '../escape.jpg': { hash: 'h', sha256: 'a'.repeat(64) } },
  }));
  assert.equal((await api('GET', `/api/media/${id}`)).json.copy, path.join(config.backupDir, '2024/03/PXL_1.jpg'));
  if (process.platform === 'darwin') {
    assert.equal((await api('POST', `/api/media/${id}/reveal`, { path: '/etc/hosts' })).status, 404);
  }
});
