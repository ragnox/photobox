import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SidecarIndex, classifyJson, albumTitle, parseSidecarName, mediaNameVariants, sidecarMeta, takeoutFolderKey,
} from '../src/takeout/sidecar.js';

const sidecar = (title, ts = 1563005700) => ({ title, photoTakenTime: { timestamp: String(ts) } });

function indexOf(names) {
  const idx = new SidecarIndex();
  for (const [file, title] of Object.entries(names)) idx.add(`/t/${file}`, sidecar(title));
  return idx;
}

const found = (idx, media) => idx.find(media)?.entry.path.slice(3) ?? null;

test('parseSidecarName handles old, new, duplicate and truncated names', () => {
  assert.deepEqual(parseSidecarName('IMG_1.jpg.json'), { stem: 'IMG_1.jpg', counter: null });
  assert.deepEqual(parseSidecarName('IMG_1.jpg(1).json'), { stem: 'IMG_1.jpg', counter: 1 });
  assert.deepEqual(parseSidecarName('IMG_1.jpg.supplemental-metadata.json'), { stem: 'IMG_1.jpg', counter: null });
  assert.deepEqual(parseSidecarName('IMG_1.jpg.supplemental-metadata(12).json'), { stem: 'IMG_1.jpg', counter: 12 });
  assert.deepEqual(parseSidecarName('PXL_20230416_150838215.jpg.supplemental-met.json'), { stem: 'PXL_20230416_150838215.jpg', counter: null });
  assert.deepEqual(parseSidecarName('PXL_20230416_150838215.MP.jpg.s.json'), { stem: 'PXL_20230416_150838215.MP.jpg', counter: null });
  assert.deepEqual(parseSidecarName('Screenshot_2020_Some_Long_Thing.png..json'), { stem: 'Screenshot_2020_Some_Long_Thing.png', counter: null });
});

test('mediaNameVariants strips counters and localized edit suffixes', () => {
  assert.deepEqual(mediaNameVariants('IMG_1(2).jpg'), [{ base: 'IMG_1.jpg', counter: 2 }]);
  assert.deepEqual(mediaNameVariants('IMG_1-edited.jpg'), [
    { base: 'IMG_1-edited.jpg', counter: null },
    { base: 'IMG_1.jpg', counter: null },
  ]);
  assert.deepEqual(mediaNameVariants('IMG_1(1)-bearbeitet.JPG')[1], { base: 'IMG_1.JPG', counter: 1 });
  assert.deepEqual(mediaNameVariants('IMG_1-modifié.jpg'.normalize('NFD'))[1], { base: 'IMG_1.jpg', counter: null });
});

test('matches plain, supplemental and duplicate sidecars to the right file', () => {
  const idx = indexOf({
    'DSC_0001.JPG.json': 'DSC_0001.JPG',
    'DSC_0002.JPG.supplemental-metadata.json': 'DSC_0002.JPG',
    'DSC_0003.JPG.json': 'DSC_0003.JPG',
    'DSC_0003.JPG(1).json': 'DSC_0003.JPG',
    'DSC_0004.JPG.supplemental-metadata(1).json': 'DSC_0004.JPG',
  });
  assert.equal(found(idx, 'DSC_0001.JPG'), 'DSC_0001.JPG.json');
  assert.equal(found(idx, 'DSC_0002.JPG'), 'DSC_0002.JPG.supplemental-metadata.json');
  assert.equal(found(idx, 'DSC_0003.JPG'), 'DSC_0003.JPG.json');
  assert.equal(found(idx, 'DSC_0003(1).JPG'), 'DSC_0003.JPG(1).json');
  assert.equal(found(idx, 'DSC_0004(1).JPG'), 'DSC_0004.JPG.supplemental-metadata(1).json');
  assert.equal(found(idx, 'DSC_0004.JPG'), null, 'must not steal the (1) sidecar');
});

test('edited copies share the original sidecar', () => {
  const idx = indexOf({ 'IMG_5.jpg.json': 'IMG_5.jpg', 'IMG_6.JPG.json': 'IMG_6.JPG' });
  assert.equal(found(idx, 'IMG_5-edited.jpg'), 'IMG_5.jpg.json');
  assert.equal(found(idx, 'IMG_6-bearbeitet.JPG'), 'IMG_6.JPG.json');
});

