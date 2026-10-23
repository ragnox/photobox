#!/usr/bin/env node
// Renders the app icons from one artwork:
//   build/icon.png        1024², macOS icon grid; electron-builder turns it into .icns/.ico
//   public/icons/*.png    for the installable web app (Android home screen, browser tabs)
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

// The artwork sits on an 824px tile (x/y 100..924) of a 1024 canvas.
//   mac:      the whole canvas, with Apple's margin and a soft shadow
//   app:      just the rounded tile
//   maskable: the tile edge to edge; Android crops it to its own shape
function svg(kind) {
  const viewBox = kind === 'mac' ? '0 0 1024 1024' : '100 100 824 824';
  const rx = kind === 'maskable' ? 0 : 185;
  return `<svg width="1024" height="1024" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5b7cfa"/>
      <stop offset="1" stop-color="#2f4ac4"/>
    </linearGradient>
    <linearGradient id="far" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.35"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#0b1440" flood-opacity="0.35"/>
    </filter>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="${rx}"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="${rx}" fill="url(#bg)"${kind === 'mac' ? ' filter="url(#shadow)"' : ''}/>
  <g clip-path="url(#tile)">
    <circle cx="660" cy="350" r="92" fill="#ffd66b"/>
    <path d="M100 760 L330 470 L470 640 L560 540 L760 760 L924 640 L924 924 L100 924 Z" fill="url(#far)"/>
    <path d="M100 924 L100 800 L300 590 L470 780 L600 660 L924 900 L924 924 Z" fill="#ffffff"/>
  </g>
</svg>`;
}

const icons = [
  ['build/icon.png', 'mac', 1024],
  ['public/icons/icon-192.png', 'app', 192],
  ['public/icons/icon-512.png', 'app', 512],
  ['public/icons/maskable-512.png', 'maskable', 512],
];

await fs.mkdir(out('build/'), { recursive: true });
await fs.mkdir(out('public/icons/'), { recursive: true });
for (const [file, kind, size] of icons) {
  await sharp(Buffer.from(svg(kind))).resize(size, size).png().toFile(out(file));
  console.log(`Wrote ${out(file)}`);
}
