import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
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

test('setup creates all three tabs and reports counts', () => {
  const env = setup();
  const result = plain(env.call('setup'));
  assert.equal(result.ok, true);
  assert.equal(result.cars, 0);
  assert.equal(result.records, 0);
  assert.equal(result.rates, 0);
  assert.match(result.sheetUrl, /\/d\/fake-sheet\/edit$/);
  for (const name of ['Log', 'Cars', 'Rates']) {
    assert.ok(env.spreadsheet.getSheetByName(name), name);
  }
  assert.equal(env.spreadsheet.getSheetByName('Ignored'), null);
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

test('family delete is scoped to its car and releases a Tesla session to unassigned', () => {
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
  assert.equal(result.released, true);
  const records = plain(env.call('readLog_'));
  const released = records.find((record) => record.id === 'rec-1');
  assert.equal(released.car, 'unassigned');
  assert.equal(released.source, 'tesla');
  assert.equal(released.kWh, 20);
  assert.equal(released.teslaKey, 'din:rec-1');
  assert.equal(released.startAt, '2026-11-14T05:00:00.000Z');

  const again = send(env, { action: 'delete', id: 'rec-1', car: 'model3' });
  assert.equal(again.ok, true);
  assert.equal(again.released, true);
  assert.equal(plain(env.call('readLog_')).length, 2);
});

test('family delete removes a manual start', () => {
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
  });
  const result = send(env, { action: 'delete', id: 'manual-1', car: 'model3' });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.equal(result.released, false);
  assert.equal(plain(env.call('readLog_')).length, 0);
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

test('the ignore action is removed', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:a' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  const result = send(env, { action: 'ignore', id: 'unassigned-1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid action/);
  assert.equal(plain(env.call('readLog_')).length, 1);
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

test('sync imports a session even when a legacy Ignored tab lists its key', () => {
  const key = `din:legacy:${Math.floor(Date.parse(SESSION_START) / 1000)}`;
  const env = setup({
    sheets: {
      Log: [LOG_HEADER],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
      Ignored: [['teslaKey', 'ignoredAt', 'reason'], [key, '2026-11-14T00:00:00.000Z', 'legacy']],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600 }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              charge_start_time: { seconds: Math.floor(Date.parse(SESSION_START) / 1000) },
              charge_duration: { seconds: 7200 },
              energy_added_wh: 20000,
              target_id: 'target-1',
              din: 'din:legacy',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(result.unassigned, 1);
  assert.equal(result.skippedExisting, 0);
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 1);
  assert.equal(records[0].car, 'unassigned');
  assert.equal(records[0].teslaKey, key);
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

test('bill action saves a bill and the owner payload returns it without duplicates', () => {
  const env = setup();
  const bill = {
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
  const saved = send(env, { action: 'bill', bill });
  assert.equal(saved.ok, true);
  assert.equal(saved.bill.units, 886);
  assert.equal(saved.bill.total, 1280);
  assert.ok(saved.bill.savedAt);

  const owner = receive(env, { owner: '1' });
  assert.equal(owner.bills.length, 1);
  assert.equal(owner.bills[0].periodEnd, '2026-11-04');
  assert.equal(owner.bills[0].peakKWh, 77);

  send(env, { action: 'bill', bill: { ...bill, total: 1281 } });
  const again = receive(env, { owner: '1' });
  assert.equal(again.bills.length, 1);
  assert.equal(again.bills[0].total, 1281);
});

test('saving a bill calibrates per-car peak factors and recomputes splits', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        ['ix3-oct', '2026-10-10T10:00:00.000Z', '2026-10-10', '18:00', 'ix3', 100, 7200,
          '2026-10-10T10:00:00.000Z', '2026-10-10T12:00:00.000Z', 100, 0, 'din:ix3-oct', 'tesla'],
        ['m3-oct', '2026-10-20T10:00:00.000Z', '2026-10-20', '18:00', 'model3', 80, 7200,
          '2026-10-20T10:00:00.000Z', '2026-10-20T12:00:00.000Z', 80, 0, 'din:m3-oct', 'tesla'],
      ],
      Cars: [
        [...CARS_HEADER, 'peakFactor'],
        ['ix3', 'iX3', 'TRUE', 'x', 1],
        ['model3', 'Model 3', 'TRUE', 'x', 1],
      ],
      Rates: [
        RATES_HEADER,
        ['2026-10', 94.5, 137.5, 46.2, 0, '16:00', '23:00', 'clp', '2026-10-01T00:00:00.000Z', 'FALSE'],
      ],
    },
  });
  const saved = send(env, {
    action: 'bill',
    bill: {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      cutoff: '2026-11-04T14:59:27.000Z',
      units: 180,
      peakKWh: 98,
      offPeakKWh: 82,
      total: 500,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.calibration.applied, true);
  assert.equal(saved.calibration.billsUsed, 1);
  assert.deepEqual(
    saved.calibration.updatedCars.map((car) => [car.id, car.from, car.to]),
    [['model3', 1, 0]],
  );
  assert.deepEqual(
    plain(env.call('readCars_')).map((car) => [car.id, car.peakFactor]),
    [['ix3', 1], ['model3', 0]],
  );
  const log = plain(env.call('readLog_'));
  const model3 = log.find((record) => record.id === 'm3-oct');
  assert.equal(model3.peakKWh, 0);
  assert.equal(model3.offPeakKWh, 80);
  const ix3 = log.find((record) => record.id === 'ix3-oct');
  assert.equal(ix3.peakKWh, 100);
  assert.equal(ix3.offPeakKWh, 0);
});

test('claiming an unassigned session applies the car peak factor', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        ['u-1', '2026-11-14T10:00:00.000Z', '2026-11-14', '18:00', 'unassigned', 12, 3600,
          '2026-11-14T10:00:00.000Z', '2026-11-14T11:00:00.000Z', 12, 0, 'din:u-1', 'tesla'],
      ],
      Cars: [
        [...CARS_HEADER, 'peakFactor'],
        ['model3', 'Model 3', 'TRUE', 'x', 0],
      ],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  const claimed = send(env, { action: 'claim', car: 'model3', id: 'u-1' });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.assigned, true);
  const record = plain(env.call('readLog_')).find((item) => item.id === 'u-1');
  assert.equal(record.car, 'model3');
  assert.equal(record.peakKWh, 0);
  assert.equal(record.offPeakKWh, 12);
});