test('truncated sidecar names match by prefix', () => {
  const media = 'Screenshot_20200314-153000_Some Very Long Application Name.png';
  const idx = indexOf({
    'Screenshot_20200314-153000_Some Very Long Appl.json': media,
    'Screenshot_20200314-160000_Another Long Applicat.json': 'Screenshot_20200314-160000_Another Long Application.png',
  });
  assert.equal(found(idx, media), 'Screenshot_20200314-153000_Some Very Long Appl.json');
  // Title wins over prefix when it is an exact hit.
  assert.equal(idx.find(media).method, 'title');

  const untitled = new SidecarIndex();
  untitled.add('/t/Screenshot_20200314-153000_Some Very Long Appl.json', { photoTakenTime: { timestamp: '1' } });
  assert.equal(untitled.find(media).method, 'truncated');
});

test('falls back to the title when the disk name was sanitized', () => {
  const idx = indexOf({ 'Party_ 2019.jpg.json': 'Party: 2019.jpg' });
  assert.equal(found(idx, 'Party_ 2019.jpg'), 'Party_ 2019.jpg.json');
  const idx2 = indexOf({ 'weird-name.json': 'Grandma\'s birthday?.jpg' });
  assert.equal(found(idx2, "Grandma's birthday_.jpg"), 'weird-name.json');
});

test('live photo videos borrow the still image sidecar', () => {
  const idx = indexOf({ 'IMG_1234.HEIC.json': 'IMG_1234.HEIC' });
  const hit = idx.find('IMG_1234.MP4');
  assert.equal(hit.entry.path, '/t/IMG_1234.HEIC.json');
  assert.equal(hit.method, 'partner');
});

test('unicode normalization differences (macOS NFD file names) still match', () => {
  const idx = indexOf({ ['Café.jpg.json'.normalize('NFC')]: 'Café.jpg' });
  assert.equal(found(idx, 'Café.jpg'.normalize('NFD')), 'Café.jpg.json'.normalize('NFC'));
});

test('classifyJson tells sidecars from album metadata and junk', () => {
  assert.equal(classifyJson(sidecar('x.jpg')), 'sidecar');
  assert.equal(classifyJson({ title: 'Trip', description: '', access: 'protected', date: { timestamp: '1' } }), 'album');
  assert.equal(classifyJson({ albumData: { title: 'Old style' } }), 'album');
  assert.equal(classifyJson([{ foo: 1 }]), null);
  assert.equal(classifyJson({ comments: [] }), null);
});

test('sidecarMeta ignores 0/0 locations and empty fields', () => {
  const meta = sidecarMeta({
    title: 'a.jpg', description: ' ', favorited: true,
    photoTakenTime: { timestamp: '1563005700' },
    geoData: { latitude: 0, longitude: 0 },
    geoDataExif: { latitude: 48.2, longitude: 16.37 },
    people: [{ name: 'Anna' }, {}],
  });
  assert.equal(meta.takenAt, 1563005700000);
  assert.deepEqual([meta.lat, meta.lon], [48.2, 16.37]);
  assert.equal(meta.description, null);
  assert.equal(meta.favorite, true);
  assert.deepEqual(meta.people, ['Anna']);
});

test('takeoutFolderKey is stable across zip parts', () => {
  assert.equal(
    takeoutFolderKey('/x/takeout-001/Takeout/Google Photos/Trip'),
    takeoutFolderKey('/x/takeout-002/Takeout/Google Photos/Trip'),
  );
  assert.equal(takeoutFolderKey('/Users/me/Pictures'), '/Users/me/Pictures');
});

test('a Pixel motion clip ("X.MP") shares its still\'s sidecar, without taking its name', () => {
  const idx = new SidecarIndex();
  idx.add('/t/PXL_20260504_163843948.MP.jpg.supplemental-metadata.json', sidecar('PXL_20260504_163843948.MP.jpg'));
  assert.deepEqual(
    { ...idx.find('PXL_20260504_163843948.MP'), entry: undefined },
    { entry: undefined, method: 'partner' },
  );
  assert.equal(idx.find('PXL_20260504_163843948.MP').entry.path, '/t/PXL_20260504_163843948.MP.jpg.supplemental-metadata.json');
  assert.equal(idx.find('PXL_20260504_163843948.MP.jpg').method, 'name');
});

test('album files with only a title (newer exports), in any export language; untitled albums take the folder name', () => {
  assert.equal(classifyJson({ title: 'Sailing 2024' }, 'metadata.json'), 'album');
  assert.equal(classifyJson({ title: 'Urlaub' }, 'Metadaten.json'), 'album');
  assert.equal(classifyJson({ title: 'Spotlight' }, 'metadata(1).json'), 'album');
  assert.equal(classifyJson({ title: 'Sailing 2024' }, 'notes.json'), null, 'any other JSON with a title is not an album');
  assert.equal(albumTitle({ title: 'Sailing 2024' }, 'Sailing 2024'), 'Sailing 2024');
  assert.equal(albumTitle({ title: '' }, 'Alex, Sam'), 'Alex, Sam');
});
