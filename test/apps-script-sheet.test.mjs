import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const logicSource = readFileSync(new URL('../apps-script/Logic.gs', import.meta.url), 'utf8');
const repoSource = readFileSync(new URL('../apps-script/SheetRepo.gs', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeSheet(initial) {
  const data = (initial || []).map((row) => [...row]);
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({ getValues: () => data.map((row) => [...row]) }),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r += 1) {
            const line = [];
            for (let c = 0; c < numCols; c += 1) {
              const source = data[row - 1 + r] || [];
              line.push(source[col - 1 + c] ?? '');
            }
            out.push(line);
          }
          return out;
        },
        setValues(next) {
          for (let r = 0; r < numRows; r += 1) {
            const target = row - 1 + r;
            while (data.length <= target) data.push([]);
            const line = data[target];
            for (let c = 0; c < numCols; c += 1) line[col - 1 + c] = next[r][c];
          }
        },
      };
    },
    appendRow(next) {
      data.push([...next]);
    },
    deleteRow(row) {
      data.splice(row - 1, 1);
    },
    setFrozenRows() {},
  };
}

function createEnv({ sheets = {}, props = {}, fetch: fetchHandler } = {}) {
  const scriptProps = { SHEET_ID: 'fake-sheet', ...props };
  const sheetMap = new Map();
  for (const [name, values] of Object.entries(sheets)) {
    sheetMap.set(name, makeSheet(values));
  }
  const spreadsheet = {
    getSheetByName: (name) => sheetMap.get(name) || null,
    insertSheet: (name) => {
      const sheet = makeSheet([]);
      sheetMap.set(name, sheet);
      return sheet;
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(scriptProps, key) ? scriptProps[key] : null),
        setProperty: (key, value) => { scriptProps[key] = String(value); },
        deleteProperty: (key) => { delete scriptProps[key]; },
      }),
    },
    Utilities: {
      formatDate: (date, timeZone, format) => {
        if (format !== 'HH:mm') return '';
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(date);
        const hour = parts.find((part) => part.type === 'hour').value;
        const minute = parts.find((part) => part.type === 'minute').value;
        return `${hour}:${minute}`;
      },
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: {
      fetch: fetchHandler || (() => { throw new Error('Unexpected UrlFetchApp.fetch'); }),
    },
    ContentService: {
      createTextOutput: (text) => ({
        text,
        mimeType: '',
        setMimeType(type) { this.mimeType = type; return this; },
        getContent() { return this.text; },
      }),
    },
    MimeType: { JSON: 'application/json' },
    console: { log() {}, error() {} },
  });
  vm.runInContext(logicSource, context);
  vm.runInContext(repoSource, context);
  return {
    context,
    props: scriptProps,
    spreadsheet,
    call: (name, ...args) => context[name](...args),
    values: (name) => {
      const sheet = sheetMap.get(name);
      return sheet ? sheet.getDataRange().getValues() : [];
    },
  };
}

const record = {
  id: 'rec-1',
  car: 'model3',
  startAt: '2026-11-14T05:00:00.000Z',
  date: '2026-11-14',
  time: '13:00',
  kWh: 20,
  durationSec: 7200,
  teslaStartAt: '2026-11-14T05:00:00.000Z',
  teslaEndAt: '2026-11-14T07:00:00.000Z',
  peakKWh: 10,
  offPeakKWh: 10,
  teslaKey: 'din:1786968749',
  source: 'tesla+manual',
};