test('bill calibration skips periods without assigned car labels', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        ['u-1', '2026-10-10T10:00:00.000Z', '2026-10-10', '18:00', 'unassigned', 100, 7200,
          '2026-10-10T10:00:00.000Z', '2026-10-10T12:00:00.000Z', 100, 0, 'din:u-1', 'tesla'],
      ],
      Cars: [...CARS_HEADER],
      Rates: [
        RATES_HEADER,
        ['2026-10', 94.5, 137.5, 46.2, 0, '16:00', '23:00', 'clp', '2026-10-01T00:00:00.000Z', 'FALSE'],
      ],
    },
  });
  const saved = send(env, {
    action: 'bill',
    bill: {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      cutoff: '2026-11-04T14:59:27.000Z',
      units: 100,
      peakKWh: 60,
      offPeakKWh: 40,
      total: 300,
    },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.calibration.applied, false);
  assert.equal(saved.calibration.reason, 'insufficient labeled data');
  assert.deepEqual(
    saved.calibration.skipped.map((item) => [item.label, item.reason]),
    [['2026-11-04', 'unlabeled sessions']],
  );
});

test('bill action rejects missing and invalid bills', () => {
  const env = setup();
  const missing = send(env, { action: 'bill' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Missing bill/);

  const badCutoff = send(env, {
    action: 'bill',
    bill: {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      cutoff: 'not-a-date',
      units: 886,
      total: 1280,
    },
  });
  assert.equal(badCutoff.ok, false);
  assert.match(badCutoff.error, /cutoff/i);

  const badSplit = send(env, {
    action: 'bill',
    bill: {
      periodStart: '2026-10-03',
      periodEnd: '2026-11-04',
      cutoff: '2026-11-04T14:59:27.000Z',
      units: 886,
      peakKWh: 70,
      offPeakKWh: 700,
      total: 1280,
    },
  });
  assert.equal(badSplit.ok, false);
  assert.match(badSplit.error, /do not add up/);
});

test('publishBill blocks unassigned sessions and family sees only published shares', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        ['ix3-1', '2026-10-10T10:00:00.000Z', '2026-10-10', '18:00', 'ix3', 100, 7200,
          '2026-10-10T10:00:00.000Z', '2026-10-10T12:00:00.000Z', 100, 0, 'din:ix3-1', 'tesla'],
        ['u-1', '2026-10-12T10:00:00.000Z', '2026-10-12', '18:00', 'unassigned', 20, 3600,
          '2026-10-12T10:00:00.000Z', '2026-10-12T11:00:00.000Z', 20, 0, 'din:u-1', 'tesla'],
      ],
      Cars: [
        [...CARS_HEADER, 'peakFactor'],
        ['ix3', 'iX3', 'TRUE', 'x', 1],
        ['model3', 'Model 3', 'TRUE', 'x', 1],
      ],
      Rates: [
        RATES_HEADER,
        ['2026-10', 94.5, 137.5, 46.2, 0, '16:00', '23:00', 'clp', '2026-10-01T00:00:00.000Z', 'FALSE'],
      ],
    },
  });
  const bill = {
    periodStart: '2026-10-03',
    periodEnd: '2026-11-04',
    cutoff: '2026-11-04T14:59:27.000Z',
    units: 120,
    peakKWh: 120,
    offPeakKWh: 0,
    total: 300,
  };
  const saved = send(env, { action: 'bill', bill });
  assert.equal(saved.ok, true);
  assert.equal(saved.bill.publishedAt, '');
  assert.deepEqual(receive(env, { car: 'ix3' }).bills, []);

  const blocked = send(env, { action: 'publishBill', periodStart: '2026-10-03', periodEnd: '2026-11-04' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /unassigned/);

  const claimed = send(env, { action: 'claim', car: 'ix3', id: 'u-1' });
  assert.equal(claimed.ok, true);
  const published = send(env, { action: 'publishBill', periodStart: '2026-10-03', periodEnd: '2026-11-04' });
  assert.equal(published.ok, true);
  assert.ok(published.bill.publishedAt);
  assert.equal(receive(env, { owner: '1' }).bills[0].publishedAt, published.bill.publishedAt);

  const family = receive(env, { car: 'ix3' });
  assert.equal(family.bills.length, 1);
  assert.equal(family.bills[0].periodEnd, '2026-11-04');
  assert.equal(family.bills[0].myKWh, 120);
  assert.equal(family.bills[0].myShare, 1);
  assert.equal(family.bills[0].myAmount, 300);
  assert.equal(receive(env, { car: 'model3' }).bills[0].myAmount, 0);

  env.spreadsheet.getSheetByName('Log').appendRow([
    'u-2', '2026-10-15T10:00:00.000Z', '2026-10-15', '18:00', 'unassigned', 10, 3600,
    '2026-10-15T10:00:00.000Z', '2026-10-15T11:00:00.000Z', 10, 0, 'din:u-2', 'tesla',
  ]);
  assert.deepEqual(receive(env, { car: 'ix3' }).bills, []);
  const republish = send(env, { action: 'publishBill', periodStart: '2026-10-03', periodEnd: '2026-11-04' });
  assert.equal(republish.ok, false);
  assert.match(republish.error, /unassigned/);

  send(env, { action: 'bill', bill: { ...bill, total: 310 } });
  assert.equal(receive(env, { owner: '1' }).bills[0].publishedAt, '');
});

