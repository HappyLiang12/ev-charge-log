import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RATES_KEY,
  storageKeys,
  formatHkDate,
  formatHkTime,
  formatHkWeekday,
  monthKey,
  isValidRecord,
  normalizeRecord,
  normalizeRecords,
  normalizeRates,
  sourceUrls,
  normalizeCars,
  parseServerRecords,
  parseFamilyPayload,
  parseOwnerPayload,
  mergeRecords,
  groupUnassignedByDay,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  selectRate,
  computeCost,
  summarizeRecords,
  csvEscape,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
  readStored,
  writeStored,
  migrateLegacyPending,
} from '../logic.js';

const iso = (value) => new Date(value).toISOString();
const base = '2026-11-14T05:00:00.000Z'; // 13:00 in Hong Kong
const rate = {
  month: '2026-11',
  basicOffPeak: 94.5,
  basicPeak: 137.5,
  fuelAdjustment: 47.4,
  rebate: 0,
  peakStart: '16:00',
  peakEnd: '23:00',
  sourceUrl: 'https://www.clp.com.hk/',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  manualOverride: false,
};
const record = (overrides = {}) => ({
  id: 'rec-1',
  car: 'model3',
  startAt: base,
  date: '2026-11-14',
  time: '13:00',
  kWh: 20,
  durationSec: 7200,
  teslaStartAt: base,
  teslaEndAt: '2026-11-14T07:00:00.000Z',
  peakKWh: 10,
  offPeakKWh: 10,
  teslaKey: 'din:1786968749',
  source: 'tesla+manual',
  ...overrides,
});

test('Hong Kong formatting and month keys ignore the device timezone', () => {
  assert.equal(formatHkDate('2026-11-14T13:05:00.000Z'), '2026-11-14');
  assert.equal(formatHkTime('2026-11-14T13:05:00.000Z'), '21:05');
  assert.equal(formatHkWeekday('2026-11-14T13:05:00.000Z'), '週六');
  assert.equal(formatHkDate('2026-11-14T16:30:00.000Z'), '2026-11-15');
  assert.equal(formatHkTime('2026-11-14T16:30:00.000Z'), '00:30');
  assert.equal(formatHkWeekday('2026-11-14T16:30:00.000Z'), '週日');
  assert.equal(monthKey('2026-11-14T16:30:00.000Z'), '2026-11');
});

test('storageKeys are per car and the rates key is shared', () => {
  assert.deepEqual(storageKeys('model3'), {
    cache: 'ev-charge-log.cache.v2.model3',
    pending: 'ev-charge-log.pending.v2.model3',
  });
  assert.equal(RATES_KEY, 'ev-charge-log.rates.v1');
});

test('normalizeRecord preserves the full billing record and marks old rows legacy', () => {
  const normalized = normalizeRecord(record());
  assert.deepEqual(normalized, record());

  const old = normalizeRecord({ id: 'old-1', startAt: base });
  assert.equal(old.car, '');
  assert.equal(old.source, 'legacy');
  assert.equal(old.date, '2026-11-14');
  assert.equal(old.time, '13:00');
  assert.equal(old.kWh, null);
  assert.equal(old.teslaKey, null);

  assert.equal(normalizeRecord({ ...record(), car: 'Bad Car' }), null);
  assert.equal(normalizeRecord({ id: 'bad id', startAt: base }), null);
  assert.equal(normalizeRecord({ id: 'x', startAt: 'nope' }), null);
});

test('normalizeRecords drops malformed entries', () => {
  assert.deepEqual(normalizeRecords([record(), { id: 'bad id', startAt: base }, null]), [record()]);
});

test('normalizeRates and normalizeCars validate server rows', () => {
  assert.deepEqual(normalizeRates([{ ...rate, manualOverride: 'TRUE' }]), [{ ...rate, manualOverride: true }]);
  assert.deepEqual(normalizeRates([{ ...rate, basicPeak: null }]), []);
  assert.deepEqual(normalizeCars([{ id: 'model3', name: 'Model 3', active: 'FALSE' }]), [
    { id: 'model3', name: 'Model 3', active: false },
  ]);
  const fallback = normalizeRates([{ ...rate, peakStart: 'bad', peakEnd: '25:00' }]);
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].peakStart, '16:00');
  assert.equal(fallback[0].peakEnd, '23:00');
});

