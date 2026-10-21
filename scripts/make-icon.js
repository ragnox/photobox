#!/usr/bin/env node
// Renders build/icon.png (1024², macOS icon grid). electron-builder turns it into .icns/.ico.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const out = fileURLToPath(new URL('../build/icon.png', import.meta.url));

// 824px tile on a 1024 canvas with a soft shadow, per Apple's icon template.
const svg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
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
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <g clip-path="url(#tile)">
    <circle cx="660" cy="350" r="92" fill="#ffd66b"/>
    <path d="M100 760 L330 470 L470 640 L560 540 L760 760 L924 640 L924 924 L100 924 Z" fill="url(#far)"/>
    <path d="M100 924 L100 800 L300 590 L470 780 L600 660 L924 900 L924 924 Z" fill="#ffffff"/>
  </g>
</svg>`;

await fs.mkdir(new URL('../build/', import.meta.url), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`Wrote ${out}`);
