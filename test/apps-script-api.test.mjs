import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const codeSource = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
const SESSION_START = '2026-11-14T05:05:00.000Z';

const LOG_HEADER = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
const CARS_HEADER = ['id', 'name', 'active', 'createdAt'];
const RATES_HEADER = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];
const RATE_ROW = ['2026-11', 94.5, 137.5, 47.4, 0, '16:00', '23:00', 'clp', '2026-11-14T00:00:00.000Z', 'FALSE'];
const row = (overrides = {}) => [
  'rec-1', '2026-11-14T05:00:00.000Z', '2026-11-14', '13:00', 'model3',
  20, 7200, '2026-11-14T05:00:00.000Z', '2026-11-14T07:00:00.000Z',
  10, 10, 'din:rec-1', 'tesla+manual',
].map((value, index) => (overrides[index] !== undefined ? overrides[index] : value));

function setup({ sheets = {}, props = {}, fetch } = {}) {
  const env = createAppsScriptEnv({
    sheets,
    props: {
      MATCH_WINDOW_MINUTES: '30',
      TESLA_SITE_ID: 'site-1',
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
      ...props,
    },
    fetch,
  });
  env.context.ContentService.MimeType = { JSON: 'application/json' };
  env.run = (source) => vm.runInContext(source, env.context);
  env.run(codeSource);
  return env;
}

const send = (env, body) => JSON.parse(env.call('doPost', {
  postData: { contents: JSON.stringify(body) },
}).getContent());
const receive = (env, parameter) => JSON.parse(env.call('doGet', { parameter }).getContent());

test('setup creates all four tabs and reports counts', () => {
  const env = setup();
  const result = plain(env.call('setup'));
  assert.equal(result.ok, true);
  assert.equal(result.cars, 0);
  assert.equal(result.records, 0);
  assert.equal(result.rates, 0);
  assert.equal(result.ignored, 0);
  assert.match(result.sheetUrl, /\/d\/fake-sheet\/edit$/);
  for (const name of ['Log', 'Cars', 'Rates', 'Ignored']) {
    assert.ok(env.spreadsheet.getSheetByName(name), name);
  }
});