test('readLog_ migrates the old header in place and marks old rows legacy', () => {
  const env = createEnv({
    sheets: {
      Log: [
        ['id', 'startAt', '日期', '時間'],
        ['old-1', '2026-11-01T00:00:00.000Z', '2026-11-01', '08:00'],
      ],
    },
  });
  const rows = plain(env.call('readLog_'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'legacy');
  assert.equal(rows[0].car, '');
  assert.equal(rows[0].date, '2026-11-01');
  assert.deepEqual(
    env.values('Log')[0].slice(4),
    ['car', 'kWh', 'durationSec', 'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source'],
  );
  assert.equal(env.values('Log')[1][0], 'old-1');
});

test('appendLog_ writes the logical fields into the mapped columns', () => {
  const env = createEnv({});
  env.call('appendLog_', record);
  const rows = plain(env.call('readLog_'));
  assert.deepEqual(rows, [record]);
  const sheetRows = env.values('Log');
  assert.deepEqual(sheetRows[0], [
    'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec', 'teslaStartAt',
    'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
  ]);
  assert.equal(sheetRows[1][2], '2026-11-14');
  assert.equal(sheetRows[1][3], '13:00');
  assert.equal(sheetRows[1][4], 'model3');
});

test('updateLog_ patches fields without losing date and time, and deleteLog_ removes the row', () => {
  const env = createEnv({});
  env.call('appendLog_', record);
  const updated = plain(env.call('updateLog_', 'rec-1', {
    kWh: 21,
    peakKWh: 11,
    source: 'tesla',
  }));
  assert.equal(updated.kWh, 21);
  assert.equal(updated.peakKWh, 11);
  assert.equal(updated.date, '2026-11-14');
  assert.equal(updated.time, '13:00');
  assert.equal(env.call('deleteLog_', 'rec-1'), true);
  assert.equal(env.call('deleteLog_', 'rec-1'), false);
  assert.deepEqual(plain(env.call('readLog_')), []);
});

test('readCars_ filters invalid ids, reserved unassigned, and active flags', () => {
  const env = createEnv({
    sheets: {
      Cars: [
        ['id', 'name', 'active', 'createdAt'],
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'FALSE', 'x'],
        ['Bad Car', 'Bad', 'TRUE', 'x'],
        ['unassigned', 'Unassigned', 'TRUE', 'x'],
      ],
    },
  });
  assert.deepEqual(plain(env.call('readCars_')), [
    { id: 'model3', name: 'Model 3', active: true, peakFactor: 1 },
    { id: 'leaf', name: 'Leaf', active: false, peakFactor: 1 },
  ]);
});

test('readRates_ normalizes rows', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-11', '94.5', '137.5', '47.4', '0', '16:00', '23:00', 'u', 'f', 'FALSE'],
      ],
    },
  });
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 1);
  assert.equal(rates[0].month, '2026-11');
  assert.equal(rates[0].manualOverride, false);
});

test('upsertRates_ updates automatic rows, appends missing months, and skips manual overrides', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-10', '90', '130', '40', '0', '16:00', '23:00', 'u', 'f', 'TRUE'],
      ],
    },
  });
  const updated = env.call('upsertRates_', [
    {
      month: '2026-10', basicOffPeak: 1, basicPeak: 2, fuelAdjustment: 3, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'x', fetchedAt: 'x', manualOverride: false,
    },
    {
      month: '2026-11', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 47.4, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'x', fetchedAt: 'x', manualOverride: false,
    },
  ]);
  assert.equal(updated, 1);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.find((row) => row.month === '2026-10').basicOffPeak, 90);
  assert.equal(rates.find((row) => row.month === '2026-11').basicOffPeak, 94.5);
});

test('appendLog_ writes in actual header order and fills unknown columns blank', () => {
  const env = createEnv({
    sheets: {
      Log: [[
        'source', 'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
        'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'note',
      ]],
    },
  });
  env.call('appendLog_', record);
  const sheetRows = env.values('Log');
  const header = sheetRows[0];
  const at = (name) => sheetRows[1][header.indexOf(name)];
  assert.equal(at('source'), 'tesla+manual');
  assert.equal(at('id'), 'rec-1');
  assert.equal(at('startAt'), '2026-11-14T05:00:00.000Z');
  assert.equal(at('日期'), '2026-11-14');
  assert.equal(at('時間'), '13:00');
  assert.equal(at('car'), 'model3');
  assert.equal(at('kWh'), 20);
  assert.equal(at('teslaKey'), 'din:1786968749');
  assert.equal(at('note'), '');
  assert.deepEqual(plain(env.call('readLog_')), [record]);
});

