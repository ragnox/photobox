// Small monochrome template images, including progress rings, for macOS menu bars.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../desktop/icons/', import.meta.url));
await fs.mkdir(root, { recursive: true });
const photo = '<rect x="3.5" y="5" width="11" height="8.5" rx="1.5" fill="none" stroke="black" stroke-width="1.3"/><path d="m5 12 3-3 2 2 1-1 2 2" fill="none" stroke="black" stroke-width="1.1"/><circle cx="11.5" cy="7.5" r="1" fill="black"/>';
const variants = new Map([
  ['tray', photo],
  ['busy', '<path d="M3 8a6 6 0 0 1 10-4M13 1v4h-4M15 10a6 6 0 0 1-10 4M5 17v-4h4" fill="none" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>'],
  ['warning', '<path d="m9 2 7 13H2Z" fill="none" stroke="black" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 6v4" stroke="black" stroke-width="1.5"/><circle cx="9" cy="12.5" r=".8" fill="black"/>'],
]);
for (let value = 0; value <= 100; value += 10) {
  variants.set(`progress-${value}`, `<circle cx="9" cy="9" r="7" fill="none" stroke="black" stroke-opacity=".2" stroke-width="1.5"/><circle cx="9" cy="9" r="7" fill="none" stroke="black" stroke-width="1.5" stroke-dasharray="${44 * value / 100} 44" transform="rotate(-90 9 9)"/><path d="m6 9 2 2 4-4" fill="none" stroke="black" stroke-width="1.3"/>`);
}
for (const [name, drawing] of variants) for (const scale of [1, 2]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">${drawing}</svg>`;
  await sharp(Buffer.from(svg)).resize(18 * scale, 18 * scale).png().toFile(`${root}${name}Template${scale === 2 ? '@2x' : ''}.png`);
}
