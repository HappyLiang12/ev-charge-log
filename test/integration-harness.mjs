import http from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const codeSource = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const qrSource = readFileSync(new URL('../vendor/qrcode-generator.js', import.meta.url), 'utf8');

export const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
export const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
export const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

export const LOG_HEADER = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
export const CARS_HEADER = ['id', 'name', 'active', 'createdAt'];
export const RATES_HEADER = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];

export const fuelPage = `
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

export const tariffPage = `
非高峰用電時間
（每日晚上十一時至翌日下午四時，優惠時段長達17小時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
`;

const response = (status, text) => ({
  getResponseCode: () => status,
  getContentText: () => text,
});

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hkDate(iso) {
  const date = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function hkTime(iso) {
  const date = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

export { hkDate, hkTime };

export function rateRow(month, fuelAdjustment, { duplicate = false, sourceUrl = `${FUEL_URL},${TARIFF_URL}` } = {}) {
  const monthDate = new Date(`${month}-01T00:00:00+08:00`);
  return [
    monthDate, 94.5, 137.5, fuelAdjustment, 0,
    new Date('1899-12-30T08:23:18.000Z'),
    new Date('1899-12-30T15:23:18.000Z'),
    sourceUrl,
    duplicate ? '2026-11-15T00:00:59.000Z' : '2026-11-15T00:00:25.000Z',
    false,
  ];
}

export function logRow(record) {
  return [
    record.id, record.startAt, hkDate(record.startAt), hkTime(record.startAt),
    record.car, record.kWh ?? '', record.durationSec ?? '',
    record.teslaStartAt ?? '', record.teslaEndAt ?? '',
    record.peakKWh ?? '', record.offPeakKWh ?? '',
    record.teslaKey ?? '', record.source ?? 'manual',
  ];
}

export function defaultSheets({ rates, records = [], cars } = {}) {
  return {
    Cars: [
      CARS_HEADER,
      ...(cars || [
        ['model3', 'Model 3', true, new Date('2026-11-01T00:00:00+08:00')],
        ['leaf', 'Leaf', true, new Date('2026-11-01T00:00:00+08:00')],
      ]),
    ],
    Rates: [RATES_HEADER, ...(rates || [rateRow('2026-11', 47.4)])],
    Log: [LOG_HEADER, ...records.map(logRow)],
  };
}

export function teslaSession(startAt, { energyWh = 12000, durationSec = 3600 } = {}) {
  return {
    charge_start_time: { seconds: Math.floor(Date.parse(startAt) / 1000) },
    charge_duration: { seconds: durationSec },
    energy_added_wh: energyWh,
    target_id: 'target-test',
    din: 'din:test',
  };
}

export async function createHarness({ sheets, teslaSessions = [], fuel = fuelPage, tariff = tariffPage, livePowerW = 0 } = {}) {
  const state = { teslaSessions: [...teslaSessions], fuel, tariff, livePowerW };
  const env = createAppsScriptEnv({
    sheets: sheets || defaultSheets(),
    props: {
      SHEET_ID: 'fake-sheet',
      MATCH_WINDOW_MINUTES: '30',
      TESLA_SITE_ID: 'site-1',
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({
          access_token: 'access-1',
          expires_in: 3600,
          refresh_token: 'refresh-2',
        }));
      }
      if (url.indexOf('/api/1/energy_sites/site-1/telemetry_history') !== -1) {
        return response(200, JSON.stringify({
          response: { telemetry_history: state.teslaSessions },
        }));
      }
      if (url.indexOf('/charger_live_status') !== -1) {
        return response(200, JSON.stringify({
          response: {
            wall_connectors: [{
              wall_connector_state: state.livePowerW > 0 ? 1 : 0,
              wall_connector_power: state.livePowerW,
            }],
          },
        }));
      }
      if (url === FUEL_URL) return response(200, state.fuel);
      if (url === TARIFF_URL) return response(200, state.tariff);
      return response(404, '{}');
    },
  });
  env.context.ContentService.MimeType = { JSON: 'application/json' };
  env.run = (source) => vm.runInContext(source, env.context);
  env.run(codeSource);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;
    let result;
    try {
      result = req.method === 'GET'
        ? env.call('doGet', { parameter: Object.fromEntries(url.searchParams.entries()) })
        : env.call('doPost', { postData: { contents: body } });
    } catch (error) {
      result = { getContent: () => JSON.stringify({ ok: false, error: String(error.message || error) }) };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(result.getContent());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    env,
    state,
    apiUrl: `http://127.0.0.1:${port}/api`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let scene = 0;

export async function loadUi({ apiUrl, query }) {
  const dom = new JSDOM(indexHtml, {
    url: `http://127.0.0.1/${query}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;
  window.eval(qrSource);
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: window.document, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
  Object.defineProperty(globalThis, 'URL', { value: window.URL, configurable: true });
  window.APP_CONFIG = { API_URL: apiUrl };
  window.confirm = () => true;
  window.alert = () => {};

  const clipboard = { text: '' };
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async (text) => { clipboard.text = text; } },
    configurable: true,
  });
  const blobs = [];
  window.URL.createObjectURL = (blob) => {
    blobs.push(blob);
    return 'blob:mock';
  };
  window.URL.revokeObjectURL = () => {};
  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.href, download: this.download });
  };

  scene += 1;
  await import(new URL(`../app.js?scene=${scene}`, import.meta.url).href);
  return {
    dom,
    window,
    document: window.document,
    clipboard,
    blobs,
    downloads,
    close() {
      window.close();
    },
  };
}

export async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}