test('updateLog_ writes in actual header order and preserves extra columns', () => {
  const env = createEnv({
    sheets: {
      Log: [
        [
          'note', 'source', 'id', 'startAt', '日期', '時間', 'car', 'kWh',
          'durationSec', 'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey',
        ],
        [
          'keep-me', 'tesla+manual', 'rec-1', '2026-11-14T05:00:00.000Z', '2026-11-14',
          '13:00', 'model3', 20, 7200, '2026-11-14T05:00:00.000Z',
          '2026-11-14T07:00:00.000Z', 10, 10, 'din:1786968749',
        ],
      ],
    },
  });
  const updated = plain(env.call('updateLog_', 'rec-1', { kWh: 21, peakKWh: 11 }));
  assert.equal(updated.kWh, 21);
  assert.equal(updated.peakKWh, 11);
  assert.equal(updated.date, '2026-11-14');
  assert.equal(updated.time, '13:00');
  const sheetRows = env.values('Log');
  const header = sheetRows[0];
  const at = (name) => sheetRows[1][header.indexOf(name)];
  assert.equal(at('kWh'), 21);
  assert.equal(at('peakKWh'), 11);
  assert.equal(at('日期'), '2026-11-14');
  assert.equal(at('時間'), '13:00');
  assert.equal(at('source'), 'tesla+manual');
  assert.equal(at('note'), 'keep-me');
});

test('upsertRates_ writes in actual header order and preserves extra columns', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        [
          'note', 'manualOverride', 'month', 'basicPeak', 'basicOffPeak', 'fuelAdjustment',
          'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt',
        ],
        ['keep-me', 'FALSE', '2026-10', '130', '90', '40', '0', '16:00', '23:00', 'old-url', 'old-fetched'],
      ],
    },
  });
  const updated = env.call('upsertRates_', [
    {
      month: '2026-10', basicOffPeak: 95, basicPeak: 140, fuelAdjustment: 41, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'new-url', fetchedAt: 'new-fetched',
      manualOverride: false,
    },
    {
      month: '2026-11', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 47.4, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'x', fetchedAt: 'x', manualOverride: false,
    },
  ]);
  assert.equal(updated, 2);
  const sheetRows = env.values('Rates');
  const header = sheetRows[0];
  const find = (month) => sheetRows.find((row, index) => index > 0 && row[header.indexOf('month')] === month);
  const oct = find('2026-10');
  const nov = find('2026-11');
  assert.equal(oct[header.indexOf('basicOffPeak')], 95);
  assert.equal(oct[header.indexOf('basicPeak')], 140);
  assert.equal(oct[header.indexOf('fuelAdjustment')], 41);
  assert.equal(oct[header.indexOf('manualOverride')], 'FALSE');
  assert.equal(oct[header.indexOf('sourceUrl')], 'new-url');
  assert.equal(oct[header.indexOf('note')], 'keep-me');
  assert.equal(nov[header.indexOf('basicOffPeak')], 94.5);
  assert.equal(nov[header.indexOf('note')], '');
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.find((row) => row.month === '2026-10').basicOffPeak, 95);
  assert.equal(rates.find((row) => row.month === '2026-11').basicOffPeak, 94.5);
});

test('openSpreadsheet_ requires the SHEET_ID script property', () => {
  const env = createEnv({ props: { SHEET_ID: '' } });
  assert.throws(() => env.call('openSpreadsheet_'), /SHEET_ID/);
});

test('readRates_ accepts Sheet date cells for month and dedupes', () => {
  const header = [
    'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
    'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
  ];
  const env = createEnv({
    sheets: {
      Rates: [
        header,
        [
          new Date('2026-11-01T00:00:00+08:00'), 94.5, 137.5, 47.4, 0,
          new Date('1899-12-30T08:23:18.000Z'), new Date('1899-12-30T15:23:18.000Z'),
          'clp', new Date('2026-11-15T00:00:00.000Z'), false,
        ],
        [
          new Date('2026-11-01T00:00:00+08:00'), 94.5, 137.5, 47.4, 0,
          new Date('1899-12-30T08:23:18.000Z'), new Date('1899-12-30T15:23:18.000Z'),
          'clp', new Date('2026-11-16T00:00:00.000Z'), true,
        ],
      ],
    },
  });
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 1);
  assert.equal(rates[0].month, '2026-11');
  assert.equal(rates[0].peakStart, '16:00');
  assert.equal(rates[0].peakEnd, '23:00');
  assert.equal(rates[0].fetchedAt, '2026-11-16T00:00:00.000Z');
  assert.equal(rates[0].manualOverride, true);
});

