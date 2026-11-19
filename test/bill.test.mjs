import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBillLines,
  groupPdfTextItems,
  defaultCutoff,
  inferCutoff,
  allocateBill,
  normalizeBillRows,
  normalizeBillShares,
} from '../bill.js';

const billLines = [
  'Ms. WONG WING KWAN',
  'FLOOR G',
  'NO. 157',
  '電動車住宅分時段用電',
  '由 03-10-26 至 04-11-26',
  '05-11-26',
  '電力費用',
  'Energy Charge',
  '$870.39',
  '燃料調整費',
  'Fuel Cost Adjustment',
  '$410.32',
  '其他',
  'Others',
  '-$0.71',
  '應繳總數',
  '$1,280.00',
  '高峯時段 @137.5 77 105.88',
  '非高峯時段 @94.5 809 764.51',
  '小計 886 $870.39',
  '繳款期限',
  '20-11-26',
  '上次繳費$1,285.00',
  '已於05-10-26收到',
  '燃料調整費 由 03-10-26 至 31-10-26 29 804 0.462 371.45',
  '由 01-11-26 至 04-11-26 4 82 0.474 38.87',
];

test('parseBillLines extracts period, totals and split from CLP bill text', () => {
  const bill = parseBillLines(billLines);
  assert.equal(bill.periodStart, '2026-10-03');
  assert.equal(bill.periodEnd, '2026-11-04');
  assert.equal(bill.units, 886);
  assert.equal(bill.peakKWh, 77);
  assert.equal(bill.offPeakKWh, 809);
  assert.equal(bill.energyCharge, 870.39);
  assert.equal(bill.fuelCharge, 410.32);
  assert.equal(bill.others, -0.71);
  assert.equal(bill.total, 1280);
  assert.deepEqual(bill.tail, { start: '2026-11-01', end: '2026-11-04', units: 82, amount: 38.87 });
});

test('parseBillLines rejects text without a bill period', () => {
  assert.throws(() => parseBillLines(['hello', 'world']), /帳單期/);
  assert.throws(() => parseBillLines(['由 03-10-26 至 04-11-26']), /度數/);
  assert.throws(() => parseBillLines([
    '由 03-10-26 至 04-11-26',
    '高峯時段 @137.5 77 105.88',
    '非高峯時段 @94.5 809 764.51',
  ]), /應繳總數/);
});

test('groupPdfTextItems rebuilds lines without spaces inside CJK labels', () => {
  const items = [
    { str: '高', transform: [10, 0, 0, 10, 10, 500], width: 10 },
    { str: '峯', transform: [10, 0, 0, 10, 20, 500], width: 10 },
    { str: '時', transform: [10, 0, 0, 10, 30, 500], width: 10 },
    { str: '段', transform: [10, 0, 0, 10, 40, 500], width: 10 },
    { str: '@137.5', transform: [10, 0, 0, 10, 88, 500], width: 40 },
    { str: '77', transform: [10, 0, 0, 10, 160, 500], width: 14 },
    { str: '105.88', transform: [10, 0, 0, 10, 200, 500], width: 36 },
    { str: 'NOISE', transform: [10, 0, 0, 10, 10, 480], width: 40 },
  ];
  assert.deepEqual(groupPdfTextItems(items), ['高峯時段 @137.5 77 105.88', 'NOISE']);
});

test('defaultCutoff covers the full last billing day in Hong Kong time', () => {
  assert.equal(defaultCutoff('2026-11-04'), '2026-11-04T16:00:00.000Z');
});

test('inferCutoff matches the bill tail usage and excludes the late session', () => {
  const records = [
    { startAt: '2026-11-02T01:10:27.000Z', kWh: 17.337, car: 'ix3' },
    { startAt: '2026-11-02T12:39:53.000Z', kWh: 12.503, car: 'ix3' },
    { startAt: '2026-11-02T14:35:22.000Z', kWh: 34.002, car: 'ix3' },
    { startAt: '2026-11-04T01:12:38.000Z', kWh: 12.776, car: 'ix3' },
    { startAt: '2026-11-04T14:59:27.000Z', kWh: 61.26, car: 'ix3' },
  ];
  const bill = parseBillLines(billLines);
  const inferred = inferCutoff(records, bill);
  assert.equal(inferred.source, 'bill');
  assert.equal(inferred.cutoff, '2026-11-04T14:59:27.000Z');
});

