import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
const READER = 'https://r.jina.ai/';

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

test('refreshAccessToken_ posts the refresh grant, caches the access token, and rotates the refresh token', () => {
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
  });
  assert.equal(env.props.TESLA_ACCESS_TOKEN, 'access-1');
  assert.equal(env.props.TESLA_REFRESH_TOKEN, 'refresh-2');
  assert.ok(Number(env.props.TESLA_TOKEN_EXPIRY) > Date.now());
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

test('fetchSessions_ calls telemetry_history with Hong Kong time and maps the session', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
      TESLA_SITE_ID: 'site-1',
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' }));
      }
      if (url.startsWith('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              start_date_time: '2026-11-14T05:00:00.000Z',
              duration: 7200,
              charge_energy_added: 20,
              target_id: 'target-1',
              din: 'din-1',
            }],
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
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(sessions[0].endAt, '2026-11-14T07:00:00.000Z');
  assert.equal(sessions[0].durationSec, 7200);
  assert.equal(sessions[0].kWh, 20);
  assert.equal(sessions[0].teslaKey, `din-1:${Math.floor(Date.parse('2026-11-14T05:00:00.000Z') / 1000)}`);
  const telemetryCall = calls.find((call) => call.url.includes('/telemetry_history'));
  assert.match(telemetryCall.url, /kind=charge/);
  assert.match(telemetryCall.url, /time_zone=Asia%2FHong_Kong/);
  assert.equal(telemetryCall.options.headers.Authorization, 'Bearer access-1');
});

test('refreshRates_ falls back to the reader on 403 or parse failure and writes the yearly table', () => {
  const env = createAppsScriptEnv({
    fetch: (url) => {
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
});

test('refreshRates_ leaves existing rows untouched when both sources fail to parse', () => {
  const env = createAppsScriptEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-11', '1', '2', '3', '0', '16:00', '23:00', 'old', 'old', 'FALSE'],
      ],
    },
    fetch: () => response(200, 'still not a rate page'),
  });
  assert.throws(() => env.call('refreshRates_'), /CLP page parse failed/);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates[0].basicOffPeak, 1);
});
