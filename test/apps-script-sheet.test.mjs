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
    { id: 'model3', name: 'Model 3', active: true },
    { id: 'leaf', name: 'Leaf', active: false },
  ]);
});

test('readRates_ normalizes rows and readIgnored_ returns unique keys', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-11', '94.5', '137.5', '47.4', '0', '16:00', '23:00', 'u', 'f', 'FALSE'],
      ],
      Ignored: [
        ['teslaKey', 'ignoredAt', 'reason'],
        ['din:a', 'x', 'deleted'],
      ],
    },
  });
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 1);
  assert.equal(rates[0].month, '2026-11');
  assert.equal(rates[0].manualOverride, false);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:a']);
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

test('addIgnored_ deduplicates and readIgnored_ returns the key', () => {
  const env = createEnv({});
  env.call('addIgnored_', 'din:x', 'deleted');
  env.call('addIgnored_', 'din:x', 'again');
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:x']);
  assert.equal(env.values('Ignored').length, 2);
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

test('addIgnored_ appends in actual header order and leaves unknown columns blank', () => {
  const env = createEnv({
    sheets: {
      Ignored: [
        ['note', 'reason', 'teslaKey', 'ignoredAt'],
        ['keep-me', 'deleted', 'din:a', 'x'],
      ],
    },
  });
  env.call('addIgnored_', 'din:b', 'manual delete');
  env.call('addIgnored_', 'din:a', 'again');
  const sheetRows = env.values('Ignored');
  const header = sheetRows[0];
  assert.equal(sheetRows.length, 3);
  const added = sheetRows.find((row, index) => index > 0 && row[header.indexOf('teslaKey')] === 'din:b');
  assert.equal(added[header.indexOf('reason')], 'manual delete');
  assert.equal(added[header.indexOf('note')], '');
  assert.ok(added[header.indexOf('ignoredAt')]);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:a', 'din:b']);
});

test('openSpreadsheet_ requires the SHEET_ID script property', () => {
  const env = createEnv({ props: { SHEET_ID: '' } });
  assert.throws(() => env.call('openSpreadsheet_'), /SHEET_ID/);
});
