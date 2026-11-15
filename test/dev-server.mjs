import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const port = Number(process.env.PORT || 8787);
const apiUrl = process.env.SMOKE_API_URL || `http://127.0.0.1:${port}/api`;
const delayMs = Number(process.env.SMOKE_DELAY_MS || 0);
const keepPending = process.env.SMOKE_KEEP_PENDING === '1';
const cars = [
  { id: 'model3', name: 'Model 3', active: true },
  { id: 'leaf', name: 'Leaf', active: true },
];
const rates = [{
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
}];
const records = [
  {
    id: 'seed-1',
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
    teslaKey: 'mock:seed-1',
    source: 'tesla+manual',
  },
  {
    id: 'seed-unassigned',
    car: 'unassigned',
    startAt: '2026-11-13T02:00:00.000Z',
    date: '2026-11-13',
    time: '10:00',
    kWh: 12,
    durationSec: 3600,
    teslaStartAt: '2026-11-13T02:00:00.000Z',
    teslaEndAt: '2026-11-13T03:00:00.000Z',
    peakKWh: 0,
    offPeakKWh: 12,
    teslaKey: 'mock:unassigned',
    source: 'tesla',
  },
  {
    id: 'seed-pending',
    car: 'model3',
    startAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    date: '',
    time: '',
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
    source: 'manual',
  },
];
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function findCar(id) {
  return cars.find((car) => car.id === id);
}

function splitMock(startAt, durationSec, kwh) {
  const start = Date.parse(startAt);
  const end = start + durationSec * 1000;
  const hkStart = new Date(start + 8 * 3600 * 1000);
  const hkEnd = new Date(end + 8 * 3600 * 1000);
  const startMinutes = hkStart.getUTCHours() * 60 + hkStart.getUTCMinutes();
  const endMinutes = hkEnd.getUTCHours() * 60 + hkEnd.getUTCMinutes();
  const peakSeconds = Math.max(0, Math.min(endMinutes, 23 * 60) - Math.max(startMinutes, 16 * 60)) * 60;
  const total = Math.max(1, durationSec);
  const peakKWh = Math.round((kwh * Math.min(peakSeconds, total) / total) * 1e6) / 1e6;
  return { peakKWh, offPeakKWh: Math.round((kwh - peakKWh) * 1e6) / 1e6 };
}

function matchPending(car) {
  const pending = [...records].reverse().find((record) => (
    record.car === car.id && record.source === 'manual' && record.kWh === null
  ));
  if (!pending) return false;
  const start = Date.parse(pending.startAt);
  pending.kWh = 20;
  pending.durationSec = 7200;
  pending.teslaStartAt = pending.startAt;
  pending.teslaEndAt = new Date(start + 7200000).toISOString();
  if (pending.id === 'seed-pending') {
    const split = splitMock(pending.startAt, 7200, 20);
    pending.peakKWh = split.peakKWh;
    pending.offPeakKWh = split.offPeakKWh;
  } else {
    // The family smoke uses a fixed 10/10 split so the expected cost is stable at any run time.
    pending.peakKWh = 10;
    pending.offPeakKWh = 10;
  }
  pending.teslaKey = `mock:${pending.id}`;
  pending.source = 'tesla+manual';
  return true;
}

