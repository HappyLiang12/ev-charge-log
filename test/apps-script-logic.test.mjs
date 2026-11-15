import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps-script/Logic.gs', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const call = (name, ...args) => context[name](...args);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('hkDateString_, hkTimeString_, and hkMonth_ use Hong Kong time', () => {
  assert.equal(call('hkDateString_', '2026-11-14T16:30:00.000Z'), '2026-11-15');
  assert.equal(call('hkTimeString_', '2026-11-14T16:30:00.000Z'), '00:30');
  assert.equal(call('hkMonth_', '2026-11-14T16:30:00.000Z'), '2026-11');
  assert.equal(call('validMonth_', '2026-11'), true);
  assert.equal(call('validMonth_', '2026-13'), false);
  assert.equal(call('validCarId_', 'model3'), true);
  assert.equal(call('validCarId_', 'Bad Car'), false);
});

test('splitPeakKwh_ splits at the 16:00 and 23:00 Hong Kong boundaries', () => {
  // 15:30 HK, one hour: 30 minutes off-peak, 30 minutes peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T07:30:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 3.6,
    offPeakKWh: 3.6,
  });
  // 16:00 HK, one hour: all peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T08:00:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 7.2,
    offPeakKWh: 0,
  });
  // 22:30 HK, one hour: 30 minutes peak, 30 minutes off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T14:30:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 3.6,
    offPeakKWh: 3.6,
  });
  // 23:00 HK, one hour: all off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T15:00:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 7.2,
  });
  // Crosses midnight from 23:30; still all off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T15:30:00.000Z', 7200, 14.4, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 14.4,
  });
  // Rounded split sums to the original energy.
  const rounded = plain(call('splitPeakKwh_', '2026-11-14T07:20:00.000Z', 2700, 5.4, '16:00', '23:00'));
  assert.equal(Number((rounded.peakKWh + rounded.offPeakKWh).toFixed(6)), 5.4);
});

test('splitPeakKwh_ falls back to all off-peak without duration or energy', () => {
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T05:00:00.000Z', 0, 0, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 0,
  });
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T05:00:00.000Z', 3600, 10, '', '')), {
    peakKWh: 0,
    offPeakKWh: 10,
  });
});

test('closestManualCandidate_ matches the nearest unlinked manual row within the window', () => {
  const rows = [
    {
      id: 'm1', car: 'model3', startAt: '2026-11-14T05:00:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm2', car: 'model3', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm3', car: 'model3', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: 1, teslaKey: null,
    },
    {
      id: 'm4', car: 'unassigned', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm5', car: 'model3', startAt: '2026-11-14T06:00:00.000Z', source: 'manual', kWh: null, teslaKey: 'din:x',
    },
  ];
  const match = call('closestManualCandidate_', '2026-11-14T05:12:00.000Z', rows, 30 * 60 * 1000);
  assert.equal(match.id, 'm2');
  assert.equal(call('closestManualCandidate_', '2026-11-14T06:30:00.000Z', rows, 30 * 60 * 1000), null);
  assert.equal(call('closestManualCandidate_', 'not-a-date', rows, 30 * 60 * 1000), null);
});

test('parseFuelAdjustmentPage_ extracts the current month and the yearly table', () => {
  const page = `
燃料調整費
2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
2026年11月1日起，燃料調整費為每度電47.4港仙。
`;
  const parsed = call('parseFuelAdjustmentPage_', page);
  assert.deepEqual(plain(parsed.current), { month: '2026-11', fuelAdjustment: 47.4 });
  assert.equal(parsed.rows.length, 11);
  assert.deepEqual(plain(parsed.rows[10]), { month: '2026-11', fuelAdjustment: 47.4 });
  assert.deepEqual(plain(call('parseFuelAdjustmentPage_', 'no rates here')), { current: null, rows: [] });
});

test('parseFuelAdjustmentPage_ accepts reader markdown bold and the live page order', () => {
  const page = `
2026年11月1日起，燃料調整費為**每度電47.4港仙**。
## 2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
備註:
* 由2026年8月至10月，合資格住宅客戶可享「燃料費特別回扣」每度電8港仙。
`;
  const parsed = call('parseFuelAdjustmentPage_', page);
  assert.deepEqual(plain(parsed.current), { month: '2026-11', fuelAdjustment: 47.4 });
  assert.equal(parsed.rows.length, 11);
  assert.deepEqual(plain(parsed.rows[10]), { month: '2026-11', fuelAdjustment: 47.4 });
});

test('parseFuelAdjustmentPage_ ignores numeric lines after the current sentence', () => {
  const page = `
燃料調整費
2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
2026年11月1日起，燃料調整費為每度電47.4港仙。
99.9
`;
  const parsed = call('parseFuelAdjustmentPage_', page);
  assert.deepEqual(plain(parsed.current), { month: '2026-11', fuelAdjustment: 47.4 });
  const november = plain(parsed.rows.filter((row) => row.month === '2026-11'));
  assert.equal(november.length, 1);
  assert.equal(november[0].fuelAdjustment, 47.4);
  assert.equal(parsed.rows.length, 11);
});

test('parseTariffPage_ extracts the basic charges and confirms the peak window', () => {
  const page = `
電動車住宅分時段用電價目
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
燃料調整費每月浮動。
`;
  assert.deepEqual(plain(call('parseTariffPage_', page)), {
    basicOffPeak: 94.5,
    basicPeak: 137.5,
    peakStart: '16:00',
    peakEnd: '23:00',
  });
  assert.equal(call('parseTariffPage_', 'no tariff here'), null);
});

test('parseTariffPage_ accepts reader markup without capturing the 17-hour note', () => {
  const page = `
<p><strong>非高峰用電時間</strong></p>
（每日晚上十一時至翌日下午四時，優惠時段長達17小時）
94.5
<p><strong>高峰用電時間</strong></p>
（每日下午四時至晚上十一時）
137.5
`;
  assert.deepEqual(plain(call('parseTariffPage_', page)), {
    basicOffPeak: 94.5,
    basicPeak: 137.5,
    peakStart: '16:00',
    peakEnd: '23:00',
  });
});

test('validateParsedRates_ rejects implausible or incomplete rates', () => {
  const fuel = {
    current: { month: '2026-11', fuelAdjustment: 47.4 },
    rows: [{ month: '2026-11', fuelAdjustment: 47.4 }],
  };
  const tariff = { basicOffPeak: 94.5, basicPeak: 137.5 };
  assert.equal(call('validateParsedRates_', fuel, tariff), true);
  assert.throws(() => call('validateParsedRates_', {
    current: { month: '2026-11', fuelAdjustment: 999 },
    rows: [{ month: '2026-11', fuelAdjustment: 999 }],
  }, tariff), /CLP/);
  assert.throws(() => call('validateParsedRates_', fuel, {
    basicOffPeak: 94.5,
    basicPeak: 80.5,
  }), /CLP/);
  assert.throws(() => call('validateParsedRates_', { current: null, rows: [] }, tariff), /CLP/);
});