test('readCars_ reads and clamps peakFactor', () => {
  const env = createEnv({
    sheets: {
      Cars: [
        ['id', 'name', 'active', 'createdAt', 'peakFactor'],
        ['model3', 'Model 3', 'TRUE', 'x', 0],
        ['ix3', 'iX3', 'TRUE', 'x', '0.4'],
        ['leaf', 'Leaf', 'TRUE', 'x', 'bad'],
      ],
    },
  });
  assert.deepEqual(plain(env.call('readCars_')).map((car) => [car.id, car.peakFactor]), [
    ['model3', 0],
    ['ix3', 0.4],
    ['leaf', 1],
  ]);
});

test('updateCarPeakFactor_ writes zero into a blank factor cell', () => {
  const env = createEnv({
    sheets: {
      Cars: [
        ['id', 'name', 'active', 'createdAt', 'peakFactor'],
        ['model3', 'Model 3', 'TRUE', 'x', ''],
      ],
    },
  });
  assert.equal(plain(env.call('readCars_'))[0].peakFactor, 1);
  assert.equal(env.call('updateCarPeakFactor_', 'model3', 0), true);
  assert.equal(plain(env.call('readCars_'))[0].peakFactor, 0);
});

test('updateCarPeakFactor_ writes and clamps the factor', () => {
  const env = createEnv({
    sheets: {
      Cars: [
        ['id', 'name', 'active', 'createdAt', 'peakFactor'],
        ['model3', 'Model 3', 'TRUE', 'x', 1],
      ],
    },
  });
  assert.equal(env.call('updateCarPeakFactor_', 'model3', 0.25), true);
  assert.equal(plain(env.call('readCars_'))[0].peakFactor, 0.25);
  assert.equal(env.call('updateCarPeakFactor_', 'model3', 2), true);
  assert.equal(plain(env.call('readCars_'))[0].peakFactor, 1);
  assert.equal(env.call('updateCarPeakFactor_', 'missing', 0.5), false);
});

test('updateLogSplits_ rewrites only peak and off-peak cells by id', () => {
  const env = createEnv({
    sheets: {
      Log: [
        ['id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec', 'teslaStartAt',
          'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source'],
        ['a', '2026-11-14T05:00:00.000Z', '2026-11-14', '13:00', 'model3', 20, 7200,
          '', '', 10, 10, 'din:a', 'tesla'],
        ['b', '2026-11-14T06:00:00.000Z', '2026-11-14', '14:00', 'ix3', 10, 3600,
          '', '', 5, 5, 'din:b', 'tesla'],
      ],
    },
  });
  assert.equal(env.call('updateLogSplits_', { a: { peakKWh: 0, offPeakKWh: 20 } }), 1);
  const rows = env.values('Log');
  assert.deepEqual(rows[1].slice(5, 11), [20, 7200, '', '', 0, 20]);
  assert.deepEqual(rows[2].slice(9, 11), [5, 5]);
  assert.equal(env.call('updateLogSplits_', { a: { peakKWh: 0, offPeakKWh: 20 } }), 0);
});

test('updateLogSplits_ writes zero into blank split cells', () => {
  const env = createEnv({
    sheets: {
      Log: [
        ['id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec', 'teslaStartAt',
          'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source'],
        ['a', '2026-11-14T05:00:00.000Z', '2026-11-14', '13:00', 'model3', 20, 7200,
          '', '', '', '', 'din:a', 'tesla'],
      ],
    },
  });
  assert.equal(env.call('updateLogSplits_', { a: { peakKWh: 0, offPeakKWh: 20 } }), 1);
  const row = env.values('Log')[1];
  assert.equal(Number(row[9]), 0);
  assert.equal(Number(row[10]), 20);
});

