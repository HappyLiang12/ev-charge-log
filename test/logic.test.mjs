import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidRecord,
  normalizeRecords,
  parseServerRecords,
  formatLocalDate,
  formatLocalTime,
  formatWeekday,
  monthKey,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  csvEscape,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
} from '../app.js';

const atLocal = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const rec = (id, iso) => ({ id, startAt: iso });

test('formatLocalDate, formatLocalTime, formatWeekday use local calendar values', () => {
  const iso = atLocal(2026, 11, 14, 21, 5);
  assert.equal(formatLocalDate(iso), '2026-11-14');
  assert.equal(formatLocalTime(iso), '21:05');
  assert.equal(formatWeekday(iso), '週六');
});

test('isValidRecord accepts UUID-like ids and ISO dates only', () => {
  assert.equal(isValidRecord({ id: 'abc-123', startAt: atLocal(2026, 11, 14, 9, 0) }), true);
  assert.equal(isValidRecord({ id: 'bad id', startAt: atLocal(2026, 11, 14, 9, 0) }), false);
  assert.equal(isValidRecord({ id: 'abc', startAt: 'nope' }), false);
  assert.equal(isValidRecord(null), false);
});

test('normalizeRecords drops malformed entries and copies fields', () => {
  const good = rec('abc-123', atLocal(2026, 11, 14, 9, 0));
  const normalized = normalizeRecords([
    good,
    { id: 'bad id', startAt: good.startAt },
    { id: 'x', startAt: 'nope' },
    null,
  ]);
  assert.deepEqual(normalized, [good]);
});

test('parseServerRecords validates the envelope and entries', () => {
  const good = rec('abc-123', atLocal(2026, 11, 14, 9, 0));
  assert.deepEqual(
    parseServerRecords({ ok: true, records: [good, { id: 'x', startAt: 'nope' }] }),
    [good],
  );
  assert.throws(() => parseServerRecords({ ok: false }), /Invalid API response/);
  assert.throws(() => parseServerRecords(null), /Invalid API response/);
});

test('monthKey and filterByMonth use the local month', () => {
  const nov = rec('a', atLocal(2026, 11, 30, 23, 59));
  const dec = rec('b', atLocal(2026, 12, 1, 0, 0));
  assert.equal(monthKey(nov.startAt), '2026-11');
  assert.equal(monthKey(dec.startAt), '2026-12');
  assert.deepEqual(filterByMonth([nov, dec], '2026-11').map((r) => r.id), ['a']);
  assert.equal(filterByMonth([nov, dec], 'all').length, 2);
});

test('mergeRecords unions by id and sorts newest first', () => {
  const older = rec('a', atLocal(2026, 11, 1, 8, 0));
  const newer = rec('b', atLocal(2026, 11, 2, 8, 0));
  const merged = mergeRecords([older], [newer, older]);
  assert.deepEqual(merged.map((r) => r.id), ['b', 'a']);
});

test('monthsWithRecords and defaultMonth prefer current then newest', () => {
  const nov = rec('a', atLocal(2026, 11, 5, 9, 0));
  const oct = rec('b', atLocal(2026, 10, 5, 9, 0));
  assert.deepEqual(monthsWithRecords([oct, nov]), ['2026-11', '2026-10']);
  assert.equal(defaultMonth([nov, oct], new Date(2026, 10, 14)), '2026-11');
  assert.equal(defaultMonth([oct], new Date(2026, 10, 14)), '2026-10');
  assert.equal(defaultMonth([], new Date(2026, 10, 14)), 'all');
});

test('toCsv emits BOM, CRLF, header, and chronological rows', () => {
  const later = rec('b', atLocal(2026, 11, 14, 21, 30));
  const earlier = rec('a', atLocal(2026, 11, 14, 9, 5));
  const csv = toCsv([later, earlier]);
  assert.equal(csv, '\uFEFF日期,時間\r\n2026-11-14,09:05\r\n2026-11-14,21:30\r\n');
});

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
});

test('isRecentDuplicate only matches the last 2 seconds', () => {
  const iso = atLocal(2026, 11, 14, 21, 0);
  const t = Date.parse(iso);
  assert.equal(isRecentDuplicate(iso, t + 1500), true);
  assert.equal(isRecentDuplicate(iso, t + 2000), false);
  assert.equal(isRecentDuplicate(null, t), false);
});

test('dropSyncedPending removes ids already present on the server', () => {
  const a = rec('a', atLocal(2026, 11, 1, 1, 0));
  const b = rec('b', atLocal(2026, 11, 2, 1, 0));
  assert.deepEqual(dropSyncedPending([a, b], [a]).map((r) => r.id), ['b']);
});
