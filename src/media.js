import path from 'node:path';

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.tif', '.tiff', '.bmp',
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2', '.raf', '.srw', '.pef',
]);
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.m4v', '.3gp', '.avi', '.mkv', '.webm', '.mts', '.m2ts', '.wmv', '.mpg', '.mpeg',
]);
export const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT]);

// What a browser can show as-is; everything else gets a generated preview.
export const BROWSER_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp']);
export const BROWSER_VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm']);

/** 'image' | 'video' | null */
export function mediaKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

/** "IMG_1.jpg" -> "IMG_1"; names without a media extension stay as they are. */
export function stripMediaExt(name) {
  const ext = path.extname(name);
  return MEDIA_EXT.has(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}
