import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiGet,
  apiPost,
  fetchFamilyData,
  fetchOwnerData,
  postRecord,
  deleteRecord,
  syncTesla,
  assignSession,
  ignoreSession,
  refreshRates,
  claimSession,
} from '../api.js';

const base = 'https://example.test/api';
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
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});
const captureFetch = (body, captured) => async (url, init) => {
  captured.url = url;
  captured.init = init;
  return response(body);
};

test('fetchFamilyData sends the car query and parses the payload', async () => {
  const captured = {};
  const unassigned = { ...record, id: 'u1', car: 'unassigned', source: 'tesla' };
  const data = await fetchFamilyData(base, 'model3', captureFetch({
    ok: true,
    car: { id: 'model3', name: 'Model 3', active: true },
    records: [record],
    unassigned: [unassigned],
    rates: [rate],
  }, captured));
  assert.match(captured.url, /^https:\/\/example\.test\/api\?car=model3$/);
  assert.equal(captured.init.method, 'GET');
  assert.equal(data.car.name, 'Model 3');
  assert.equal(data.records[0].id, 'rec-1');
  assert.equal(data.unassigned[0].id, 'u1');
  assert.equal(data.rates[0].month, '2026-11');
});

test('fetchOwnerData sends the owner mode flag and parses all cars', async () => {
  const captured = {};
  const data = await fetchOwnerData(base, captureFetch({
    ok: true,
    cars: [{ id: 'model3', name: 'Model 3', active: true }],
    records: [record],
    rates: [rate],
  }, captured));
  assert.match(captured.url, /^https:\/\/example\.test\/api\?owner=1$/);
  assert.equal(data.cars.length, 1);
  assert.equal(data.records[0].car, 'model3');
});

test('postRecord sends car, startAt, and Hong Kong date/time as text/plain', async () => {
  const captured = {};
  await postRecord(base, record, 'model3', captureFetch({ ok: true }, captured));
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(captured.init.body), {
    id: 'rec-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
  });
});

test('deleteRecord sends the family car scope', async () => {
  const family = {};
  await deleteRecord(base, 'rec-1', { car: 'model3' }, captureFetch({ ok: true }, family));
  assert.deepEqual(JSON.parse(family.init.body), { action: 'delete', id: 'rec-1', car: 'model3' });
});

test('syncTesla, assignSession, ignoreSession, refreshRates, and claimSession send their actions', async () => {
  const sync = {};
  await syncTesla(base, { car: 'model3' }, captureFetch({ ok: true }, sync));
  assert.deepEqual(JSON.parse(sync.init.body), { action: 'sync', car: 'model3' });

  const assign = {};
  await assignSession(base, 'rec-1', 'leaf', captureFetch({ ok: true }, assign));
  assert.deepEqual(JSON.parse(assign.init.body), { action: 'assign', id: 'rec-1', car: 'leaf' });

  const ignore = {};
  await ignoreSession(base, 'rec-1', captureFetch({ ok: true }, ignore));
  assert.deepEqual(JSON.parse(ignore.init.body), { action: 'ignore', id: 'rec-1' });

  const claim = {};
  await claimSession(base, 'leaf', 'unassigned-1', captureFetch({ ok: true }, claim));
  assert.deepEqual(JSON.parse(claim.init.body), { action: 'claim', car: 'leaf', id: 'unassigned-1' });

  const rates = {};
  await refreshRates(base, captureFetch({ ok: true }, rates));
  assert.deepEqual(JSON.parse(rates.init.body), { action: 'refreshRates' });
});

test('apiGet and apiPost reject HTTP and API-level errors', async () => {
  await assert.rejects(
    apiGet(base, { car: 'model3' }, async () => response(null, { ok: false, status: 500 })),
    /HTTP 500/,
  );
  await assert.rejects(
    apiGet(base, { car: 'model3' }, async () => response({ ok: false, error: 'nope' })),
    /nope/,
  );
  await assert.rejects(
    apiPost(base, { action: 'x' }, async () => response({ ok: false, error: 'bad' })),
    /bad/,
  );
});