test('parse payloads validate the family and owner envelopes', () => {
  const unassigned = record({ id: 'u1', car: 'unassigned', source: 'tesla' });
  const family = parseFamilyPayload({
    ok: true,
    car: { id: 'model3', name: 'Model 3', active: true },
    records: [record()],
    unassigned: [unassigned],
    rates: [rate],
  });
  assert.equal(family.car.name, 'Model 3');
  assert.deepEqual(family.records, [record()]);
  assert.deepEqual(family.unassigned, [unassigned]);
  assert.deepEqual(family.rates, [rate]);
  assert.deepEqual(parseFamilyPayload({
    ok: true,
    car: { id: 'model3', name: 'Model 3', active: true },
    records: [],
  }).unassigned, []);

  const owner = parseOwnerPayload({
    ok: true,
    cars: [{ id: 'model3', name: 'Model 3', active: true }],
    records: [record()],
    rates: [rate],
    sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
  });
  assert.equal(owner.cars.length, 1);
  assert.equal(owner.sheetUrl, 'https://docs.google.com/spreadsheets/d/abc/edit');
  assert.deepEqual(owner.records, [record()]);
  assert.throws(() => parseServerRecords({ ok: false }), /Invalid API response/);
  assert.throws(() => parseFamilyPayload({ ok: true, car: null, records: [] }), /Invalid car payload/);
});

test('sourceUrls splits valid URLs and drops duplicates', () => {
  assert.deepEqual(sourceUrls('https://a.example/x, https://b.example/y ,not-a-url,https://a.example/x'), [
    'https://a.example/x',
    'https://b.example/y',
  ]);
  assert.deepEqual(sourceUrls(''), []);
});

test('groupUnassignedByDay keeps the last 24 hours open and groups older rows by HK day', () => {
  const now = Date.parse('2026-11-15T10:00:00.000Z');
  const grouped = groupUnassignedByDay([
    record({ id: 'old-a', startAt: '2026-11-13T09:00:00.000Z' }),
    record({ id: 'recent', startAt: '2026-11-15T09:00:00.000Z' }),
    record({ id: 'old-b', startAt: '2026-11-12T09:00:00.000Z' }),
    record({ id: 'old-c', startAt: '2026-11-13T08:00:00.000Z' }),
  ], now);
  assert.deepEqual(grouped.recent.map((row) => row.id), ['recent']);
  assert.deepEqual(grouped.days.map((day) => day.day), ['2026-11-13', '2026-11-12']);
  assert.deepEqual(grouped.days[0].records.map((row) => row.id), ['old-a', 'old-c']);
});