test('charger status returns live power and charging state', () => {
  const env = setup({
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      if (url.includes('/charger_live_status')) {
        return response(200, JSON.stringify({
          response: {
            wall_connectors: [{
              wall_connector_state: 1,
              wall_connector_power: 7200,
              vin: '5YJ3E111111111111',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  let waits = 0;
  env.context.LockService = {
    getScriptLock: () => ({
      waitLock: () => { waits += 1; },
      releaseLock: () => {},
    }),
  };
  const result = receive(env, { status: '1' });
  assert.equal(result.ok, true);
  assert.equal(result.charging, true);
  assert.equal(result.powerW, 7200);
  assert.equal(result.available, true);
  assert.equal(result.energyWh, null);
  assert.ok(result.keys.includes('wall_connector_power'));
  assert.equal(result.keys.includes('vin'), true);
  assert.equal(waits, 0);
});

test('doGet returns only the requested car records and the owner returns all records', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row(),
        row({ 0: 'leaf-1', 4: 'leaf', 11: 'din:leaf-1' }),
        row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:u', 12: 'tesla' }),
        ['old-1', '2026-11-01T00:00:00.000Z', '2026-11-01', '08:00', '', '', '', '', '', '', '', '', 'legacy'],
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  const family = receive(env, { car: 'model3' });
  assert.equal(family.ok, true);
  assert.equal(family.car.name, 'Model 3');
  assert.equal(family.records.length, 1);
  assert.equal(family.records[0].id, 'rec-1');
  assert.equal(family.unassigned.length, 1);
  assert.equal(family.unassigned[0].id, 'unassigned-1');
  assert.equal(family.rates.length, 1);
  assert.ok(family.serverTime);

  const owner = receive(env, { owner: '1' });
  assert.equal(owner.ok, true);
  assert.equal(owner.cars.length, 2);
  assert.equal(owner.records.length, 4);
  assert.equal(owner.sheetUrl, 'https://docs.google.com/spreadsheets/d/fake-sheet/edit');
  assert.equal(receive(env, { owner: '' }).ok, true);
  assert.equal(receive(env, { car: 'missing' }).ok, false);
  assert.match(receive(env, { car: 'missing' }).error, /Unknown car: missing/);
  assert.match(receive(env, { car: 'BAD CAR' }).error, /Invalid car id/);
});

test('doGet and doPost both serialize on the script lock', () => {
  const events = [];
  const env = setup({
    sheets: {
      Log: [LOG_HEADER],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  env.context.LockService = {
    getScriptLock: () => ({
      waitLock: () => events.push('wait'),
      releaseLock: () => events.push('release'),
    }),
  };
  receive(env, { car: 'model3' });
  send(env, { id: 'lock-1', car: 'model3', startAt: '2026-11-14T05:00:00.000Z', date: '2026-11-14', time: '13:00' });
  assert.deepEqual(events, ['wait', 'release', 'wait', 'release']);
});

test('family append cannot reuse an id that belongs to another car', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'leaf-1', 4: 'leaf', 11: 'din:leaf-1' })],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const result = send(env, {
    id: 'leaf-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /does not belong to this car/);
  assert.equal(plain(env.call('readLog_')).length, 1);
});

test('append is idempotent and rejects a Hong Kong date/time mismatch', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  const body = {
    id: 'new-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
  };
  const first = send(env, body);
  assert.equal(first.ok, true);
  assert.equal(first.record.id, 'new-1');
  const second = send(env, body);
  assert.equal(second.ok, true);
  assert.equal(plain(env.call('readLog_')).filter((record) => record.id === 'new-1').length, 1);
  const mismatch = send(env, { ...body, id: 'new-2', time: '00:00' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /Date\/time mismatch/);
});

test('family delete is scoped to its car and records the Tesla key as ignored', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row(),
        row({ 0: 'leaf-1', 4: 'leaf', 11: 'din:leaf-1' }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const wrong = send(env, { action: 'delete', id: 'leaf-1', car: 'model3' });
  assert.equal(wrong.ok, false);
  const result = send(env, { action: 'delete', id: 'rec-1', car: 'model3' });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:rec-1']);
  assert.equal(plain(env.call('readLog_')).some((record) => record.id === 'rec-1'), false);
});

test('owner assign merges a nearby pending manual row', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'unassigned-1', 4: 'unassigned', 11: 'din:a',
          7: '2026-11-14T05:05:00.000Z', 8: '2026-11-14T07:05:00.000Z',
        }),
        row({
          0: 'manual-1', 4: 'leaf', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const result = send(env, {
    action: 'assign',
    id: 'unassigned-1',
    car: 'leaf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'manual-1');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(target.kWh, 20);
  assert.equal(target.teslaKey, 'din:a');
  assert.equal(records.some((record) => record.id === 'unassigned-1'), false);
  assert.equal(records.some((record) => record.id === 'manual-1'), true);
});

test('family claim merges an unassigned session into its nearby manual row', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'unassigned-1', 4: 'unassigned', 11: 'din:a',
          7: '2026-11-14T05:05:00.000Z', 8: '2026-11-14T07:05:00.000Z',
        }),
        row({
          0: 'manual-1', 4: 'leaf', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const result = send(env, { action: 'claim', car: 'leaf', id: 'unassigned-1' });
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'manual-1');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(target.kWh, 20);
  assert.equal(target.teslaKey, 'din:a');
  assert.equal(records.some((record) => record.id === 'unassigned-1'), false);
});

test('family claim assigns an unassigned session directly when there is no manual row', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:a', 12: 'tesla' }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const result = send(env, { action: 'claim', car: 'leaf', id: 'unassigned-1' });
  assert.equal(result.ok, true);
  assert.equal(result.merged, false);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'unassigned-1');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla');
  assert.equal(records.length, 1);
});

test('family claim rejects unknown cars and already-assigned records', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:a', 12: 'tesla' }),
        row({ 0: 'assigned-1', 4: 'leaf', 11: 'din:b' }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x'], ['leaf', 'Leaf', 'TRUE', 'x']],
    },
  });
  assert.equal(send(env, { action: 'claim', car: 'missing', id: 'unassigned-1' }).ok, false);
  assert.equal(send(env, { action: 'claim', car: 'leaf', id: 'assigned-1' }).ok, false);
});

test('unknown actions report an invalid action', () => {
  const env = setup({ sheets: { Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']] } });
  const result = send(env, { action: 'nope' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid action/);
});

test('owner ignore requires a Tesla key and removes the record', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:a' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  const result = send(env, { action: 'ignore', id: 'unassigned-1' });
  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:a']);
  assert.equal(plain(env.call('readLog_')).length, 0);
});

test('sync matches a manual row, updates the cursor, and exposes the full result shape', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'manual-1', 4: 'model3', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              charge_start_time: { seconds: Math.floor(Date.parse(SESSION_START) / 1000) },
              charge_duration: { seconds: 7200 },
              energy_added_wh: 20000,
              target_id: 'target-1',
              din: 'din:sync',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(result.unassigned, 0);
  assert.equal(result.fetched, 1);
  assert.equal(result.skipped, false);
  assert.equal(result.reconciled, 0);
  assert.equal(result.skippedExisting, 0);
  assert.equal(result.skippedIgnored, 0);
  assert.equal(result.pendingManual, 0);
  const target = plain(env.call('readLog_')).find((record) => record.id === 'manual-1');
  assert.equal(target.kWh, 20);
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.teslaKey, `din:sync:${Math.floor(Date.parse(SESSION_START) / 1000)}`);
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(target.teslaStartAt, SESSION_START);
  assert.ok(env.props.SYNC_CURSOR);
});

test('sync fetches Tesla outside the script lock and applies Sheet work under it', () => {
  const lock = {
    held: false,
    waits: 0,
    waitLock() {
      this.waits += 1;
      this.held = true;
    },
    releaseLock() {
      this.held = false;
    },
  };
  let telemetryLocked = null;
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'manual-1', 4: 'model3', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        telemetryLocked = lock.held;
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              charge_start_time: { seconds: Math.floor(Date.parse(SESSION_START) / 1000) },
              charge_duration: { seconds: 7200 },
              energy_added_wh: 20000,
              target_id: 'target-1',
              din: 'din:sync',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  env.context.LockService = { getScriptLock: () => lock };

  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(telemetryLocked, false);
  assert.equal(lock.held, false);
  assert.equal(lock.waits, 2);

  const again = send(env, { action: 'sync' });
  assert.equal(again.ok, true);
  assert.equal(again.matched, 0);
  assert.equal(again.skippedExisting, 1);
  assert.equal(plain(env.call('readLog_')).length, 1);
});

test('a failed Tesla fetch releases the sync lock and leaves Log unchanged', () => {
  const lock = {
    held: false,
    waitLock() { this.held = true; },
    releaseLock() { this.held = false; },
  };
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'manual-1', 4: 'model3', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      throw new Error('Tesla unavailable');
    },
  });
  env.context.LockService = { getScriptLock: () => lock };

  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Tesla unavailable/);
  assert.equal(lock.held, false);
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 1);
  assert.equal(records[0].kWh, null);
  assert.equal(records[0].source, 'manual');
});

