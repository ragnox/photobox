// Versions of one shot: which files count as the same photo, and which version is shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shotKey, distance, findVersions, pairKey, MAX_DISTANCE } from '../src/versions.js';

const photo = { kind: 'image', file: '/p/PXL_20240307_131544109.jpg', shot: '2024:03:07 14:15:44.109', camera: 'Pixel 5', width: 4032, height: 2268 };

test('a shot key needs the capture time and the camera; edited copies get their own', () => {
  assert.equal(shotKey(photo), 'i|2024:03:07 14:15:44.109|Pixel 5|1.78|');
  assert.equal(shotKey({ ...photo, file: '/takeout/PXL_20240307_131544109.jpg' }), shotKey(photo), 'the folder does not matter');
  assert.equal(shotKey({ ...photo, camera: null }), '', 'a screenshot or a download says too little');
  assert.equal(shotKey({ ...photo, shot: null }), '');
  assert.notEqual(shotKey({ ...photo, file: '/p/PXL_20240307_131544109-bearbeitet.jpg' }), shotKey(photo));
  assert.notEqual(shotKey({ ...photo, width: 2268, height: 2268 }), shotKey(photo), 'a crop has another shape');
  assert.equal(shotKey({ kind: 'video', file: '/p/VID.mp4', width: 1920, height: 1080, recordedAt: Date.UTC(2024, 2, 7, 13, 15, 44, 900) }),
    `v|${Date.UTC(2024, 2, 7, 13, 15, 44) / 1000}|1.78|`);
  assert.equal(shotKey({ kind: 'video', file: '/p/VID.mp4', recordedAt: null }), '');
});

test('each rendering of a capture has its own key; a motion photo and its plain still share one', () => {
  const at = (name) => shotKey({ ...photo, file: `/p/${name}` });
  assert.notEqual(at('PXL_1.PORTRAIT-01.COVER.jpg'), at('PXL_1.PORTRAIT-02.ORIGINAL.jpg'));
  assert.equal(at('PXL_1.PORTRAIT-02.ORIGINAL.jpg'), at('PXL_1.PORTRAIT-02.ORIGIN.jpg'), 'Takeout cuts long names');
  assert.notEqual(at('PXL_1.ACTION_PAN-01.jpg'), at('PXL_1.ACTION_PAN-02.ORIGINAL.jpg'));
  assert.notEqual(at('IMG_1~2.jpg'), at('IMG_1.jpg'), "the phone's edited copy");
  assert.equal(at('PXL_1.MP.jpg'), at('PXL_1.jpg'));
});

test('distance counts differing bits', () => {
  assert.equal(distance('ffffffffffffffff', 'ffffffffffffffff'), 0);
  assert.equal(distance('ffffffffffffffff', 'fffffffffffffffe'), 1);
  assert.equal(distance('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(distance('', 'ffffffffffffffff'), null, 'no thumbnail, no comparison');
});

const item = (id, sources, extra = {}) => ({ id, shotKey: 'k', dhash: 'f0f0f0f0f0f0f0f0', sources, bytes: 1000, duration: null, sha256: `sha${id}`, ...extra });

test('the biggest version is shown, the others are superseded by it', () => {
  const versions = findVersions([item(1, [1], { bytes: 300 }), item(2, [2], { bytes: 1500 }), item(3, [3], { bytes: 900 })]);
  assert.deepEqual([...versions].sort(), [[1, 2], [3, 2]]);
});

test('a phone backup original is shown even when a bigger version exists, and two originals never merge', () => {
  assert.deepEqual([...findVersions([item(1, [1], { original: true, bytes: 300 }), item(2, [2], { bytes: 1500 })])], [[2, 1]]);
  assert.equal(findVersions([item(1, [1], { original: true }), item(2, [2], { original: true })]).size, 0);
});

test('two files of one source are one shot only if the camera kept sub-seconds and they look the same', () => {
  // A Takeout's album copy next to its year-folder copy.
  const precise = 'i|2024:03:07 14:15:44.109|Pixel 5|1.78|';
  assert.deepEqual([...findVersions([item(1, [1], { shotKey: precise, bytes: 300 }), item(2, [1], { shotKey: precise })])], [[1, 2]]);
  assert.equal(findVersions([item(1, [1], { shotKey: precise }), item(2, [1], { shotKey: precise, dhash: 'f0f0f0f0f0f0f0ff' })]).size, 0);
  // Without sub-seconds, two of a burst in one second.
  const coarse = 'i|2009:03:07 14:15:44|Canon EOS 450D|1.50|';
  assert.equal(findVersions([item(1, [1], { shotKey: coarse }), item(2, [1], { shotKey: coarse })]).size, 0);
});

test('files from one source with the same key are different shots, not versions', () => {
  assert.equal(findVersions([item(1, [1]), item(2, [1])]).size, 0);
  // Two near-identical burst frames in each account: each pairs with its look-alike in the other account.
  const near = 'f0f0f0f0f0f0f0f1';
  const versions = findVersions([
    item(1, [1], { dhash: 'f0f0f0f0f0f0f0f0', bytes: 100 }), item(2, [1], { dhash: near, bytes: 100 }),
    item(3, [2], { dhash: 'f0f0f0f0f0f0f0f0', bytes: 200 }), item(4, [2], { dhash: near, bytes: 200 }),
  ]);
  assert.deepEqual([...versions].sort(), [[1, 3], [2, 4]]);
});

test('pictures that look different, videos of another length and pairs kept apart are not versions', () => {
  assert.equal(findVersions([item(1, [1]), item(2, [2], { dhash: '0f0f0f0f0f0f0f0f' })]).size, 0);
  const far = (0xf0f0f0f0 ^ ((1 << (MAX_DISTANCE + 1)) - 1)).toString(16).padStart(8, '0') + 'f0f0f0f0';
  assert.equal(distance('f0f0f0f0f0f0f0f0', far), MAX_DISTANCE + 1);
  assert.equal(findVersions([item(1, [1]), item(2, [2], { dhash: far })]).size, 0);
  assert.equal(findVersions([item(1, [1], { duration: 10 }), item(2, [2], { duration: 12 })]).size, 0);
  assert.equal(findVersions([item(1, [1], { duration: 10 }), item(2, [2], { duration: 10.2 })]).size, 1);
  assert.equal(findVersions([item(1, [1]), item(2, [2])], new Set([pairKey('sha2', 'sha1')])).size, 0);
  assert.equal(findVersions([item(1, [1], { dhash: '' }), item(2, [2])]).size, 0, 'no thumbnail hash, no match');
});
