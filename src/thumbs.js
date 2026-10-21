import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);
sharp.cache(false);

// Grid rows are ~220px tall; 440px covers 2x displays. Panoramas may get wide.
const THUMB = { width: 1400, height: 440 };
const PREVIEW = 2560;

/** Path inside a cache dir, sharded by hash: thumbs/ab/abcdef….webp */
export function cachePath(dir, hash, ext) {
  return path.join(dir, hash.slice(0, 2), `${hash}${ext}`);
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'photobox-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// macOS can decode HEIC and most RAW formats that the prebuilt libvips cannot.
async function viaSips(file, maxSize, fn) {
  if (process.platform !== 'darwin') throw new Error('unsupported image format');
  return withTempDir(async (dir) => {
    const out = path.join(dir, 'converted.jpg');
    await run('sips', ['-s', 'format', 'jpeg', '-Z', String(maxSize), file, '--out', out]);
    return fn(out);
  });
}

async function videoFrame(file, duration) {
  const seek = duration ? Math.min(1, duration / 3) : 0;
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-ss', String(seek), '-i', file, '-frames:v', '1', '-vf', `scale=-2:${THUMB.height * 2}`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  if (!stdout.length) throw new Error('ffmpeg produced no frame');
  return stdout;
}

async function writeThumb(input, out) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const info = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize({ ...THUMB, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 74 })
    .toFile(out);
  return { width: info.width, height: info.height };
}

/** Create a thumbnail; returns its { width, height }. Throws if the file cannot be decoded. */
export async function makeThumbnail(file, kind, out, { duration } = {}) {
  if (kind === 'video') return writeThumb(await videoFrame(file, duration), out);
  try {
    return await writeThumb(file, out);
  } catch {
    return viaSips(file, THUMB.width, (jpg) => writeThumb(jpg, out));
  }
}

/** Full-size JPEG for formats a browser cannot display (HEIC, TIFF, RAW). */
export async function makePreview(file, out) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  const write = (input) =>
    sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: PREVIEW, height: PREVIEW, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(out);
  try {
    await write(file);
  } catch {
    await viaSips(file, PREVIEW, write);
  }
  return out;
}

/** Oriented pixel size, when sharp can read the file. */
export async function imageSize(file) {
  try {
    const meta = await sharp(file).metadata();
    const oriented = meta.autoOrient ?? meta;
    return { width: oriented.width ?? null, height: oriented.height ?? null };
  } catch {
    return {};
  }
}