test('inferCutoff falls back to the full day when no tail segment exists', () => {
  const bill = { periodStart: '2026-10-03', periodEnd: '2026-11-04', tail: null };
  const inferred = inferCutoff([], bill);
  assert.equal(inferred.source, 'default');
  assert.equal(inferred.cutoff, '2026-11-04T16:00:00.000Z');
});

test('allocateBill splits the bill total by logged kWh share', () => {
  const records = [
    { startAt: '2026-10-10T10:00:00.000Z', car: 'ix3', kWh: 600, peakKWh: 100, offPeakKWh: 500 },
    { startAt: '2026-10-20T10:00:00.000Z', car: 'model3', kWh: 200, peakKWh: 50, offPeakKWh: 150 },
    { startAt: '2026-10-02T10:00:00.000Z', car: 'ix3', kWh: 999, peakKWh: 0, offPeakKWh: 999 },
    { startAt: '2026-11-04T15:00:00.000Z', car: 'ix3', kWh: 999, peakKWh: 0, offPeakKWh: 999 },
  ];
  const bill = {
    periodStart: '2026-10-03',
    periodEnd: '2026-11-04',
    cutoff: '2026-11-04T12:00:00.000Z',
    units: 820,
    total: 800,
  };
  const cars = [{ id: 'ix3', name: 'iX3' }, { id: 'model3', name: 'Model 3' }];
  const result = allocateBill(records, bill, cars, []);
  assert.equal(result.loggedKWh, 800);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map((row) => [row.id, row.name, row.kWh, Math.round(row.amount * 100) / 100, Math.round(row.share * 1000) / 1000]),
    [['ix3', 'iX3', 600, 600, 0.75], ['model3', 'Model 3', 200, 200, 0.25]],
  );
  assert.equal(Math.round(result.driftUnitsPct * 100) / 100, -2.44);
});

test('normalizeBillRows sorts newest first and drops invalid rows', () => {
  const rows = normalizeBillRows([
    { periodStart: '2026-09-03', periodEnd: '2026-10-02', units: 900, total: 1300 },
    { periodStart: '2026-10-03', periodEnd: '2026-11-04', units: 886, total: 1280, peakKWh: '77', offPeakKWh: '' },
    { periodStart: 'bad', periodEnd: '2026-11-04', units: 1, total: 1 },
    { periodStart: '2026-10-03', periodEnd: '2026-11-04', units: 0, total: 1280 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].periodEnd, '2026-11-04');
  assert.equal(rows[0].peakKWh, 77);
  assert.equal(rows[0].offPeakKWh, null);
  assert.equal(rows[1].periodEnd, '2026-10-02');
});

test('allocateBill reports unassigned sessions inside the cutoff', () => {
  const records = [
    { startAt: '2026-10-10T10:00:00.000Z', car: 'ix3', kWh: 100, peakKWh: 0, offPeakKWh: 100 },
    { startAt: '2026-10-11T10:00:00.000Z', car: 'unassigned', kWh: 30, peakKWh: 30, offPeakKWh: 0 },
    { startAt: '2026-10-12T10:00:00.000Z', car: 'unassigned', kWh: null },
    { startAt: '2026-11-04T15:00:00.000Z', car: 'unassigned', kWh: 40, peakKWh: 40, offPeakKWh: 0 },
  ];
  const bill = {
    periodStart: '2026-10-03',
    periodEnd: '2026-11-04',
    cutoff: '2026-11-04T14:59:00.000Z',
    units: 900,
    total: 1200,
  };
  const result = allocateBill(records, bill, [], []);
  assert.equal(result.loggedKWh, 100);
  assert.equal(result.unassignedCount, 2);
  assert.equal(result.unassignedKWh, 30);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].amount, 1200);
});

test('normalizeBillRows keeps publishedAt and defaults it to empty', () => {
  const rows = normalizeBillRows([
    {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      units: 886,
      total: 1280,
      publishedAt: '2026-11-19T15:40:00.000Z',
    },
    { periodStart: '2026-09-03', periodEnd: '2026-10-02', units: 900, total: 1300 },
  ]);
  assert.equal(rows[0].publishedAt, '2026-11-19T15:40:00.000Z');
  assert.equal(rows[1].publishedAt, '');
});

