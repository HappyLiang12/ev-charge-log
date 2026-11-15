import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FLEET_URL = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
const READER = 'https://r.jina.ai/';
const SCOPE = 'openid offline_access energy_device_data';
const SESSION_START = '2026-11-14T05:00:00.000Z';
const SESSION_END = '2026-11-14T07:00:00.000Z';
const SESSION_START_SEC = Math.floor(Date.parse(SESSION_START) / 1000);
const SESSION_KEY = `din-1:${SESSION_START_SEC}`;
const MANUAL_START = '2026-11-14T05:10:00.000Z';

const fuelPage = `
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
const tariffPage = `
電動車住宅分時段用電價目
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
燃料調整費每月浮動。
`;

const LOG_HEADER = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
const RATES_HEADER = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];

function logRow(overrides = {}) {
  const row = {
    id: '', startAt: '', date: '', time: '', car: '', kWh: '', durationSec: '',
    teslaStartAt: '', teslaEndAt: '', peakKWh: '', offPeakKWh: '', teslaKey: '', source: 'manual',
    ...overrides,
  };
  return LOG_HEADER.map((column) => row[column]);
}

function logSheet(rows) {
  return [LOG_HEADER, ...rows];
}

function ratesSheet() {
  return [RATES_HEADER, ['2026-11', 94.5, 137.5, 47.4, 0, '16:00', '23:00', '', '', 'FALSE']];
}

function verifiedSession(overrides = {}) {
  return {
    charge_start_time: { seconds: SESSION_START_SEC },
    charge_duration: { seconds: 7200 },
    energy_added_wh: 20500,
    target_id: { text: 'target-text-1' },
    din: 'din-1',
    ...overrides,
  };
}

function cachedTeslaProps(extra = {}) {
  return {
    TESLA_ACCESS_TOKEN: 'access-1',
    TESLA_TOKEN_EXPIRY: String(Date.now() + 3600000),
    TESLA_SITE_ID: 'site-1',
    ...extra,
  };
}

function telemetryFetch({ sessions = [], calls = [], status = 200 } = {}) {
  return (url, options) => {
    calls.push({ url, options });
    if (url === TOKEN_URL) {
      return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' }));
    }
    if (url.startsWith(`${FLEET_URL}/api/1/energy_sites/site-1/telemetry_history`)) {
      if (status !== 200) return response(status, '{}');
      return response(200, JSON.stringify({ response: { telemetry_history: sessions } }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

test('refreshAccessToken_ posts the refresh grant with audience and scope, then caches and rotates tokens', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'client-id',
      TESLA_CLIENT_SECRET: 'client-secret',
      TESLA_REFRESH_TOKEN: 'refresh-1',
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      return response(200, JSON.stringify({
        access_token: 'access-1',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      }));
    },
  });
  assert.equal(env.call('refreshAccessToken_'), 'access-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].options.method, 'post');
  assert.deepEqual(plain(calls[0].options.payload), {
    grant_type: 'refresh_token',
    client_id: 'client-id',
    client_secret: 'client-secret',
    refresh_token: 'refresh-1',
    audience: FLEET_URL,
    scope: SCOPE,
  });
  assert.equal(env.props.TESLA_ACCESS_TOKEN, 'access-1');
  assert.equal(env.props.TESLA_REFRESH_TOKEN, 'refresh-2');
  assert.ok(Number(env.props.TESLA_TOKEN_EXPIRY) > Date.now());
});

test('refreshAccessToken_ sends the configured base URL as the audience', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
      TESLA_BASE_URL: 'https://fleet-api.example.test/',
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      return response(200, JSON.stringify({ access_token: 'access-2', expires_in: 3600 }));
    },
  });
  assert.equal(env.call('refreshAccessToken_'), 'access-2');
  assert.equal(calls[0].options.payload.audience, 'https://fleet-api.example.test');
});

test('refreshAccessToken_ reuses a cached token that is not near expiry', () => {
  const env = createAppsScriptEnv({
    props: {
      TESLA_ACCESS_TOKEN: 'cached-token',
      TESLA_TOKEN_EXPIRY: String(Date.now() + 3600000),
    },
    fetch: () => { throw new Error('should not fetch'); },
  });
  assert.equal(env.call('refreshAccessToken_'), 'cached-token');
});

test('refreshAccessToken_ reports token endpoint failures without leaking the body', () => {
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
    },
    fetch: () => response(400, JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' })),
  });
  assert.throws(() => env.call('refreshAccessToken_'), /Tesla token refresh failed \(400\)/);
  assert.throws(() => env.call('refreshAccessToken_'), (error) => !error.message.includes('refresh token expired'));
});

test('fetchSessions_ maps the verified payload found through recursive session-array discovery', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: cachedTeslaProps(),
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url.startsWith(`${FLEET_URL}/api/1/energy_sites/site-1/telemetry_history`)) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: {
              data: [
                verifiedSession(),
                verifiedSession({ charge_start_time: { seconds: SESSION_START_SEC + 3600 } }),
              ],
            },
            notes: [{ note: 'not a session array' }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const sessions = plain(env.call(
    'fetchSessions_',
    'site-1',
    '2026-11-01T00:00:00.000Z',
    '2026-11-14T12:00:00.000Z',
  ));
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], {
    teslaKey: SESSION_KEY,
    startAt: SESSION_START,
    endAt: SESSION_END,
    durationSec: 7200,
    kWh: 20.5,
    targetId: 'target-text-1',
    din: 'din-1',
  });
  assert.equal(sessions[1].startAt, '2026-11-14T06:00:00.000Z');
  assert.equal(sessions[1].endAt, '2026-11-14T08:00:00.000Z');
  const telemetryCall = calls.find((call) => call.url.includes('/telemetry_history'));
  assert.match(telemetryCall.url, /kind=charge/);
  assert.match(telemetryCall.url, /time_zone=Asia%2FHong_Kong/);
  assert.equal(telemetryCall.options.headers.Authorization, 'Bearer access-1');
});

test('fetchSessions_ ignores sessions with no start, no duration, or non-positive energy', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps(),
    fetch: (url) => {
      if (url.startsWith(`${FLEET_URL}/api/1/energy_sites/site-1/telemetry_history`)) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [
              verifiedSession({ energy_added_wh: 0 }),
              verifiedSession({ energy_added_wh: -1200, charge_start_time: { seconds: SESSION_START_SEC + 10 } }),
              verifiedSession({ charge_duration: { seconds: 0 }, charge_start_time: { seconds: SESSION_START_SEC + 20 } }),
              verifiedSession({ charge_start_time: {}, din: 'din-x' }),
              verifiedSession({
                energy_added_wh: 1500.5,
                charge_start_time: { seconds: SESSION_START_SEC + 30 },
                din: 'din-2',
              }),
            ],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const sessions = plain(env.call('fetchSessions_', 'site-1', SESSION_START, SESSION_END));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].kWh, 1.5005);
  assert.equal(sessions[0].din, 'din-2');
});

test('discoverSiteId_ returns the configured site without calling the API', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ TESLA_SITE_ID: 'configured-site' }),
    fetch: () => { throw new Error('should not fetch'); },
  });
  assert.equal(env.call('discoverSiteId_'), 'configured-site');
});

test('discoverSiteId_ selects the single wall_connector product and caches it', () => {
  const env = createAppsScriptEnv({
    props: {
      TESLA_ACCESS_TOKEN: 'access-1',
      TESLA_TOKEN_EXPIRY: String(Date.now() + 3600000),
    },
    fetch: (url) => {
      if (url === `${FLEET_URL}/api/1/products`) {
        return response(200, JSON.stringify({
          response: [
            { energy_site_id: 111, resource_type: 'solar' },
            { energy_site_id: 222, resource_type: 'wall_connector', site_name: 'Home' },
          ],
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(env.call('discoverSiteId_'), '222');
  assert.equal(env.props.TESLA_SITE_ID, '222');
});

test('discoverSiteId_ fails when the wall_connector match count is not exactly one', () => {
  const products = (items) => (url) => {
    if (url === `${FLEET_URL}/api/1/products`) {
      return response(200, JSON.stringify({ response: items }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const baseProps = {
    TESLA_ACCESS_TOKEN: 'access-1',
    TESLA_TOKEN_EXPIRY: String(Date.now() + 3600000),
  };
  const none = createAppsScriptEnv({
    props: { ...baseProps },
    fetch: products([{ energy_site_id: 111, resource_type: 'solar' }]),
  });
  assert.throws(() => none.call('discoverSiteId_'), /found 0.*TESLA_SITE_ID/);

  const two = createAppsScriptEnv({
    props: { ...baseProps },
    fetch: products([
      { energy_site_id: 111, resource_type: 'wall_connector' },
      { energy_site_id: 222, resource_type: 'wall_connector' },
    ]),
  });
  assert.throws(() => two.call('discoverSiteId_'), /found 2.*TESLA_SITE_ID/);
});

test('selectRateRow_ prefers the exact month, then the latest earlier month', () => {
  const env = createAppsScriptEnv();
  const rates = [
    { month: '2026-09', basicOffPeak: 90 },
    { month: '2026-11', basicOffPeak: 94.5 },
  ];
  assert.equal(plain(env.call('selectRateRow_', '2026-11', rates)).basicOffPeak, 94.5);
  assert.equal(plain(env.call('selectRateRow_', '2026-12', rates)).month, '2026-11');
  assert.equal(env.call('selectRateRow_', '2026-08', rates), null);
});

test('syncTesla_ fills the nearest manual row and advances SYNC_CURSOR to the fetch end', () => {
  const started = Date.now();
  const calls = [];
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([logRow({ id: 'm1', startAt: MANUAL_START, car: 'carA' })]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({ sessions: [verifiedSession()], calls }),
  });
  const result = plain(env.call('syncTesla_'));
  const finished = Date.now();

  assert.deepEqual(result, {
    matched: 1,
    unassigned: 0,
    fetched: 1,
    skipped: false,
    reconciled: 0,
    skippedExisting: 0,
    pendingManual: 0,
  });
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'm1');
  assert.equal(records[0].car, 'carA');
  assert.equal(records[0].startAt, MANUAL_START);
  assert.equal(records[0].source, 'tesla+manual');
  assert.equal(records[0].kWh, 20.5);
  assert.equal(records[0].durationSec, 7200);
  assert.equal(records[0].teslaKey, SESSION_KEY);
  assert.equal(records[0].teslaStartAt, SESSION_START);
  assert.equal(records[0].teslaEndAt, SESSION_END);
  assert.equal(records[0].peakKWh, 0);
  assert.equal(records[0].offPeakKWh, 20.5);

  const telemetryCall = calls.find((call) => call.url.includes('/telemetry_history'));
  const endParam = new URL(telemetryCall.url).searchParams.get('end_date');
  assert.equal(env.props.SYNC_CURSOR, endParam);
  assert.ok(Date.parse(env.props.SYNC_CURSOR) >= started);
  assert.ok(Date.parse(env.props.SYNC_CURSOR) <= finished);
});

test('syncTesla_ reconciles an unassigned session into the manual row and keeps the manual identity', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([
        logRow({
          id: 'tesla-1',
          startAt: SESSION_START,
          car: 'unassigned',
          kWh: 20.5,
          durationSec: 7200,
          teslaStartAt: SESSION_START,
          teslaEndAt: SESSION_END,
          peakKWh: 0,
          offPeakKWh: 20.5,
          teslaKey: SESSION_KEY,
          source: 'tesla',
        }),
        logRow({ id: 'm1', startAt: MANUAL_START, car: 'carB' }),
      ]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({ sessions: [verifiedSession()] }),
  });
  const result = plain(env.call('syncTesla_'));

  assert.equal(result.reconciled, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.unassigned, 0);
  assert.equal(result.fetched, 1);
  assert.equal(result.pendingManual, 0);
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'm1');
  assert.equal(records[0].car, 'carB');
  assert.equal(records[0].startAt, MANUAL_START);
  assert.equal(records[0].source, 'tesla+manual');
  assert.equal(records[0].kWh, 20.5);
  assert.equal(records[0].teslaKey, SESSION_KEY);
  assert.equal(records.some((record) => record.car === 'unassigned'), false);
});

test('syncTesla_ keeps the unassigned row when the manual reconcile write fails', () => {
  const unassignedRow = logRow({
    id: 'tesla-1',
    startAt: SESSION_START,
    car: 'unassigned',
    kWh: 20.5,
    durationSec: 7200,
    teslaStartAt: SESSION_START,
    teslaEndAt: SESSION_END,
    peakKWh: 0,
    offPeakKWh: 20.5,
    teslaKey: SESSION_KEY,
    source: 'tesla',
  });
  const manual = logRow({ id: 'm1', startAt: MANUAL_START, car: 'carB' });
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([unassignedRow, manual]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({ sessions: [] }),
  });
  const before = plain(env.values('Log'));
  env.context.updateLog_ = () => null;
  const result = plain(env.call('syncTesla_'));
  assert.equal(result.reconciled, 0);
  assert.deepEqual(plain(env.values('Log')), before);
});

test('syncTesla_ skips a session whose teslaKey already exists in Log', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([
        logRow({
          id: 'm1',
          startAt: MANUAL_START,
          car: 'carA',
          kWh: 20.5,
          durationSec: 7200,
          teslaStartAt: SESSION_START,
          teslaEndAt: SESSION_END,
          peakKWh: 0,
          offPeakKWh: 20.5,
          teslaKey: SESSION_KEY,
          source: 'tesla+manual',
        }),
      ]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({ sessions: [verifiedSession()] }),
  });
  const result = plain(env.call('syncTesla_'));
  assert.equal(result.skippedExisting, 1);
  assert.equal(result.matched, 0);
  assert.equal(result.unassigned, 0);
  assert.equal(result.fetched, 1);
  assert.equal(plain(env.call('readLog_')).length, 1);
});

test('teslaGet_ retries once after a 401 and then reports authorization expiry on 403', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: cachedTeslaProps(),
    fetch: (url) => {
      calls.push(url);
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-2', expires_in: 3600 }));
      }
      if (url === `${FLEET_URL}/retry`) {
        const attempts = calls.filter((item) => item === `${FLEET_URL}/retry`).length;
        return attempts === 1 ? response(401, '') : response(200, JSON.stringify({ ok: true }));
      }
      if (url === `${FLEET_URL}/forbidden`) return response(403, '');
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.deepEqual(plain(env.call('teslaGet_', '/retry', {})), { ok: true });
  assert.equal(calls.filter((item) => item === `${FLEET_URL}/retry`).length, 2);
  assert.ok(calls.includes(TOKEN_URL));
  assert.throws(
    () => env.call('teslaGet_', '/forbidden', {}),
    /Tesla authorization expired; re-run the local setup tool/,
  );
});

test('syncTesla_ fetches from SYNC_CURSOR minus two days and never sets the cursor to a session start', () => {
  const calls = [];
  const started = Date.now();
  const cursor = new Date(started - 24 * 3600 * 1000).toISOString();
  const sessionStart = new Date(started - 12 * 3600 * 1000).toISOString();
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_CURSOR: cursor }),
    sheets: {
      Log: logSheet([logRow({ id: 'm1', startAt: '2026-11-10T05:00:00.000Z', car: 'carA' })]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({
      sessions: [verifiedSession({ charge_start_time: { seconds: Math.floor(Date.parse(sessionStart) / 1000) } })],
      calls,
    }),
  });
  const result = plain(env.call('syncTesla_'));
  const finished = Date.now();

  assert.equal(result.fetched, 1);
  assert.equal(result.unassigned, 1);
  assert.equal(result.pendingManual, 1);
  const telemetryCall = calls.find((call) => call.url.includes('/telemetry_history'));
  const params = new URL(telemetryCall.url).searchParams;
  assert.equal(params.get('start_date'), new Date(Date.parse(cursor) - 2 * 86400000).toISOString());
  assert.equal(env.props.SYNC_CURSOR, params.get('end_date'));
  assert.ok(Date.parse(env.props.SYNC_CURSOR) >= started);
  assert.ok(Date.parse(env.props.SYNC_CURSOR) <= finished);
  assert.notEqual(env.props.SYNC_CURSOR, sessionStart);
});

test('syncTesla_ gives same-second sessions distinct deterministic ids with the tesla- prefix', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([]),
      Rates: ratesSheet(),
    },
    fetch: telemetryFetch({
      sessions: [
        verifiedSession({ din: 'din-1' }),
        verifiedSession({ din: 'din-2' }),
      ],
    }),
  });
  const result = plain(env.call('syncTesla_'));
  assert.equal(result.unassigned, 2);
  const records = plain(env.call('readLog_'));
  assert.equal(records.length, 2);
  const ids = records.map((record) => record.id).sort();
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.match(id, new RegExp(`^tesla-${SESSION_START_SEC}-[a-z0-9]+$`));
  }
  const first = env.call('teslaRecordId_', records[0]);
  const again = env.call('teslaRecordId_', records[0]);
  assert.equal(first, again);
  assert.equal(first, records[0].id);
});

test('syncTesla_ leaves Log and the cursor untouched when the Tesla fetch fails', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps({ SYNC_FROM: '2026-11-01T00:00:00.000Z' }),
    sheets: {
      Log: logSheet([logRow({ id: 'm1', startAt: MANUAL_START, car: 'carA' })]),
    },
    fetch: telemetryFetch({ status: 500 }),
  });
  const before = plain(env.values('Log'));
  assert.throws(() => env.call('syncTesla_'), /Tesla API 500/);
  assert.deepEqual(plain(env.values('Log')), before);
  assert.equal(env.props.SYNC_CURSOR, undefined);
  assert.deepEqual(plain(env.values('Rates')), []);
});

test('syncTesla_ returns a skipped result without fetching or writing when no fetch bound exists', () => {
  const env = createAppsScriptEnv({
    props: cachedTeslaProps(),
    sheets: { Log: logSheet([]) },
    fetch: () => { throw new Error('should not fetch'); },
  });
  const result = plain(env.call('syncTesla_'));
  assert.deepEqual(result, {
    matched: 0,
    unassigned: 0,
    fetched: 0,
    skipped: true,
    reconciled: 0,
    skippedExisting: 0,
    pendingManual: 0,
  });
  assert.equal(env.props.SYNC_CURSOR, undefined);
  assert.deepEqual(plain(env.values('Log')), [LOG_HEADER]);
});

test('refreshRates_ falls back to the reader on 403 or parse failure and writes the yearly table', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url === FUEL_URL) return response(403, '');
      if (url === READER + FUEL_URL) return response(200, fuelPage);
      if (url === TARIFF_URL) return response(200, 'not the tariff page');
      if (url === READER + TARIFF_URL) return response(200, tariffPage);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = plain(env.call('refreshRates_'));
  assert.equal(result.updated, 11);
  assert.equal(result.reader, true);
  assert.equal(result.month, '2026-11');
  assert.equal(result.fuelAdjustment, 47.4);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 11);
  const november = rates.find((rate) => rate.month === '2026-11');
  assert.equal(november.basicOffPeak, 94.5);
  assert.equal(november.basicPeak, 137.5);
  assert.equal(november.fuelAdjustment, 47.4);
  assert.equal(november.rebate, 0);
  assert.equal(november.manualOverride, false);
  assert.equal(november.sourceUrl, `${FUEL_URL},${TARIFF_URL}`);
  assert.equal(november.peakStart, '16:00');
  assert.equal(november.peakEnd, '23:00');
  assert.ok(Math.abs(Date.parse(november.fetchedAt) - Date.now()) < 60000);
  assert.equal(new Set(rates.map((rate) => rate.fetchedAt)).size, 1);
  const directFuel = calls.find((call) => call.url === FUEL_URL);
  assert.match(directFuel.options.headers['User-Agent'], /Mozilla\/5\.0/);
  const readerFuel = calls.find((call) => call.url === READER + FUEL_URL);
  assert.match(readerFuel.options.headers['User-Agent'], /Mozilla\/5\.0/);
});

test('refreshRates_ falls back to the reader when the direct fuel page has the sentence but no table', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url === FUEL_URL) return response(200, '2026年11月1日起，燃料調整費為每度電47.4港仙。');
      if (url === READER + FUEL_URL) return response(200, fuelPage);
      if (url === TARIFF_URL) return response(200, tariffPage);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = plain(env.call('refreshRates_'));
  assert.equal(result.reader, true);
  assert.equal(result.updated, 11);
  assert.equal(result.fuelAdjustment, 47.4);
  assert.ok(calls.some((call) => call.url === READER + FUEL_URL));
  assert.equal(plain(env.call('readRates_')).length, 11);
});

test('refreshRates_ leaves existing rows untouched when both sources fail to parse', () => {
  const env = createAppsScriptEnv({
    sheets: {
      Rates: [
        RATES_HEADER,
        ['2026-11', '1', '2', '3', '0', '16:00', '23:00', 'old', 'old', 'FALSE'],
      ],
    },
    fetch: () => response(200, 'still not a rate page'),
  });
  assert.throws(() => env.call('refreshRates_'), /CLP page parse failed/);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates[0].basicOffPeak, 1);
});

test('refreshRates_ reports HTTP failures separately and leaves existing rows untouched', () => {
  const env = createAppsScriptEnv({
    sheets: {
      Rates: [
        RATES_HEADER,
        ['2026-11', '1', '2', '3', '0', '16:00', '23:00', 'old', 'old', 'FALSE'],
      ],
    },
    fetch: () => response(500, ''),
  });
  assert.throws(() => env.call('refreshRates_'), /CLP fetch failed.*HTTP 500, reader 500/);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates[0].basicOffPeak, 1);
});