test('readCars_ accepts boolean active cells', () => {
  const header = ['id', 'name', 'active', 'createdAt'];
  const env = createEnv({
    sheets: {
      Cars: [
        header,
        ['model3', 'Model 3', true, new Date('2026-11-01T00:00:00+08:00')],
        ['leaf', 'Leaf', false, new Date('2026-11-02T00:00:00+08:00')],
      ],
    },
  });
  const cars = plain(env.call('readCars_'));
  assert.deepEqual(cars.map((car) => [car.id, car.active]), [
    ['model3', true],
    ['leaf', false],
  ]);
});

test('upsertRates_ matches a date month cell instead of appending a duplicate', () => {
  const header = [
    'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
    'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
  ];
  const env = createEnv({
    sheets: {
      Rates: [header, [new Date('2026-11-01T00:00:00+08:00'), 1, 2, 3, 0, '16:00', '23:00', 'old', 'old', 'FALSE']],
    },
  });
  const updated = env.call('upsertRates_', [{
    month: '2026-11',
    basicOffPeak: 94.5,
    basicPeak: 137.5,
    fuelAdjustment: 47.4,
    rebate: 0,
    peakStart: '16:00',
    peakEnd: '23:00',
    sourceUrl: 'new',
    fetchedAt: '2026-11-15T00:00:00.000Z',
    manualOverride: false,
  }]);
  assert.equal(updated, 1);
  const rows = env.values('Rates');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], '2026-11');
  assert.equal(rows[1][1], 94.5);
});

test('upsertRates_ removes duplicate month rows and updates the kept row', () => {
  const header = [
    'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
    'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
  ];
  const env = createEnv({
    sheets: {
      Rates: [
        header,
        ['2026-10', 1, 2, 3, 0, '16:00', '23:00', 'old', 'old', 'FALSE'],
        ['2026-11', 1, 2, 3, 0, '16:00', '23:00', 'old', 'old', 'FALSE'],
        ['2026-11', 4, 5, 6, 0, '16:00', '23:00', 'old', 'old', 'FALSE'],
      ],
    },
  });
  const updated = env.call('upsertRates_', [
    {
      month: '2026-10', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 46.2,
      rebate: 0, peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'new', fetchedAt: '2026-11-15T00:00:00.000Z', manualOverride: false,
    },
    {
      month: '2026-11', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 47.4,
      rebate: 0, peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'new', fetchedAt: '2026-11-15T00:00:00.000Z', manualOverride: false,
    },
  ]);
  assert.equal(updated, 2);
  const rows = env.values('Rates');
  assert.equal(rows.length, 3);
  const november = rows.filter((row) => row[0] === '2026-11');
  assert.equal(november.length, 1);
  assert.equal(november[0][3], 47.4);
});

test('upsertRates_ keeps one manual row and removes an automatic duplicate', () => {
  const header = [
    'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
    'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
  ];
  const env = createEnv({
    sheets: {
      Rates: [
        header,
        ['2026-11', 1, 2, 3, 0, '17:00', '22:00', 'manual', '', 'TRUE'],
        ['2026-11', 94.5, 137.5, 47.4, 0, '16:00', '23:00', 'clp', '2026-11-15T00:00:00.000Z', 'FALSE'],
      ],
    },
  });
  const updated = env.call('upsertRates_', [{
    month: '2026-11', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 47.4,
    rebate: 0, peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'clp', fetchedAt: '2026-11-15T00:00:00.000Z', manualOverride: false,
  }]);
  assert.equal(updated, 0);
  const rows = env.values('Rates');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 1);
  assert.equal(rows[1][5], '17:00');
  assert.equal(rows[1][9], 'TRUE');
});

