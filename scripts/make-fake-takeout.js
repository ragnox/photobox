#!/usr/bin/env node
// Builds a fake Google Takeout export (plus a plain camera folder) that exercises
// every naming quirk Photobox handles. Usage: node scripts/make-fake-takeout.js <outDir> [--bulk 60]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const run = promisify(execFile);

const CITIES = {
  vienna: ['Vienna', 48.2082, 16.3738],
  salzburg: ['Salzburg', 47.8095, 13.055],
  hallstatt: ['Hallstatt', 47.5622, 13.6493],
  innsbruck: ['Innsbruck', 47.2692, 11.4041],
  lisbon: ['Lisbon', 38.7223, -9.1393],
  tokyo: ['Tokyo', 35.6762, 139.6503],
  kyoto: ['Kyoto', 35.0116, 135.7681],
  newyork: ['New York', 40.7128, -74.006],
  dubrovnik: ['Dubrovnik', 42.6507, 18.0944],
};

const SIZES = [[1600, 1200], [1200, 1600], [1600, 900], [1200, 1200], [2400, 800], [1500, 1000], [1000, 1500]];

function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
const escapeXml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** A little landscape postcard with a label, so the timeline has something to look at. */
async function postcard(file, { width, height, hue, label, sub, exif }) {
  const m = Math.min(width, height);
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,38%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#sky)"/>
    <circle cx="${width * 0.72}" cy="${height * 0.3}" r="${m * 0.11}" fill="hsl(${(hue + 190) % 360},95%,88%)" opacity="0.9"/>
    <path d="M0 ${height * 0.72} L${width * 0.28} ${height * 0.46} L${width * 0.5} ${height * 0.66} L${width * 0.78} ${height * 0.42} L${width} ${height * 0.62} L${width} ${height} L0 ${height} Z" fill="hsl(${(hue + 200) % 360},35%,22%)" opacity="0.75"/>
    <path d="M0 ${height * 0.84} Q${width * 0.5} ${height * 0.74} ${width} ${height * 0.86} L${width} ${height} L0 ${height} Z" fill="hsl(${(hue + 160) % 360},30%,14%)"/>
    <text x="50%" y="${height * 0.9}" font-family="Helvetica Neue, Helvetica, Arial" font-weight="700" font-size="${m * 0.075}" fill="#fff" text-anchor="middle">${escapeXml(label)}</text>
    <text x="50%" y="${height * 0.96}" font-family="Helvetica Neue, Helvetica, Arial" font-size="${m * 0.04}" fill="#fff" fill-opacity="0.8" text-anchor="middle">${escapeXml(sub)}</text>
  </svg>`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  let img = sharp(Buffer.from(svg)).jpeg({ quality: 80 });
  if (exif) img = img.withExif(exif);
  await img.toFile(file);
}

function sidecar({ title, taken, city, description = '', favorited, people, trashed }) {
  const [, lat, lon] = city ? CITIES[city] : [null, 0, 0];
  const geo = { latitude: lat, longitude: lon, altitude: 0, latitudeSpan: 0, longitudeSpan: 0 };
  const data = {
    title,
    description,
    imageViews: '4',
    creationTime: { timestamp: String(taken + 3 * 86400), formatted: new Date((taken + 3 * 86400) * 1000).toUTCString() },
    photoTakenTime: { timestamp: String(taken), formatted: new Date(taken * 1000).toUTCString() },
    geoData: geo,
    geoDataExif: geo,
    url: `https://photos.google.com/photo/AF1Qip${Buffer.from(title).toString('base64url').slice(0, 20)}`,
    googlePhotosOrigin: { mobileUpload: { deviceType: 'ANDROID_PHONE' } },
  };
  if (people) data.people = people.map((name) => ({ name }));
  if (favorited) data.favorited = true;
  if (trashed) data.trashed = true;
  return data;
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