test('merge, month filtering, and default month use startAt', () => {
  const older = record({ id: 'a', startAt: '2026-10-31T16:00:00.000Z' }); // 2026-11-01 00:00 HK
  const newer = record({ id: 'b', startAt: '2026-11-02T00:00:00.000Z' });
  const merged = mergeRecords([older], [newer, older]);
  assert.deepEqual(merged.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(monthsWithRecords([older, newer]), ['2026-11']);
  assert.equal(filterByMonth([older, newer], '2026-11').length, 2);
  assert.equal(filterByMonth([older, newer], 'all').length, 2);
  assert.equal(defaultMonth([older, newer], new Date('2026-11-14T00:00:00.000Z')), '2026-11');
  assert.equal(defaultMonth([older], new Date('2026-12-14T00:00:00.000Z')), '2026-11');
  assert.equal(defaultMonth([], new Date('2026-12-14T00:00:00.000Z')), 'all');
});

test('selectRate prefers the exact month then the latest earlier month', () => {
  const october = { ...rate, month: '2026-10', fuelAdjustment: 46.2 };
  assert.deepEqual(selectRate('2026-11', [october, rate]), { rate, fallback: false });
  assert.deepEqual(selectRate('2026-12', [october, rate]), { rate, fallback: true });
  assert.deepEqual(selectRate('2026-09', [october, rate]), { rate: null, fallback: false });
});

test('computeCost applies peak, off-peak, and rebate', () => {
  assert.equal(computeCost(record(), rate), 32.68);
  assert.equal(computeCost(record(), { ...rate, rebate: 5 }), 31.68);
  assert.equal(computeCost(record({ peakKWh: null }), rate), null);
});

test('summarizeRecords totals kWh, split, cost, and missing-rate state', () => {
  assert.deepEqual(summarizeRecords([record()], [rate], '2026-11'), {
    count: 1,
    matched: 1,
    pending: 0,
    kWh: 20,
    peakKWh: 10,
    offPeakKWh: 10,
    cost: 32.68,
    missingRate: 0,
    fallback: false,
  });
  assert.deepEqual(summarizeRecords([record({ kWh: null })], [rate], '2026-11'), {
    count: 1,
    matched: 0,
    pending: 1,
    kWh: 0,
    peakKWh: 0,
    offPeakKWh: 0,
    cost: null,
    missingRate: 0,
    fallback: false,
  });
  assert.equal(summarizeRecords([record()], [], '2026-11').cost, null);
  assert.equal(summarizeRecords([record()], [], '2026-11').missingRate, 1);
});

test('toCsv emits the billing header, Hong Kong time, split, cost, and source', () => {
  const csv = toCsv([record()], { carNames: { model3: 'Model 3' }, rates: [rate] });
  assert.equal(
    csv,
    '\uFEFF日期,時間,車,kWh,非高峰 kWh,高峰 kWh,估算電費 (HKD),來源\r\n'
    + '2026-11-14,13:00,Model 3,20.00,10.00,10.00,32.68,tesla+manual\r\n',
  );
});

test('csvEscape quotes commas, quotes, and newlines and neutralizes formulas', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('+1'), "'+1");
  assert.equal(csvEscape('-1'), "'-1");
  assert.equal(csvEscape('@cmd'), "'@cmd");
});

test('migrateLegacyPending copies v1 pending records to the car manual queue', () => {
  const migrated = migrateLegacyPending([{ id: 'old-1', startAt: base }], 'model3');
  assert.deepEqual(migrated, [record({
    id: 'old-1',
    car: 'model3',
    source: 'manual',
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
  })]);
  assert.deepEqual(migrateLegacyPending(null, 'model3'), []);
  assert.deepEqual(migrateLegacyPending([{ id: 'bad id', startAt: base }], 'model3'), []);
});

test('isRecentDuplicate and dropSyncedPending keep their existing behavior', () => {
  const at = Date.parse(base);
  assert.equal(isRecentDuplicate(base, at + 1500), true);
  assert.equal(isRecentDuplicate(base, at + 2000), false);
  assert.equal(isRecentDuplicate(null, at), false);
  const a = record({ id: 'a' });
  const b = record({ id: 'b' });
  assert.deepEqual(dropSyncedPending([a, b], [a]).map((r) => r.id), ['b']);
});

test('readStored and writeStored handle storage failures and corruption', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  assert.deepEqual(readStored(storage, 'missing'), { value: null, corrupt: false });
  storage.setItem('bad', '{oops');
  assert.deepEqual(readStored(storage, 'bad'), { value: null, corrupt: true });
  assert.equal(writeStored(storage, 'good', [1, 2]), true);
  assert.deepEqual(readStored(storage, 'good'), { value: [1, 2], corrupt: false });
  assert.equal(writeStored({ setItem() { throw new Error('quota'); } }, 'x', 1), false);
  assert.equal(writeStored(null, 'x', 1), false);
});

test('isValidRecord accepts the new record shape and old records', () => {
  assert.equal(isValidRecord(record()), true);
  assert.equal(isValidRecord({ id: 'old', startAt: base }), true);
  assert.equal(isValidRecord({ id: 'bad id', startAt: base }), false);
});
