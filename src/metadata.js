import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import exifr from 'exifr';
import { parseTimestamp } from './dates.js';

const run = promisify(execFile);
const JPEG_HEAD = 256 * 1024;

/**
 * The bytes exifr needs. Given a path, exifr opens a file handle that it leaves open when a
 * file is damaged or empty, and Node then ends the process. A JPEG keeps its EXIF in a segment
 * of at most 64 KB near the start; other formats are read whole.
 */
async function metadataBytes(file) {
  if (!/\.jpe?g$/i.test(file)) return fs.readFile(file);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(JPEG_HEAD);
    const { bytesRead } = await handle.read(buffer, 0, JPEG_HEAD, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** EXIF from a photo: { date: {local, instant}, lat, lon, camera, width, height } (fields may be missing). */
export async function readImageMeta(file) {
  let tags;
  try {
    tags = await exifr.parse(await metadataBytes(file), {
      tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false, iptc: false,
      reviveValues: false, translateValues: false, mergeOutput: true,
    });
  } catch {
    return {};
  }
  if (!tags) return {};
  const date =
    parseTimestamp(tags.DateTimeOriginal, tags.OffsetTimeOriginal ?? tags.OffsetTime) ??
    parseTimestamp(tags.CreateDate, tags.OffsetTimeDigitized ?? tags.OffsetTime) ??
    parseTimestamp(tags.ModifyDate, tags.OffsetTime);
  const place = location(tags.latitude, tags.longitude);
  let width = tags.ExifImageWidth ?? tags.ImageWidth ?? null;
  let height = tags.ExifImageHeight ?? tags.ImageHeight ?? null;
  if (tags.Orientation >= 5 && tags.Orientation <= 8) [width, height] = [height, width];
  // The camera's own record of the moment, as written, to the sub-second if it keeps one.
  // Copies that were recompressed keep it, so it tells versions of a shot from other shots.
  const original = typeof tags.DateTimeOriginal === 'string' ? tags.DateTimeOriginal.trim() : '';
  const subsec = tags.SubSecTimeOriginal != null ? String(tags.SubSecTimeOriginal).trim() : '';
  return {
    date,
    ...place,
    camera: cameraName(tags.Make, tags.Model),
    width,
    height,
    shot: original ? [original, subsec].filter(Boolean).join('.') : null,
  };
}

/** { lat, lon } when both are numbers and not 0/0, which cameras and Google write for "no location". */
function location(lat, lon) {
  const known = Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
  return { lat: known ? lat : null, lon: known ? lon : null };
}

function cameraName(make, model) {
  make = typeof make === 'string' ? make.trim() : '';
  model = typeof model === 'string' ? model.trim() : '';
  if (!model) return make || null;
  // "Apple iPhone 12" rather than "Apple Apple iPhone 12"; "Canon EOS R6" rather than "Canon Canon EOS R6"
  return make && !model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? `${make} ${model}` : model;
}

let ffprobeMissing = false;

/** Duration, size, creation date and location of a video via ffprobe (if installed). */
export async function readVideoMeta(file) {
  if (ffprobeMissing) return {};
  let probe;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      maxBuffer: 16 * 1024 * 1024,
    });
    probe = JSON.parse(stdout);
  } catch (err) {
    if (err.code === 'ENOENT') ffprobeMissing = true;
    return {};
  }
  const stream = probe.streams?.find((s) => s.codec_type === 'video');
  const tags = Object.fromEntries(Object.entries(probe.format?.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let width = stream?.width ?? null;
  let height = stream?.height ?? null;
  const rotation = Number(stream?.tags?.rotate ?? stream?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];

  const date = parseTimestamp(tags['com.apple.quicktime.creationdate']) ?? parseTimestamp(tags.creation_time);
  const iso6709 = tags['com.apple.quicktime.location.iso6709'] ?? tags.location ?? tags['location-eng'];
  const loc = typeof iso6709 === 'string' && iso6709.match(/([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
  const duration = Number(probe.format?.duration);
  return {
    date,
    ...(loc ? location(Number(loc[1]), Number(loc[2])) : { lat: null, lon: null }),
    camera: cameraName(tags['com.apple.quicktime.make'], tags['com.apple.quicktime.model']),
    width,
    height,
    duration: Number.isFinite(duration) ? duration : null,
  };
}