test('owner sync initializes a 30-day window; family sync without a manual row stays skipped', () => {
  const makeEnv = () => setup({
    sheets: { Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']] },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              charge_start_time: { seconds: Math.floor(Date.parse(SESSION_START) / 1000) },
              charge_duration: { seconds: 3600 },
              energy_added_wh: 12000,
              target_id: 'target-1',
              din: 'din:init',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const ownerEnv = makeEnv();
  const owner = send(ownerEnv, { action: 'sync' });
  assert.equal(owner.ok, true);
  assert.equal(owner.skipped, false);
  assert.equal(owner.fetched, 1);
  assert.equal(owner.unassigned, 1);
  assert.equal(plain(ownerEnv.call('readLog_'))[0].car, 'unassigned');

  const familyEnv = makeEnv();
  const family = send(familyEnv, { action: 'sync', car: 'model3' });
  assert.equal(family.ok, true);
  assert.equal(family.skipped, true);
  assert.equal(family.fetched, 0);
  assert.equal(plain(familyEnv.call('readLog_')).length, 0);
});

test('sync reconciles an existing unassigned session into the matching manual row', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'unassigned-old', 4: 'unassigned', 11: 'din:old', 12: 'tesla',
          7: '2026-11-14T05:05:00.000Z', 8: '2026-11-14T07:05:00.000Z',
        }),
        row({
          0: 'manual-new', 4: 'leaf', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x'], ['leaf', 'Leaf', 'TRUE', 'x']],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({ response: { telemetry_history: [] } }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(result.reconciled, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.unassigned, 0);
  assert.equal(result.fetched, 0);
  assert.equal(result.skipped, false);
  assert.equal(result.skippedExisting, 0);
  assert.equal(result.skippedIgnored, 0);
  assert.equal(result.pendingManual, 0);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'manual-new');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(target.teslaKey, 'din:old');
  assert.equal(target.kWh, 20);
  assert.equal(records.some((record) => record.id === 'unassigned-old'), false);
});

test('refreshRates updates the Rates tab', () => {
  const fuelPage = `
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
  const tariffPage = `
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
`;
  const env = setup({
    sheets: { Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']] },
    fetch: (url) => {
      if (url === FUEL_URL) return response(200, fuelPage);
      if (url === TARIFF_URL) return response(200, tariffPage);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'refreshRates' });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 11);
  assert.equal(plain(env.call('readRates_')).length, 11);
});

test('refreshRates rejects implausible tariff values without writing', () => {
  const env = setup({
    sheets: { Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']] },
    fetch: (url) => {
      if (url === FUEL_URL) {
        return response(200, `
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
`);
      }
      if (url === TARIFF_URL) {
        return response(200, '非高峰用電時間\n94.5\n高峰用電時間\n80.5\n');
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'refreshRates' });
  assert.equal(result.ok, false);
  assert.match(result.error, /CLP/);
  assert.equal(plain(env.call('readRates_')).length, 0);
});
