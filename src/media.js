import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp',
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.srw', '.pef',
]);
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm', '.mts', '.m2ts', '.wmv', '.mpg', '.mpeg',
  '.mp', // the clip of a Pixel motion photo in Google Takeout ("X.MP" next to "X.MP.jpg"): an MP4
]);
export const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);

// What a browser can show as-is; everything else gets a generated preview.
export const BROWSER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
export const BROWSER_VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mp']);

/** Is this the clip of a Pixel motion photo, as Google Takeout delivers it ("X.MP", still "X.MP.jpg")? */
export const isMotionClip = (file) => file.toLowerCase().endsWith('.mp');

/** 'image' | 'video' | null */
export function mediaKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** Does the name end in what looks like a file extension ("IMG_1.jpg", "notes.pdf"; not "30.12.11 - 1")? */
const hasExtension = (file) => /^\.[a-z0-9]{1,5}$/i.test(path.extname(file));

// ISO media files ("....ftyp<brand>"): the brand tells HEIF and AVIF stills from QuickTime and MP4 video.
const FTYP_EXT = {
  heic: '.heic', heix: '.heic', hevc: '.heic', heim: '.heic', heis: '.heic', mif1: '.heif', msf1: '.heif',
  avif: '.avif', avis: '.avif', 'qt  ': '.mov', 'M4V ': '.m4v',
};

/** The media extension that a file's first bytes reveal, or null. */
export function sniffExt(head) {
  const ascii = (from, to) => head.subarray(from, to).toString('latin1');
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return '.png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return '.avi';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return '.tif';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return '.mkv';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    return FTYP_EXT[brand] ?? (brand.startsWith('3g') ? '.3gp' : '.mp4');
  }
  return null;
}

/**
 * The media extension a file's content shows, for a name without an extension: Google Takeout
 * names some photos after their date, "30.12.11 - 1", with nothing to say they are JPEGs.
 * Files with an extension are what their extension says, so they are never opened here.
 */
export async function sniffMediaExt(file) {
  if (hasExtension(file)) return null;
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return sniffExt(head.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** The extension a file's media type goes by: its own ("IMG_1.JPG" -> ".JPG"), else its content's, else null. */
export async function mediaExt(file) {
  return mediaKind(file) ? path.extname(file) : sniffMediaExt(file);
}

/** Like mediaKind, but a name without an extension is judged by the file's content. */
export async function detectMediaKind(file) {
  const ext = await mediaExt(file);
  return ext ? mediaKind(`media${ext}`) : null;
}

/** "IMG_1.jpg" -> "IMG_1"; names without a media extension stay as they are. */
export function stripMediaExt(name) {
  const ext = path.extname(name);
  return MEDIA_EXT.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}
