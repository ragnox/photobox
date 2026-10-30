// Media types: from the name, and from the content for names without an extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectMediaKind, mediaExt, sniffExt } from '../src/media.js';

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const ftyp = (brand) => bytes([0, 0, 0, 24], 'ftyp', brand, [0, 0, 0, 0]);

test('the first bytes tell the media type', () => {
  assert.equal(sniffExt(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')), '.jpg');
  assert.equal(sniffExt(bytes('\x89PNG\r\n\x1a\n')), '.png');
  assert.equal(sniffExt(bytes('GIF89a')), '.gif');
  assert.equal(sniffExt(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), '.webp');
  assert.equal(sniffExt(ftyp('heic')), '.heic');
  assert.equal(sniffExt(ftyp('avif')), '.avif');
  assert.equal(sniffExt(ftyp('qt  ')), '.mov');
  assert.equal(sniffExt(ftyp('isom')), '.mp4');
  assert.equal(sniffExt(ftyp('3gp4')), '.3gp');
  assert.equal(sniffExt(bytes('%PDF-1.7')), null);
  assert.equal(sniffExt(bytes('{"title"')), null);
  assert.equal(sniffExt(Buffer.alloc(0)), null);
});

test('only a name without an extension is judged by its content', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-media-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const put = (name, content) => fs.writeFile(path.join(dir, name), content);
  await put('30.12.11 - 1', bytes([0xff, 0xd8, 0xff, 0xe1]));
  await put('clip', ftyp('mp42'));
  await put('IMG_1.JPG', 'not even a JPEG');
  await put('scan.pdf', bytes([0xff, 0xd8, 0xff, 0xe1]));
  await put('README', 'text');
  const at = (name) => path.join(dir, name);
  assert.equal(await mediaExt(at('30.12.11 - 1')), '.jpg');
  assert.equal(await detectMediaKind(at('30.12.11 - 1')), 'image');
  assert.equal(await detectMediaKind(at('clip')), 'video');
  assert.equal(await mediaExt(at('IMG_1.JPG')), '.JPG');
  assert.equal(await detectMediaKind(at('scan.pdf')), null);
  assert.equal(await detectMediaKind(at('README')), null);
  assert.equal(await detectMediaKind(at('gone')), null);
});