export async function makeFakeTakeout(out, { bulk = 60 } = {}) {
  const random = rng(42);
  const pick = (arr) => arr[Math.floor(random() * arr.length)];
  const gp1 = path.join(out, 'takeout-20251020T101500Z-001', 'Takeout', 'Google Photos');
  const gp2 = path.join(out, 'takeout-20251020T101500Z-002', 'Takeout', 'Google Photos');
  const camera = path.join(out, 'Camera Roll');

  const shot = async (dir, name, { taken, city, jsonName = `${name}.json`, title = name, hue, size, exif, json = {}, label } = {}) => {
    const [width, height] = size ?? pick(SIZES);
    const cityName = city ? CITIES[city][0] : 'Somewhere';
    const day = new Date(taken * 1000).toISOString().slice(0, 10);
    await postcard(path.join(dir, name), { width, height, hue: hue ?? Math.floor(random() * 360), label: label ?? cityName, sub: `${day} · ${name}`, exif });
    if (jsonName) await writeJson(path.join(dir, jsonName), sidecar({ title, taken, city, ...json }));
  };

  // --- Edge cases (takeout part 1) ---------------------------------------
  const y2019 = path.join(gp1, 'Photos from 2019');
  await shot(y2019, 'DSC_0001.JPG', {
    taken: ts('2019-07-13T08:15:00Z'), city: 'vienna', size: [1600, 1200], hue: 30,
    json: { description: 'Stephansdom at golden hour', favorited: true, people: ['Anna'] },
  });
  await shot(y2019, 'DSC_0002.JPG', {
    taken: ts('2019-07-14T10:00:00Z'), city: 'vienna', jsonName: 'DSC_0002.JPG.supplemental-metadata.json',
  });
  await shot(y2019, 'DSC_0003.JPG', { taken: ts('2019-08-01T12:00:00Z'), city: 'salzburg' });
  await shot(y2019, 'DSC_0003(1).JPG', {
    taken: ts('2019-08-02T15:30:00Z'), city: 'hallstatt', jsonName: 'DSC_0003.JPG(1).json', title: 'DSC_0003.JPG',
  });
  await shot(y2019, 'DSC_0004.JPG', {
    taken: ts('2019-08-05T09:00:00Z'), city: 'salzburg', jsonName: 'DSC_0004.JPG.supplemental-metadata.json',
  });
  await shot(y2019, 'DSC_0004(1).JPG', {
    taken: ts('2019-08-06T09:00:00Z'), city: 'innsbruck', jsonName: 'DSC_0004.JPG.supplemental-metadata(1).json', title: 'DSC_0004.JPG',
  });
  await shot(y2019, 'DSC_0005.JPG', { taken: ts('2019-08-10T18:45:00Z'), city: 'dubrovnik', hue: 200 });
  await shot(y2019, 'DSC_0005-edited.JPG', {
    taken: ts('2019-08-10T18:45:00Z'), city: 'dubrovnik', hue: 215, jsonName: null, label: 'Dubrovnik (edited)',
  });
  await shot(y2019, 'DSC_0006.JPG', {
    taken: ts('2019-08-11T07:20:00Z'), city: 'dubrovnik', jsonName: 'DSC_0006.JPG.supplemental-metadata.json',
  });
  await shot(y2019, 'DSC_0006-bearbeitet.JPG', {
    taken: ts('2019-08-11T07:20:00Z'), city: 'dubrovnik', jsonName: null, label: 'Dubrovnik (bearbeitet)',
  });
  const longName = 'Screenshot_20200314-153000_Some Very Long Application Name.png';
  await shot(y2019, longName, {
    // Deliberately not the date in the file name: the sidecar must win.
    taken: ts('2019-09-01T11:11:00Z'), jsonName: 'Screenshot_20200314-153000_Some Very Long Appl.json', title: longName, size: [900, 1600],
  });
  const cafe = 'Café Central.jpg';
  await shot(y2019, cafe.normalize('NFD'), {
    taken: ts('2019-09-03T14:00:00Z'), city: 'vienna', jsonName: `${cafe}.json`.normalize('NFC'), title: cafe,
  });
  await shot(y2019, 'DSC_9999.JPG', { taken: ts('2019-09-04T10:00:00Z'), json: { trashed: true }, label: 'TRASHED - must not show' });

  // Live photo: HEIC still + short MP4 sharing one sidecar.
  const still = path.join(out, '.tmp-live.jpg');
  await postcard(still, { width: 1512, height: 2016, hue: 280, label: 'Live photo', sub: 'Lisbon · IMG_1234.HEIC' });
  await run('sips', ['-s', 'format', 'heic', still, '--out', path.join(y2019, 'IMG_1234.HEIC')]);
  await run('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', still, '-t', '2', '-r', '15',
    '-vf', 'scale=480:-2,zoompan=z=\'min(zoom+0.004,1.15)\':d=30:s=480x640', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(y2019, 'IMG_1234.MP4')]);
  await writeJson(path.join(y2019, 'IMG_1234.HEIC.json'), sidecar({ title: 'IMG_1234.HEIC', taken: ts('2019-09-20T17:30:00Z'), city: 'lisbon' }));

  // A real video with its own sidecar.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(y2019, 'VID_20190820_183000.mp4')]);
  await writeJson(path.join(y2019, 'VID_20190820_183000.mp4.json'), sidecar({ title: 'VID_20190820_183000.mp4', taken: ts('2019-08-20T16:30:00Z'), city: 'hallstatt' }));
  await fs.rm(still);

  // Split zip parts: photo in part 1, its sidecar in part 2.
  await shot(path.join(gp1, 'Photos from 2018'), 'DSC_1001.JPG', { taken: ts('2018-12-24T18:00:00Z'), city: 'innsbruck', jsonName: null, label: 'Christmas' });
  await writeJson(path.join(gp2, 'Photos from 2018', 'DSC_1001.JPG.json'), sidecar({ title: 'DSC_1001.JPG', taken: ts('2018-12-24T18:00:00Z'), city: 'innsbruck' }));

  // Album (part 2) holding a duplicate of DSC_0001.JPG plus its own photos.
  const album = path.join(gp2, 'Summer in Vienna');
  await writeJson(path.join(album, 'metadata.json'), { title: 'Summer in Vienna ☀️', description: '', access: 'protected', date: { timestamp: String(ts('2019-07-20T00:00:00Z')), formatted: '' } });
  await fs.copyFile(path.join(y2019, 'DSC_0001.JPG'), path.join(album, 'DSC_0001.JPG'));
  await fs.copyFile(path.join(y2019, 'DSC_0001.JPG.json'), path.join(album, 'DSC_0001.JPG.json'));
  await fs.copyFile(path.join(y2019, 'DSC_0002.JPG'), path.join(album, 'DSC_0002.JPG'));
  await fs.copyFile(path.join(y2019, 'DSC_0002.JPG.supplemental-metadata.json'), path.join(album, 'DSC_0002.JPG.supplemental-metadata.json'));
  for (let i = 0; i < 4; i++) {
    await shot(album, `PXL_201907${15 + i}_1${i}0000000.jpg`, { taken: ts(`2019-07-${15 + i}T1${i}:00:00Z`), city: 'vienna' });
  }

  // Album (part 1) whose photos also live in "Photos from 2023".
  const japan = path.join(gp1, 'Japan 2023');
  await writeJson(path.join(japan, 'metadata.json'), { title: 'Japan 2023', description: 'Two weeks, one rail pass', access: 'protected', date: { timestamp: String(ts('2023-04-01T00:00:00Z')) } });
  for (let i = 0; i < 9; i++) {
    const name = `DSC_3${String(i).padStart(3, '0')}.JPG`;
    const dir = path.join(gp1, 'Photos from 2023');
    await shot(dir, name, { taken: ts(`2023-04-0${1 + i}T0${i}:30:00Z`), city: i < 5 ? 'tokyo' : 'kyoto', hue: 330 + i * 4 });
    await fs.copyFile(path.join(dir, name), path.join(japan, name));
    await fs.copyFile(path.join(dir, `${name}.json`), path.join(japan, `${name}.json`));
  }

  // Bulk filler across the years so the timeline has some depth.
  for (let i = 0; i < bulk; i++) {
    const year = 2016 + Math.floor(random() * 10);
    const date = new Date(Date.UTC(year, Math.floor(random() * 12), 1 + Math.floor(random() * 28), Math.floor(random() * 24), Math.floor(random() * 60)));
    if (date > new Date()) continue;
    const name = `DSC_${String(5000 + i)}.JPG`;
    const newStyle = random() < 0.5;
    await shot(path.join(i % 2 ? gp1 : gp2, `Photos from ${year}`), name, {
      taken: Math.floor(date / 1000), city: pick(Object.keys(CITIES)),
      jsonName: newStyle ? `${name}.supplemental-metadata.json` : `${name}.json`,
    });
  }

  // Plain camera folder: no sidecars, dates and GPS from EXIF.
  for (let i = 0; i < 8; i++) {
    const local = `2025:0${3 + (i % 5)}:1${i} 1${i}:2${i}:00`;
    const [, lat, lon] = CITIES[i % 2 ? 'hallstatt' : 'vienna'];
    const dms = (v) => {
      const a = Math.abs(v);
      return `${Math.floor(a)}/1 ${Math.floor((a % 1) * 60)}/1 ${Math.round((((a % 1) * 60) % 1) * 6000)}/100`;
    };
    const name = `IMG_${local.slice(0, 10).replaceAll(':', '')}_${local.slice(11).replaceAll(':', '')}.jpg`;
    await postcard(path.join(camera, name), {
      width: 1600, height: 1200, hue: 90 + i * 15, label: i % 2 ? 'Hallstatt' : 'Vienna', sub: `EXIF ${local}`,
      exif: {
        IFD0: { Make: 'Google', Model: 'Pixel 8' },
        IFD2: { DateTimeOriginal: local, OffsetTimeOriginal: '+02:00' },
        IFD3: { GPSLatitudeRef: lat >= 0 ? 'N' : 'S', GPSLatitude: dms(lat), GPSLongitudeRef: lon >= 0 ? 'E' : 'W', GPSLongitude: dms(lon) },
      },
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { bulk: { type: 'string', default: '60' } } });
  const out = path.resolve(positionals[0] ?? 'fixtures/demo');
  await fs.rm(out, { recursive: true, force: true });
  const started = Date.now();
  await makeFakeTakeout(out, { bulk: Number(values.bulk) });
  console.log(`Fake Takeout written to ${out} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