const SNAPSHOT_SECRET = 'test-relay-secret';

function snapshotBody(overrides = {}) {
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const body = {
    action: 'snapshot',
    id: 'snap-' + Math.floor(Date.now() / 1000),
    capturedAt: new Date().toISOString(),
    width: 1920,
    height: 1080,
    image,
    ...overrides,
  };
  const canonical = [body.id, body.capturedAt, body.width, body.height, body.image].join('\n');
  body.signature = crypto.createHmac('sha256', SNAPSHOT_SECRET).update(canonical).digest('hex');
  return body;
}

test('snapshot ingest verifies HMAC, stores one Drive file, and is idempotent', () => {
  const env = setup({ props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET } });
  const body = snapshotBody();
  const first = send(env, body);
  assert.equal(first.ok, true);
  assert.equal(first.stored, true);
  assert.equal(env.driveFiles.length, 1);
  assert.equal(env.values('Snapshots').length, 2);

  const second = send(env, body);
  assert.equal(second.ok, true);
  assert.equal(second.existing, true);
  assert.equal(env.driveFiles.length, 1);
});

test('snapshot ingest rejects a bad signature and an old timestamp', () => {
  const env = setup({ props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET } });
  const bad = snapshotBody();
  bad.signature = '00';
  assert.equal(send(env, bad).ok, false);
  assert.match(send(env, bad).error, /signature/i);

  const old = snapshotBody({ capturedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(send(env, old).ok, false);
  assert.match(send(env, old).error, /timestamp/i);
});

test('sync attaches the nearest snapshot URL to a new unassigned session', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
      Snapshots: [
        ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt'],
        ['snap-1', '2026-11-14T05:04:00.000Z', 'file-1', 'https://drive.google.com/file/d/file-1/view', 1920, 1080, 1000, 'pi', '2026-11-14T05:04:01.000Z'],
      ],
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
              charge_duration: { seconds: 3600 },
              energy_added_wh: 12000,
              target_id: 'target-1',
              din: 'din:evidence',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'sync' });
  assert.equal(result.ok, true);
  assert.equal(result.unassigned, 1);
  const record = plain(env.call('readLog_'))[0];
  assert.equal(record.car, 'unassigned');
  assert.equal(record.evidenceUrl, 'https://drive.google.com/file/d/file-1/view');
});

