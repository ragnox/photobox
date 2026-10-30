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
const cachePath = (dir, hash, ext) => path.join(dir, hash.slice(0, 2), `${hash}${ext}`);
export const thumbPath = (config, hash) => cachePath(config.thumbsDir, hash, '.webp');
export const previewPath = (config, hash) => cachePath(config.previewsDir, hash, '.jpg');

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
}

/**
 * 64-bit difference hash of an image (a thumbnail will do), as hex: each bit says whether a
 * pixel of a 9x8 greyscale version is brighter than its right neighbour. Copies of one
 * picture differ in a few bits at most, whatever their size or compression.
 */
export async function differenceHash(file) {
  const { data, info } = await sharp(file).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => data[(y * 9 + x) * info.channels];
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (at(x, y) > at(x + 1, y) ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
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