function assignMock(target, car) {
  if (!target || target.car !== 'unassigned' || !car) return false;
  const targetStart = Date.parse(target.teslaStartAt || target.startAt);
  const manual = records.find((record) => (
    record.id !== target.id
    && record.car === car.id
    && record.source === 'manual'
    && record.kWh === null
    && Math.abs(Date.parse(record.startAt) - targetStart) <= 1800000
  ));
  if (manual) {
    manual.kWh = target.kWh;
    manual.durationSec = target.durationSec;
    manual.teslaStartAt = target.teslaStartAt;
    manual.teslaEndAt = target.teslaEndAt;
    manual.peakKWh = target.peakKWh;
    manual.offPeakKWh = target.offPeakKWh;
    manual.teslaKey = target.teslaKey;
    manual.source = 'tesla+manual';
    const index = records.indexOf(target);
    if (index >= 0) records.splice(index, 1);
    return true;
  }
  target.car = car.id;
  target.source = 'tesla';
  return true;
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  const requested = req.url.split('?')[0] || '/';
  if (requested === '/api') {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET') {
      if (url.searchParams.has('status')) {
        return sendJson(res, 200, {
          ok: true,
          charging: true,
          powerW: 7200,
          energyWh: null,
          state: '1',
          available: true,
          sampledAt: new Date().toISOString(),
        });
      }
      if (url.searchParams.has('owner')) {
        return sendJson(res, 200, {
          ok: true,
          cars,
          records,
          rates,
          sheetUrl: 'https://docs.google.com/spreadsheets/d/mock/edit',
        });
      }
      const carId = url.searchParams.get('car');
      const car = findCar(carId);
      if (!car) return fail(res, 404, 'Unknown car');
      const visible = records.filter((record) => record.car === carId);
      const unassigned = records.filter((record) => record.car === 'unassigned');
      return sendJson(res, 200, { ok: true, car, records: visible, unassigned, rates });
    }
    if (req.method === 'POST') {
      let data;
      try {
        data = await readBody(req);
      } catch {
        return fail(res, 400, 'Invalid payload');
      }
      const action = String(data.action || 'append');
      if (action === 'append') {
        if (!data.id || !findCar(data.car) || !data.startAt) return fail(res, 400, 'Invalid record');
        if (!records.some((record) => record.id === data.id)) {
          records.push({
            id: data.id,
            car: data.car,
            startAt: data.startAt,
            date: data.date,
            time: data.time,
            kWh: null,
            durationSec: null,
            teslaStartAt: null,
            teslaEndAt: null,
            peakKWh: null,
            offPeakKWh: null,
            teslaKey: null,
            source: 'manual',
          });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'delete') {
        const car = findCar(data.car);
        if (!car) return fail(res, 404, 'Unknown car');
        const index = records.findIndex((record) => record.id === data.id);
        if (index < 0) return sendJson(res, 200, { ok: true, deleted: false, released: false });
        if (records[index].car !== car.id) return fail(res, 400, 'Record does not belong to this car');
        const target = records[index];
        if (target.teslaKey) {
          target.car = 'unassigned';
          target.source = 'tesla';
          target.startAt = target.teslaStartAt || target.startAt;
          return sendJson(res, 200, { ok: true, deleted: true, released: true, record: target });
        }
        records.splice(index, 1);
        return sendJson(res, 200, { ok: true, deleted: true, released: false });
      }
      if (action === 'sync') {
        if (keepPending) return sendJson(res, 200, { ok: true, matched: 0, unassigned: 0 });
        if (data.car === undefined) {
          let matched = 0;
          for (const car of cars) if (matchPending(car)) matched += 1;
          return sendJson(res, 200, { ok: true, matched, unassigned: 0 });
        }
        const car = findCar(data.car);
        if (!car) return fail(res, 404, 'Unknown car');
        const matched = matchPending(car) ? 1 : 0;
        return sendJson(res, 200, { ok: true, matched, unassigned: 0 });
      }
      if (action === 'assign') {
        const target = records.find((record) => record.id === data.id);
        const car = findCar(data.car);
        if (!target || !car || target.car !== 'unassigned') return fail(res, 400, 'Invalid assignment');
        assignMock(target, car);
        return sendJson(res, 200, { ok: true, assigned: true });
      }
      if (action === 'claim') {
        const target = records.find((record) => record.id === data.id);
        const car = findCar(data.car);
        if (!target || !car || target.car !== 'unassigned') return fail(res, 400, 'Invalid claim');
        assignMock(target, car);
        return sendJson(res, 200, { ok: true, assigned: true });
      }
      if (action === 'refreshRates') {
        rates[0].fetchedAt = new Date().toISOString();
        return sendJson(res, 200, { ok: true, updated: rates.length });
      }
      return fail(res, 400, 'Invalid action');
    }
  }

  const path = requested === '/' ? '/index.html' : requested;
  if (path === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end(`window.APP_CONFIG = { API_URL: '${apiUrl}' };\n`);
    return;
  }

  try {
    const filePath = normalize(join(root, path));
    if (!filePath.startsWith(`${root}/`)) throw new Error('forbidden');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${port}`);
  console.log(`mock API:  ${apiUrl}`);
});
