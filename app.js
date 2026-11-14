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

if (typeof document !== 'undefined') {
  init();
}

function init() {
  const cfg = window.APP_CONFIG || {};
  const apiUrl = typeof cfg.API_URL === 'string' ? cfg.API_URL.trim() : '';
  const sheetUrl = typeof cfg.SHEET_URL === 'string' ? cfg.SHEET_URL.trim() : '';
  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }

  const els = {
    startBtn: document.getElementById('startBtn'),
    exportBtn: document.getElementById('exportBtn'),
    monthSelect: document.getElementById('monthSelect'),
    statusChip: document.getElementById('statusChip'),
    toast: document.getElementById('toast'),
    summaryMonth: document.getElementById('summaryMonth'),
    summaryTotal: document.getElementById('summaryTotal'),
    summaryLast: document.getElementById('summaryLast'),
    recentList: document.getElementById('recentList'),
    emptyState: document.getElementById('emptyState'),
    emptyHint: document.getElementById('emptyHint'),
    sheetLink: document.getElementById('sheetLink'),
  };

  const state = { server: [], pending: [], offline: false, syncedOnce: false };
  let toastTimer = 0;
  let monthTouched = false;

  const cacheRead = readStored(storage, STORAGE_KEYS.cache);
  const pendingRead = readStored(storage, STORAGE_KEYS.pending);
  if (cacheRead.corrupt) storage?.removeItem(STORAGE_KEYS.cache);
  if (pendingRead.corrupt) storage?.removeItem(STORAGE_KEYS.pending);
  state.server = normalizeRecords(cacheRead.value);
  state.pending = normalizeRecords(pendingRead.value);

  if (sheetUrl) {
    els.sheetLink.href = sheetUrl;
    els.sheetLink.hidden = false;
  }

  els.startBtn.addEventListener('click', onStart);
  els.exportBtn.addEventListener('click', onExport);
  els.monthSelect.addEventListener('change', () => {
    monthTouched = true;
    render();
  });

  window.addEventListener('online', () => {
    state.offline = false;
    void sync();
  });

  render();
  if (cacheRead.corrupt || pendingRead.corrupt) {
    showToast('本機資料損壞，已重新載入');
  }
  void sync();

  function merged() {
    return mergeRecords(state.server, state.pending);
  }

  function persistCache() {
    writeStored(storage, STORAGE_KEYS.cache, state.server);
  }

  function persistPending() {
    writeStored(storage, STORAGE_KEYS.pending, state.pending);
  }

  async function sync() {
    if (!apiUrl) return;
    try {
      const records = await fetchRecords(apiUrl);
      state.server = records;
      state.pending = dropSyncedPending(state.pending, records);
      state.offline = false;
      state.syncedOnce = true;
      persistCache();
      persistPending();
      render();
      await retryPending();
    } catch {
      state.offline = true;
      render();
    }
  }

  async function retryPending() {
    let changed = false;
    for (const record of [...state.pending]) {
      try {
        await postRecord(apiUrl, record);
        state.pending = state.pending.filter((item) => item.id !== record.id);
        state.server = [record, ...state.server];
        changed = true;
      } catch {
        state.offline = true;
        break;
      }
    }
    if (changed) {
      persistCache();
      persistPending();
      render();
    }
  }

  function render() {
    const records = merged();
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
    const monthCount = records.filter((record) => monthKey(record.startAt) === currentMonth).length;

    els.summaryMonth.textContent = String(monthCount);
    els.summaryTotal.textContent = String(records.length);
    els.summaryLast.textContent = records.length
      ? `${formatLocalDate(records[0].startAt)} ${formatLocalTime(records[0].startAt)}`
      : '—';

    let status = '已連接';
    if (!apiUrl) status = '未設定';
    else if (state.pending.length) status = '未同步';
    else if (state.offline) status = '離線';
    else if (!state.syncedOnce) status = '未同步';
    els.statusChip.textContent = status;
    els.statusChip.dataset.state = status === '已連接' ? 'ok' : status === '未設定' ? 'idle' : 'warn';

    els.recentList.replaceChildren(
      ...records.slice(0, 5).map((record) => {
        const li = document.createElement('li');
        const left = document.createElement('span');
        const date = document.createElement('span');
        date.className = 'record-date';
        date.textContent = formatLocalDate(record.startAt);
        const weekday = document.createElement('span');
        weekday.className = 'record-weekday';
        weekday.textContent = formatWeekday(record.startAt);
        left.append(date, weekday);
        const time = document.createElement('span');
        time.className = 'record-time';
        time.textContent = formatLocalTime(record.startAt);
        li.append(left, time);
        return li;
      }),
    );

    els.emptyState.hidden = records.length > 0;
    els.emptyHint.hidden = Boolean(apiUrl);
    els.emptyHint.textContent = apiUrl ? '' : '未設定 Google Sheet；紀錄只會存喺呢部機。';

    const months = monthsWithRecords(records);
    const previous = els.monthSelect.value;
    const options = months.map((month) => ({
      value: month,
      label: `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`,
    }));
    options.push({ value: 'all', label: '全部月份' });
    els.monthSelect.replaceChildren(...options.map((option) => new Option(option.label, option.value)));
    const preferred = monthTouched && previous && options.some((option) => option.value === previous)
      ? previous
      : defaultMonth(records, now);
    els.monthSelect.value = preferred;

    const exportable = filterByMonth(records, preferred);
    els.exportBtn.disabled = exportable.length === 0;
    els.exportBtn.textContent = exportable.length ? `匯出 CSV (${exportable.length})` : '匯出 CSV';
  }

  async function onStart() {
    const records = merged();
    const nowMs = Date.now();
    if (records.length && isRecentDuplicate(records[0].startAt, nowMs)) {
      showToast('啱啱已經記錄咗');
      return;
    }
    const record = { id: crypto.randomUUID(), startAt: new Date(nowMs).toISOString() };
    state.pending = [record, ...state.pending];
    persistPending();
    render();
    showToast(`已記錄 ${formatLocalTime(record.startAt)}`);
    if (!apiUrl) return;
    try {
      await postRecord(apiUrl, record);
      state.pending = state.pending.filter((item) => item.id !== record.id);
      state.server = [record, ...state.server];
      state.offline = false;
      state.syncedOnce = true;
      persistCache();
      persistPending();
      render();
    } catch {
      state.offline = true;
      render();
      showToast('未能同步，會自動重試；請檢查網絡或 API 設定');
    }
  }

  function onExport() {
    const records = merged();
    const month = els.monthSelect.value;
    const filtered = filterByMonth(records, month);
    if (!filtered.length) return;
    const csv = toCsv(filtered);
    const filename = month === 'all' ? 'ev-charge-all.csv' : `ev-charge-${month}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2500);
  }
}
