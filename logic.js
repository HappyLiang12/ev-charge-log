export const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
export const RATES_KEY = 'ev-charge-log.rates.v1';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CAR_RE = /^[a-z0-9-]{1,32}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const SOURCES = new Set(['manual', 'tesla', 'tesla+manual', 'legacy']);

const pad2 = (n) => String(n).padStart(2, '0');
const text = (value) => (typeof value === 'string' ? value : '');
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const numberOrZero = (value) => numberOrNull(value) ?? 0;

function hkDate(iso) {
  return new Date(Date.parse(iso) + HK_OFFSET_MS);
}

export function formatHkDate(iso) {
  const d = hkDate(iso);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatHkTime(iso) {
  const d = hkDate(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatHkWeekday(iso) {
  return WEEKDAYS[hkDate(iso).getUTCDay()];
}

export function monthKey(iso) {
  return formatHkDate(iso).slice(0, 7);
}

export function storageKeys(car) {
  const suffix = car || 'owner';
  return {
    cache: `ev-charge-log.cache.v2.${suffix}`,
    pending: `ev-charge-log.pending.v2.${suffix}`,
  };
}

export function isValidRecord(value) {
  return Boolean(value)
    && typeof value.id === 'string'
    && ID_RE.test(value.id)
    && typeof value.startAt === 'string'
    && !Number.isNaN(Date.parse(value.startAt));
}

function nullableDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function normalizeRecord(value) {
  if (!isValidRecord(value)) return null;
  const car = typeof value.car === 'string' ? value.car : '';
  if (car && car !== 'unassigned' && !CAR_RE.test(car)) return null;
  const source = SOURCES.has(value.source)
    ? value.source
    : (car ? 'manual' : 'legacy');
  return {
    id: value.id,
    car,
    startAt: value.startAt,
    date: DATE_RE.test(text(value.date)) ? value.date : formatHkDate(value.startAt),
    time: TIME_RE.test(text(value.time)) ? value.time : formatHkTime(value.startAt),
    kWh: numberOrNull(value.kWh),
    durationSec: numberOrNull(value.durationSec),
    teslaStartAt: nullableDate(value.teslaStartAt),
    teslaEndAt: nullableDate(value.teslaEndAt),
    peakKWh: numberOrNull(value.peakKWh),
    offPeakKWh: numberOrNull(value.offPeakKWh),
    teslaKey: typeof value.teslaKey === 'string' && value.teslaKey ? value.teslaKey : null,
    source,
  };
}

export function normalizeRecords(list) {
  return Array.isArray(list) ? list.map(normalizeRecord).filter(Boolean) : [];
}

export function normalizeRate(value) {
  if (!value || !MONTH_RE.test(text(value.month))) return null;
  const peakStart = text(value.peakStart) || '16:00';
  const peakEnd = text(value.peakEnd) || '23:00';
  if (!TIME_RE.test(peakStart) || !TIME_RE.test(peakEnd)) return null;
  const basicOffPeak = numberOrNull(value.basicOffPeak);
  const basicPeak = numberOrNull(value.basicPeak);
  const fuelAdjustment = numberOrNull(value.fuelAdjustment);
  if (basicOffPeak === null || basicPeak === null || fuelAdjustment === null) return null;
  return {
    month: value.month,
    basicOffPeak,
    basicPeak,
    fuelAdjustment,
    rebate: numberOrZero(value.rebate),
    peakStart,
    peakEnd,
    sourceUrl: text(value.sourceUrl),
    fetchedAt: text(value.fetchedAt),
    manualOverride: value.manualOverride === true
      || String(value.manualOverride).toUpperCase() === 'TRUE',
  };
}

export function normalizeRates(list) {
  return Array.isArray(list) ? list.map(normalizeRate).filter(Boolean) : [];
}

export function normalizeCar(value) {
  if (!value || !CAR_RE.test(text(value.id)) || !text(value.name).trim()) return null;
  return {
    id: value.id,
    name: text(value.name).trim(),
    active: value.active !== false && String(value.active).toUpperCase() !== 'FALSE',
  };
}

export function normalizeCars(list) {
  return Array.isArray(list) ? list.map(normalizeCar).filter(Boolean) : [];
}

export function parseServerRecords(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  return normalizeRecords(payload.records);
}

export function parseFamilyPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  const car = normalizeCar(payload.car);
  if (!car) throw new Error('Invalid car payload');
  return {
    car,
    records: normalizeRecords(payload.records),
    rates: normalizeRates(payload.rates),
  };
}

export function parseOwnerPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  return {
    cars: normalizeCars(payload.cars),
    records: normalizeRecords(payload.records),
    rates: normalizeRates(payload.rates),
  };
}

function sortNewestFirst(records) {
  return [...records].sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
}

export function mergeRecords(serverRecords, pending) {
  const byId = new Map();
  for (const record of normalizeRecords(serverRecords)) byId.set(record.id, record);
  for (const record of normalizeRecords(pending)) byId.set(record.id, record);
  return sortNewestFirst([...byId.values()]);
}

export function monthsWithRecords(records) {
  return [...new Set(normalizeRecords(records).map((record) => monthKey(record.startAt)))]
    .sort()
    .reverse();
}

export function defaultMonth(records, now = new Date()) {
  const months = monthsWithRecords(records);
  const current = monthKey(now.toISOString());
  if (months.includes(current)) return current;
  return months[0] || 'all';
}

export function filterByMonth(records, month) {
  const normalized = normalizeRecords(records);
  if (month === 'all') return normalized;
  return normalized.filter((record) => monthKey(record.startAt) === month);
}

export function csvEscape(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function selectRate(month, rates) {
  const rows = normalizeRates(rates).slice().sort((a, b) => a.month.localeCompare(b.month));
  const exact = rows.find((row) => row.month === month);
  if (exact) return { rate: exact, fallback: false };
  const earlier = rows.filter((row) => row.month < month).at(-1);
  return earlier ? { rate: earlier, fallback: true } : { rate: null, fallback: false };
}

export function computeCost(record, rate) {
  if (!record || !rate || record.peakKWh === null || record.offPeakKWh === null) return null;
  const rebate = Number(rate.rebate) || 0;
  const offPeakRate = Number(rate.basicOffPeak) + Number(rate.fuelAdjustment) - rebate;
  const peakRate = Number(rate.basicPeak) + Number(rate.fuelAdjustment) - rebate;
  if (![offPeakRate, peakRate].every(Number.isFinite)) return null;
  return (record.offPeakKWh * offPeakRate + record.peakKWh * peakRate) / 100;
}

export function summarizeRecords(records, rates, month = 'all') {
  const filtered = filterByMonth(records, month);
  let kWh = 0;
  let peakKWh = 0;
  let offPeakKWh = 0;
  let cost = 0;
  let matched = 0;
  let pending = 0;
  let missingRate = 0;
  let fallback = false;

  for (const record of filtered) {
    if (record.kWh === null) {
      pending += 1;
      continue;
    }
    matched += 1;
    kWh += record.kWh;
    peakKWh += record.peakKWh || 0;
    offPeakKWh += record.offPeakKWh || 0;
    const picked = selectRate(monthKey(record.teslaStartAt || record.startAt), rates);
    if (!picked.rate) {
      missingRate += 1;
      continue;
    }
    fallback = fallback || picked.fallback;
    const value = computeCost(record, picked.rate);
    if (value === null) {
      missingRate += 1;
      continue;
    }
    cost += value;
  }

  return {
    count: filtered.length,
    matched,
    pending,
    kWh,
    peakKWh,
    offPeakKWh,
    cost: matched > 0 && missingRate === 0 ? cost : null,
    missingRate,
    fallback,
  };
}

export function toCsv(records, { carNames = {}, rates = [] } = {}) {
  const rows = normalizeRecords(records)
    .slice()
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const lines = ['日期,時間,車,kWh,非高峰 kWh,高峰 kWh,估算電費 (HKD),來源'];
  for (const record of rows) {
    const picked = selectRate(monthKey(record.teslaStartAt || record.startAt), rates);
    const cost = picked.rate ? computeCost(record, picked.rate) : null;
    const cells = [
      formatHkDate(record.startAt),
      formatHkTime(record.startAt),
      carNames[record.car] || record.car || '',
      record.kWh === null ? '' : record.kWh.toFixed(2),
      record.offPeakKWh === null ? '' : record.offPeakKWh.toFixed(2),
      record.peakKWh === null ? '' : record.peakKWh.toFixed(2),
      cost === null ? '' : cost.toFixed(2),
      record.source,
    ];
    lines.push(cells.map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function isRecentDuplicate(lastStartAt, nowMs, windowMs = 2000) {
  if (!lastStartAt) return false;
  const last = Date.parse(lastStartAt);
  const delta = nowMs - last;
  return !Number.isNaN(last) && delta >= 0 && delta < windowMs;
}

export function dropSyncedPending(pending, serverRecords) {
  const synced = new Set(normalizeRecords(serverRecords).map((record) => record.id));
  return normalizeRecords(pending).filter((record) => !synced.has(record.id));
}

export function readStored(storage, key) {
  if (!storage) return { value: null, corrupt: false };
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { value: null, corrupt: false };
  }
  if (raw === null || raw === '') return { value: null, corrupt: false };
  try {
    return { value: JSON.parse(raw), corrupt: false };
  } catch {
    return { value: null, corrupt: true };
  }
}

export function writeStored(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