test('readLog_ accepts Sheet date cells for timestamps', () => {
  const header = [
    'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
    'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
  ];
  const env = createEnv({
    sheets: {
      Log: [header, [
        'rec-1',
        new Date('2026-11-14T05:00:00.000Z'),
        new Date('2026-11-14T00:00:00+08:00'),
        new Date('1899-12-30T13:00:00.000Z'),
        'model3', 20, 7200,
        new Date('2026-11-14T05:00:00.000Z'),
        new Date('2026-11-14T07:00:00.000Z'),
        10, 10, 'din:rec-1', 'tesla+manual',
      ]],
    },
  });
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 1);
  assert.equal(records[0].startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(records[0].date, '2026-11-14');
  assert.equal(records[0].time, '13:00');
  assert.equal(records[0].teslaStartAt, '2026-11-14T05:00:00.000Z');
  assert.equal(records[0].teslaEndAt, '2026-11-14T07:00:00.000Z');
});

const billInput = {
  periodStart: '2026-10-03',
  periodEnd: '2026-11-04',
  cutoff: '2026-11-04T14:59:27.000Z',
  units: 886,
  peakKWh: 77,
  offPeakKWh: 809,
  energyCharge: 870.39,
  fuelCharge: 410.32,
  others: -0.71,
  total: 1280,
  fileName: 'clp-bill.pdf',
};

test('upsertBill_ writes a Bills tab and updates by period instead of duplicating', () => {
  const env = createEnv({});
  const saved = plain(env.call('upsertBill_', env.call('normalizedBillInput_', billInput)));
  assert.equal(saved.units, 886);
  assert.equal(saved.total, 1280);
  assert.equal(saved.cutoff, '2026-11-04T14:59:27.000Z');
  assert.equal(saved.savedAt.length > 10, true);
  assert.deepEqual(env.values('Bills')[0], [
    'periodStart', 'periodEnd', 'cutoff', 'units', 'peakKWh', 'offPeakKWh',
    'energyCharge', 'fuelCharge', 'others', 'total', 'fileName', 'savedAt',
  ]);

  env.call('upsertBill_', env.call('normalizedBillInput_', { ...billInput, total: 1290 }));
  const rows = plain(env.call('readBills_'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 1290);
  assert.equal(rows[0].periodStart, '2026-10-03');
});

test('normalizedBillInput_ rejects bad periods, cutoff and unit splits', () => {
  assert.throws(() => envCall(billInput, { periodStart: '2026-11-05' }), /period/);
  assert.throws(() => envCall(billInput, { cutoff: '2026-12-01T00:00:00.000Z' }), /Cutoff/);
  assert.throws(() => envCall(billInput, { peakKWh: 70, offPeakKWh: 700 }), /do not add up/);
  assert.throws(() => envCall(billInput, { units: 0 }), /units/);
  assert.throws(() => envCall(billInput, { total: -1 }), /total/);
});

function envCall(input, overrides) {
  const env = createEnv({});
  return plain(env.call('normalizedBillInput_', { ...input, ...overrides }));
}

test('readBills_ reads date cells and drops invalid rows', () => {
  const env = createEnv({
    sheets: {
      Bills: [
        ['periodStart', 'periodEnd', 'cutoff', 'units', 'peakKWh', 'offPeakKWh', 'energyCharge', 'fuelCharge', 'others', 'total', 'fileName', 'savedAt'],
        [new Date('2026-09-02T16:00:00.000Z'), new Date('2026-10-01T16:00:00.000Z'), '2026-10-02T16:00:00.000Z', 900, '', '', '', '', '', 1300, '', ''],
        [new Date('2026-10-02T16:00:00.000Z'), new Date('2026-11-03T16:00:00.000Z'), '2026-11-04T14:59:27.000Z', 886, 77, 809, '', '', '', 1280, 'bill.pdf', ''],
        ['bad', '2026-11-04', '', 1, '', '', '', '', '', 1, '', ''],
      ],
    },
  });
  const rows = plain(env.call('readBills_'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].periodEnd, '2026-11-04');
  assert.equal(rows[0].units, 886);
  assert.equal(rows[0].peakKWh, 77);
  assert.equal(rows[1].periodEnd, '2026-10-02');
  assert.equal(rows[1].peakKWh, null);
});
