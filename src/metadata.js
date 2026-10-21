import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import exifr from 'exifr';
import { parseTimestamp } from './dates.js';

const run = promisify(execFile);

/** EXIF from a photo: { date: {local, instant}, lat, lon, camera, width, height } (fields may be missing). */
export async function readImageMeta(file) {
  let tags;
  try {
    tags = await exifr.parse(file, {
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
  const lat = Number.isFinite(tags.latitude) ? tags.latitude : null;
  const lon = Number.isFinite(tags.longitude) ? tags.longitude : null;
  let width = tags.ExifImageWidth ?? tags.ImageWidth ?? null;
  let height = tags.ExifImageHeight ?? tags.ImageHeight ?? null;
  if (tags.Orientation >= 5 && tags.Orientation <= 8) [width, height] = [height, width];
  return {
    date,
    lat: lat === 0 && lon === 0 ? null : lat,
    lon: lat === 0 && lon === 0 ? null : lon,
    camera: cameraName(tags.Make, tags.Model),
    width,
    height,
  };
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
    lat: loc ? Number(loc[1]) : null,
    lon: loc ? Number(loc[2]) : null,
    camera: cameraName(tags['com.apple.quicktime.make'], tags['com.apple.quicktime.model']),
    width,
    height,
    duration: Number.isFinite(duration) ? duration : null,
  };
}