test('normalizeBillShares keeps valid published shares newest first', () => {
  const shares = normalizeBillShares([
    {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      cutoff: '2026-11-04T14:59:00.000Z',
      units: 886,
      total: 1280,
      loggedKWh: 856,
      myKWh: 684.675,
      myShare: 0.8,
      myAmount: 1023.87,
      publishedAt: '2026-11-19T15:40:00.000Z',
    },
    { periodStart: 'bad', periodEnd: '2026-11-04', units: 1, total: 1 },
    {
      periodStart: '2026-09-03',
      periodEnd: '2026-10-02',
      units: 900,
      total: 1300,
      loggedKWh: 0,
      myKWh: 0,
      myShare: 0,
      myAmount: 0,
    },
  ]);
  assert.equal(shares.length, 2);
  assert.equal(shares[0].periodEnd, '2026-11-04');
  assert.equal(shares[0].myShare, 0.8);
  assert.equal(shares[0].myAmount, 1023.87);
  assert.equal(shares[0].publishedAt, '2026-11-19T15:40:00.000Z');
  assert.equal(shares[1].periodEnd, '2026-10-02');
});

test('parseBillLines ignores an energy amount printed after the total label', () => {
  const lines = [
    '由 03-10-26 至 04-11-26',
    '電動車住宅分時段用電',
    '應繳總數',
    '電力費用 $870.39',
    '$1,280.00',
    '燃料調整費 $410.32',
    '其他 -$0.71',
    '高峯時段 @137.5 77 105.88',
    '非高峯時段 @94.5 809 764.51',
    '小計 886 $870.39',
  ];
  const bill = parseBillLines(lines);
  assert.equal(bill.total, 1280);
  assert.equal(bill.totalSource, 'parsed');
});

test('parseBillLines derives the total from components when the total amount is missing', () => {
  const lines = [
    '由 03-10-26 至 04-11-26',
    '電力費用 $870.39',
    '燃料調整費 $410.32',
    '其他 -$0.71',
    '高峯時段 @137.5 77 105.88',
    '非高峯時段 @94.5 809 764.51',
  ];
  const bill = parseBillLines(lines);
  assert.equal(bill.total, 1280);
  assert.equal(bill.totalSource, 'derived');
});

test('parseBillLines reads sub-period usage printed on the following line', () => {
  const lines = [
    '由 03-10-26 至 04-11-26',
    '應繳總數 $1,280.00',
    '高峯時段 @137.5 77 105.88',
    '非高峯時段 @94.5 809 764.51',
    '燃料調整費',
    '由 03-10-26 至 31-10-26',
    '29 804 0.462 371.45',
    '由 01-11-26 至 04-11-26',
    '4 82 0.474 38.87',
  ];
  const bill = parseBillLines(lines);
  assert.deepEqual(bill.tail, { start: '2026-11-01', end: '2026-11-04', units: 82, amount: 38.87 });
});

test('parseBillLines handles the real CLP stream order and split-cell date rows', () => {
  const lines = [
    '電動車住宅分時段用電',
    '發單日期(日-月-年) 由 03-10-26 至 04-11-26',
    '05-11-26 共 33 日用電量 按金$2,000.00 第1/2頁',
    '應繳總數',
    '$870.39 $410.32 -$0.71',
    '$1,280.00',
    '電力費用: 其他:',
    '用電級別 每度(￠) 度數 費用($) 上期零數撥來 $0.03',
    '高峰時段 @137.5 77 105.88 零數撥入下次 -0.74',
    '非高峰時段 @94.5 809 764.51',
    '小計 -$0.71',
    '小計 886 $870.39 20-11-26',
    '燃料調整費:',
    '小計(886度) $410.32',
    '上次繳費$1,285.00',
    '編賬號碼: 82880-28505-5 應繳總數: $1,280.00 環保訊息:',
    '燃料調整費 03-10-26 31-10-26 29 804 0.462 371.45',
    '01-11-26 04-11-26 4 82 0.474 38.87',
    '886 410.32',
  ];
  const bill = parseBillLines(lines);
  assert.equal(bill.energyCharge, 870.39);
  assert.equal(bill.fuelCharge, 410.32);
  assert.equal(bill.others, -0.71);
  assert.equal(bill.total, 1280);
  assert.deepEqual(bill.tail, { start: '2026-11-01', end: '2026-11-04', units: 82, amount: 38.87 });
});