test('family payload omits the private evidence URL', () => {
  const header = [
    'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec', 'teslaStartAt', 'teslaEndAt',
    'peakKWh', 'offPeakKWh', 'teslaKey', 'source', 'evidenceUrl', 'suggestedCar',
    'suggestionConfidence', 'suggestionPlate', 'suggestionStatus', 'identifiedAt',
  ];
  const env = setup({
    sheets: {
      Log: [
        header,
        ['rec-1', '2026-11-14T05:00:00.000Z', '2026-11-14', '13:00', 'model3', 20, 7200, '', '', 10, 10, '', 'manual', 'https://drive.google.com/file/d/x/view', '', '', '', '', ''],
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  const family = receive(env, { car: 'model3' });
  assert.equal(family.records.length, 1);
  assert.equal('evidenceUrl' in family.records[0], false);
  const owner = receive(env, { owner: '1' });
  assert.equal(owner.records[0].evidenceUrl, 'https://drive.google.com/file/d/x/view');
});

const CONFIG_HEADER = ['key', 'value', 'updatedAt', 'notes'];

function relayConfigBody(at = new Date().toISOString(), secret = SNAPSHOT_SECRET) {
  return {
    action: 'relayConfig',
    at,
    signature: crypto.createHmac('sha256', secret).update('relayConfig\n' + at).digest('hex'),
  };
}

test('relayConfig returns defaults, applies overrides, and clamps values', () => {
  const env = setup({
    props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET },
    sheets: {
      Config: [
        CONFIG_HEADER,
        ['relay.intervalSeconds', '120', '', ''],
        ['relay.imageWidth', '99999', '', ''],
        ['snapshot.retentionDays', '45', '', ''],
        ['vision.engine', 'plate+vlm', '', ''],
      ],
    },
  });
  const result = send(env, relayConfigBody());
  assert.equal(result.ok, true);
  assert.equal(result.config['relay.intervalSeconds'], 120);
  assert.equal(result.config['relay.imageWidth'], 2560);
  assert.equal(result.config['relay.crop'], '');
  assert.equal(result.config['relay.enabled'], true);
  assert.equal(result.config['snapshot.retentionDays'], undefined);
  assert.equal(result.config['vision.engine'], undefined);
});

test('relayConfig rejects a bad signature and an old timestamp', () => {
  const env = setup({ props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET } });
  const bad = relayConfigBody();
  bad.signature = '00';
  assert.equal(send(env, bad).ok, false);
  assert.match(send(env, bad).error, /signature/i);
  const old = relayConfigBody('2026-11-01T00:00:00.000Z');
  assert.equal(send(env, old).ok, false);
  assert.match(send(env, old).error, /timestamp/i);
});

test('setup seeds the Config tab with defaults', () => {
  const env = setup();
  env.call('setup');
  const rows = env.values('Config');
  assert.equal(rows[0][0], 'key');
  assert.ok(rows.some((row) => row[0] === 'relay.intervalSeconds' && row[1] === '300'));
  assert.ok(rows.some((row) => row[0] === 'snapshot.retentionDays' && row[1] === '30'));
});
