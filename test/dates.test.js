import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateFromFilename, parseTimestamp, formatLocal } from '../src/dates.js';

test('dates that do not exist are rejected, real ones kept', () => {
  assert.equal(dateFromFilename('IMG_20190231_101010.jpg'), null, '31 February');
  assert.equal(dateFromFilename('IMG_20190229_101010.jpg'), null, 'no leap day in 2019');
  assert.equal(dateFromFilename('IMG_20200229_101010.jpg'), '2020-02-29 10:10:10');
  assert.equal(dateFromFilename('PXL_20230115_123456789.jpg'), '2023-01-15 12:34:56');
  assert.equal(parseTimestamp('2019:04:31 10:00:00'), null, '31 April');
  assert.deepEqual(parseTimestamp('2019:07:13 10:15:00', '+02:00'), { local: '2019-07-13 10:15:00', instant: Date.parse('2019-07-13T08:15:00Z') });
  assert.deepEqual(parseTimestamp('2019-07-13T08:15:00Z'), { local: null, instant: Date.parse('2019-07-13T08:15:00Z') });
});

test('formatLocal gives the wall clock in a zone, or in this machine\'s zone', () => {
  const ms = Date.parse('2023-04-01T00:30:00Z');
  assert.equal(formatLocal(ms, 'Asia/Tokyo'), '2023-04-01 09:30:00');
  assert.equal(formatLocal(ms, 'UTC'), '2023-04-01 00:30:00');
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  assert.equal(formatLocal(ms), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
});
