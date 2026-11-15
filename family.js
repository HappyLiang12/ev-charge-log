import {
  RATES_KEY,
  storageKeys,
  formatHkDate,
  formatHkTime,
  formatHkWeekday,
  monthKey,
  normalizeRecords,
  normalizeRates,
  carIconFor,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  selectRate,
  computeCost,
  summarizeRecords,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
  readStored,
  writeStored,
  migrateLegacyPending,
} from './logic.js';
import {
  fetchFamilyData,
  postRecord,
  deleteRecord,
  syncTesla,
  claimSession,
} from './api.js';
import { renderRateCards } from './rate-view.js';
import { byId, showToast, setStatus, setBusy, friendlyError, appendUnassignedRows } from './ui.js';

function monthLabel(month) {
  if (month === 'all') return '全部月份';
  const [year, value] = month.split('-');
  return `${year} 年 ${Number(value)} 月`;
}

export function initFamily({ apiUrl, carId, autoStart = false }) {
  const storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })();
  const keys = storageKeys(carId);
  const cached = readStored(storage, keys.cache);
  const queued = readStored(storage, keys.pending);
  const cachedRates = readStored(storage, RATES_KEY);
  const legacyPending = readStored(storage, 'ev-charge-log.pending.v1');
  if (cached.corrupt) storage?.removeItem(keys.cache);
  if (queued.corrupt) storage?.removeItem(keys.pending);
  if (cachedRates.corrupt) storage?.removeItem(RATES_KEY);
  if (legacyPending.corrupt) storage?.removeItem('ev-charge-log.pending.v1');

  const state = {
    car: { id: carId, name: carId, active: true },
    server: normalizeRecords(cached.value),
    pending: normalizeRecords(queued.value),
    rates: normalizeRates(cachedRates.value),
    unassigned: [],
    syncedOnce: false,
    connecting: Boolean(apiUrl),
    syncing: false,
    starting: false,
    autoStarted: false,
    claiming: new Set(),
    deleting: new Set(),
    offline: false,
    selectedMonth: null,
    monthTouched: false,
  };

  const els = {
    startBtn: byId('startBtn'),
    syncBtn: byId('syncBtn'),
    status: byId('familyStatus'),
    carName: byId('familyCarName'),
    carHero: byId('familyCarHero'),
    carIcon: byId('familyCarIcon'),
    kwh: byId('familyKwh'),
    cost: byId('familyCost'),
    count: byId('familyCount'),
    split: byId('familySplit'),
    rates: byId('familyRates'),
    unassigned: byId('familyUnassigned'),
    unassignedEmpty: byId('familyUnassignedEmpty'),
    recentList: byId('recentList'),
    empty: byId('familyEmpty'),
    monthSelect: byId('monthSelect'),
    exportBtn: byId('exportBtn'),
    exportHint: byId('exportHint'),
    toast: byId('familyToast'),
  };

  function persist() {
    writeStored(storage, keys.cache, state.server);
    writeStored(storage, keys.pending, state.pending);
    writeStored(storage, RATES_KEY, state.rates);
  }

  if (state.pending.length === 0) {
    const migrated = migrateLegacyPending(legacyPending.value, carId);
    if (migrated.length > 0) {
      state.pending = migrated;
      persist();
      try {
        storage?.removeItem('ev-charge-log.pending.v1');
      } catch {
        // ignore storage failures
      }
    }
  }

  function rateFor(record) {
    return selectRate(monthKey(record.teslaStartAt || record.startAt), state.rates);
  }

  function recordMeta(record) {
    if (record.kWh === null) return { text: '待配對 · —', pending: true };
    const picked = rateFor(record);
    const cost = picked.rate ? computeCost(record, picked.rate) : null;
    return {
      text: `${record.kWh.toFixed(2)} kWh${cost === null ? '' : ` · $${cost.toFixed(2)}`}`,
      pending: false,
    };
  }

  function makeRow(record) {
    const li = document.createElement('li');
    const main = document.createElement('span');
    main.className = 'record-main';
    const date = document.createElement('span');
    date.className = 'record-date';
    date.textContent = formatHkDate(record.startAt);
    const weekday = document.createElement('span');
    weekday.className = 'record-weekday';
    weekday.textContent = formatHkWeekday(record.startAt);
    date.append(weekday);
    const info = recordMeta(record);
    const meta = document.createElement('span');
    meta.className = info.pending ? 'record-meta pending' : 'record-meta';
    meta.textContent = info.text;
    main.append(date, meta);

    const right = document.createElement('span');
    right.className = 'record-right';
    const time = document.createElement('span');
    time.className = 'record-time';
    time.textContent = formatHkTime(record.startAt);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'delete-btn';
    const deleting = state.deleting.has(record.id);
    remove.classList.toggle('loading', deleting);
    remove.disabled = deleting;
    remove.textContent = deleting ? '' : '×';
    remove.setAttribute('aria-busy', deleting ? 'true' : 'false');
    remove.setAttribute(
      'aria-label',
      deleting
        ? '刪除中…'
        : `刪除 ${formatHkDate(record.startAt)} ${formatHkTime(record.startAt)} 紀錄`,
    );
    remove.addEventListener('click', () => onDelete(record));
    right.append(time, remove);
    li.append(main, right);
    return li;
  }

  function makeUnassignedRow(record) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'owner-row-head';
    const when = document.createElement('span');
    when.textContent = `${formatHkDate(record.startAt)} ${formatHkTime(record.startAt)}`;
    const kwh = document.createElement('strong');
    kwh.textContent = record.kWh === null ? '—' : `${record.kWh.toFixed(2)} kWh`;
    head.append(when, kwh);

    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    const duration = record.durationSec ? `${Math.round(record.durationSec / 60)} 分鐘` : '—';
    meta.textContent = `充電樁紀錄 · ${duration} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh`;

    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    const claim = document.createElement('button');
    claim.type = 'button';
    const busy = state.claiming.has(record.id);
    claim.disabled = busy;
    claim.textContent = busy ? '認領中…' : '認領';
    claim.setAttribute(
      'aria-label',
      `認領 ${formatHkDate(record.startAt)} ${formatHkTime(record.startAt)} 的充電樁紀錄`,
    );
    claim.addEventListener('click', () => { void onClaim(record); });
    actions.append(claim);
    li.append(head, meta, actions);
    return li;
  }

  function render() {
    els.carName.textContent = state.car.name || carId;
    const icon = carIconFor(state.car);
    if (icon) {
      els.carIcon.src = icon;
      els.carIcon.alt = state.car.name || '';
      els.carHero.hidden = false;
    } else {
      els.carIcon.removeAttribute('src');
      els.carIcon.alt = '';
      els.carHero.hidden = true;
    }
    els.syncBtn.hidden = !apiUrl;
    const status = !apiUrl
      ? '未設定'
      : state.connecting || state.syncing
        ? '連線中'
        : state.offline
          ? '離線'
          : state.pending.length > 0 || !state.syncedOnce
            ? '未同步'
            : '已連接';
    setStatus(els.status, status);
    setBusy(els.startBtn, state.starting, '儲存中…', '⚡ 開始充電');
    setBusy(els.syncBtn, state.syncing || !apiUrl, '更新中…', '更新充電樁');

    const records = mergeRecords(state.server, state.pending);
    const current = monthKey(new Date().toISOString());
    const summary = summarizeRecords(records, state.rates, current);
    els.kwh.textContent = summary.matched > 0 ? summary.kWh.toFixed(1) : '0';
    els.cost.textContent = summary.cost === null ? '—' : `$${summary.cost.toFixed(2)}`;
    els.count.textContent = String(summary.count);
    els.split.textContent = summary.matched > 0
      ? `非高峰 ${summary.offPeakKWh.toFixed(1)} kWh · 高峰 ${summary.peakKWh.toFixed(1)} kWh（按時段比例估算）`
      : '本月未有已配對嘅充電 session。';

    const picked = selectRate(current, state.rates);
    renderRateCards(els.rates, state.rates, picked.rate ? '本月費率未在列表中。' : '未設定本月費率；請確認本月費率。');

    const months = monthsWithRecords(records);
    const options = ['all', ...months];
    const selected = state.monthTouched && options.includes(state.selectedMonth)
      ? state.selectedMonth
      : defaultMonth(records, new Date());
    els.monthSelect.replaceChildren();
    for (const month of options) {
      const option = document.createElement('option');
      option.value = month;
      option.textContent = monthLabel(month);
      els.monthSelect.append(option);
    }
    els.monthSelect.value = options.includes(selected) ? selected : 'all';
    const selectedRecords = filterByMonth(records, els.monthSelect.value);
    els.exportBtn.disabled = selectedRecords.length === 0;
    els.exportHint.textContent = selectedRecords.length > 0
      ? `${selectedRecords.length} 筆紀錄；Excel 可直接開啟。`
      : '所選月份未有紀錄。';

    els.recentList.replaceChildren();
    for (const record of records.slice(0, 5)) els.recentList.append(makeRow(record));
    els.empty.hidden = records.length > 0;
    els.empty.textContent = apiUrl ? '未有紀錄。' : '未設定 Google Sheet；紀錄只會存喺呢部機。';

    els.unassigned.replaceChildren();
    appendUnassignedRows(els.unassigned, state.unassigned, makeUnassignedRow);
    els.unassignedEmpty.hidden = state.unassigned.length > 0;
    els.unassignedEmpty.textContent = apiUrl ? '冇未配對充電樁紀錄。' : '未設定 Google Sheet。';
  }

  async function retryPending() {
    if (!apiUrl || state.pending.length === 0) return;
    let changed = false;
    for (const record of [...state.pending]) {
      try {
        await postRecord(apiUrl, record, carId);
        state.pending = state.pending.filter((row) => row.id !== record.id);
        state.server = [record, ...state.server];
        changed = true;
      } catch {
        state.offline = true;
        break;
      }
    }
    if (changed) persist();
  }

  async function fetchData() {
    const data = await fetchFamilyData(apiUrl, carId);
    if (data.car.active === false) throw new Error('inactive car');
    state.server = data.records.filter((record) => !state.deleting.has(record.id));
    state.car = data.car;
    state.rates = data.rates;
    state.unassigned = mergeRecords(data.unassigned, []);
    state.pending = dropSyncedPending(state.pending, state.server);
    state.offline = false;
    state.syncedOnce = true;
    await retryPending();
    persist();
    render();
  }

  async function runSync(auto) {
    if (!apiUrl || state.syncing) return;
    state.syncing = true;
    render();
    try {
      const result = await syncTesla(apiUrl, { car: carId });
      await fetchData();
      if (!auto) {
        const matched = Number(result.matched) || 0;
        showToast(els.toast, matched > 0 ? `已配對 ${matched} 個充電 session。` : '冇新嘅充電 session。');
      }
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '充電樁同步失敗，請檢查網絡後重試。'));
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function load() {
    render();
    if (!apiUrl) {
      await maybeAutoStart();
      return;
    }
    state.connecting = true;
    render();
    try {
      await fetchData();
      state.connecting = false;
      render();
      await maybeAutoStart();
      if (!state.offline) void runSync(true);
    } catch (error) {
      state.offline = true;
      state.connecting = false;
      render();
      showToast(els.toast, friendlyError(error, '未能連接，請檢查網絡後重試。'));
      await maybeAutoStart();
    }
  }

  async function maybeAutoStart() {
    if (!autoStart || state.autoStarted) return;
    state.autoStarted = true;
    await onStart();
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('start')) {
        url.searchParams.delete('start');
        window.history.replaceState(null, '', url.toString());
      }
    } catch {
      // History replacement is best-effort; the record is already queued or saved.
    }
  }

  async function onStart() {
    if (state.starting) return;
    const startAt = new Date().toISOString();
    const records = mergeRecords(state.server, state.pending);
    if (isRecentDuplicate(records[0]?.startAt, Date.now())) {
      showToast(els.toast, '已經記錄咗，請稍等 2 秒再試。');
      return;
    }
    const record = {
      id: crypto.randomUUID(),
      car: carId,
      startAt,
      date: formatHkDate(startAt),
      time: formatHkTime(startAt),
      kWh: null,
      durationSec: null,
      teslaStartAt: null,
      teslaEndAt: null,
      peakKWh: null,
      offPeakKWh: null,
      teslaKey: null,
      source: 'manual',
    };
    state.starting = true;
    state.pending = [record, ...state.pending];
    persist();
    render();
    showToast(els.toast, '已記錄開始時間。');
    if (!apiUrl) {
      state.starting = false;
      render();
      return;
    }
    try {
      await postRecord(apiUrl, record, carId);
      state.pending = state.pending.filter((row) => row.id !== record.id);
      state.server = [record, ...state.server];
      persist();
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '已喺本機記錄；暫時未能同步，會自動重試。'));
    } finally {
      state.starting = false;
      render();
    }
  }

  async function onDelete(record) {
    const message = record.teslaKey
      ? '刪除呢筆紀錄？充電樁紀錄亦會被忽略，之後唔會再自動匯入。'
      : '刪除呢筆紀錄？';
    if (!window.confirm(message)) return;
    state.deleting.add(record.id);
    render();
    try {
      const localOnly = state.pending.some((row) => row.id === record.id);
      if (apiUrl && !localOnly) await deleteRecord(apiUrl, record.id, { car: carId });
      state.pending = state.pending.filter((row) => row.id !== record.id);
      state.server = state.server.filter((row) => row.id !== record.id);
      persist();
      render();
      showToast(els.toast, '已刪除。');
    } catch (error) {
      state.offline = true;
      render();
      showToast(els.toast, friendlyError(error, '刪除失敗，請檢查網絡後重試。'));
    } finally {
      state.deleting.delete(record.id);
      render();
    }
  }

  async function onClaim(record) {
    if (!apiUrl || state.claiming.has(record.id)) return;
    state.claiming.add(record.id);
    render();
    try {
      await claimSession(apiUrl, carId, record.id);
      await fetchData();
      showToast(els.toast, '已認領。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '認領失敗，請檢查網絡後重試。'));
    } finally {
      state.claiming.delete(record.id);
      render();
    }
  }

  function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onExport() {
    const records = mergeRecords(state.server, state.pending);
    const month = els.monthSelect.value || 'all';
    const selected = filterByMonth(records, month);
    if (selected.length === 0) return;
    downloadCsv(
      toCsv(selected, {
        carNames: { [carId]: state.car.name || carId },
        rates: state.rates,
      }),
      `ev-charge-${carId}-${month}.csv`,
    );
    showToast(els.toast, 'CSV 已下載。');
  }

  els.startBtn.addEventListener('click', onStart);
  els.syncBtn.addEventListener('click', () => { void runSync(false); });
  els.exportBtn.addEventListener('click', onExport);
  els.monthSelect.addEventListener('change', () => {
    state.monthTouched = true;
    state.selectedMonth = els.monthSelect.value;
    render();
  });
  window.addEventListener('online', () => {
    if (!apiUrl) return;
    state.offline = false;
    void load();
  });

  if (cached.corrupt || queued.corrupt) showToast(els.toast, '本機紀錄格式有誤，已忽略。');
  if (cachedRates.corrupt) showToast(els.toast, '費率快取格式有誤，已忽略。');
  void load();
}
