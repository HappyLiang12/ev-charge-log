export const STORAGE_KEYS = {
  cache: 'ev-charge-log.cache.v1',
  pending: 'ev-charge-log.pending.v1',
};

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const pad2 = (n) => String(n).padStart(2, '0');

export function isValidRecord(value) {
  return Boolean(value)
    && typeof value.id === 'string'
    && ID_RE.test(value.id)
    && typeof value.startAt === 'string'
    && !Number.isNaN(Date.parse(value.startAt));
}

export function normalizeRecords(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isValidRecord).map((record) => ({
    id: record.id,
    startAt: record.startAt,
  }));
}

export function parseServerRecords(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  return normalizeRecords(payload.records);
}

export function formatLocalDate(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function formatLocalTime(iso) {
  const date = new Date(iso);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatWeekday(iso) {
  return WEEKDAYS[new Date(iso).getDay()];
}

export function monthKey(iso) {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
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
  const keys = new Set();
  for (const record of normalizeRecords(records)) keys.add(monthKey(record.startAt));
  return [...keys].sort().reverse();
}

export function defaultMonth(records, now = new Date()) {
  const months = monthsWithRecords(records);
  const current = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  if (months.includes(current)) return current;
  return months[0] || 'all';
}

export function filterByMonth(records, month) {
  const normalized = normalizeRecords(records);
  if (month === 'all') return normalized;
  return normalized.filter((record) => monthKey(record.startAt) === month);
}

export function csvEscape(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(records) {
  const rows = [...normalizeRecords(records)]
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const lines = ['日期,時間'];
  for (const record of rows) {
    lines.push(`${csvEscape(formatLocalDate(record.startAt))},${csvEscape(formatLocalTime(record.startAt))}`);
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

export async function fetchRecords(apiUrl, fetchImpl = fetch) {
  const response = await fetchImpl(apiUrl, { method: 'GET', redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Invalid JSON');
  }
  return parseServerRecords(payload);
}

export async function postRecord(apiUrl, record, fetchImpl = fetch) {
  const body = JSON.stringify({
    id: record.id,
    startAt: record.startAt,
    date: formatLocalDate(record.startAt),
    time: formatLocalTime(record.startAt),
  });
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Invalid JSON');
  }
  if (!payload || payload.ok !== true) {
    throw new Error((payload && payload.error) || 'API error');
  }
}
