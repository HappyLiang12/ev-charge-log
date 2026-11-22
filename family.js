import {
  RATES_KEY,
  storageKeys,
  formatHkDate,
  formatHkTime,
  formatHkTime12,
  sessionEndIso,
  formatHkWeekday,
  monthKey,
  normalizeRecords,
  normalizeRates,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  recentRecords,
  billPeriodValue,
  filterByPeriod,
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
  fetchLatestSnapshotImage,
  postRecord,
  deleteRecord,
  syncTesla,
  claimSession,
  liveClaim,
  reassignSession,
} from './api.js';
import { createRecordPhoto } from './record-photo.js';
import { startSnapshotPolling } from './snapshot.js';
import { renderRateCards } from './rate-view.js';
import { normalizeBillShares } from './bill.js';
import { byId, showToast, setStatus, setBusy, friendlyError, appendPendingRows } from './ui.js';
import { startChargerLive } from './live.js';

function periodLabel(value, bills) {
  if (value === 'all') return '全部月份';
  if (String(value).startsWith('bill:')) {
    const bill = (bills || []).find((item) => billPeriodValue(item) === value);
    return bill ? `帳單 ${bill.periodStart} – ${bill.periodEnd}` : '帳單期';
  }
  const [year, month] = value.split('-');
  return `${year} 年 ${Number(month)} 月`;
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
    cars: [],
    coverage: null,
    server: normalizeRecords(cached.value),
    pending: normalizeRecords(queued.value),
    rates: normalizeRates(cachedRates.value),
    bills: [],
    unassigned: [],
    live: null,
    lastLiveCharging: false,
    updatedAt: '',
    loadError: '',
    lastFetchAt: 0,
    claimAttempted: false,
    claimError: '',
    syncedOnce: false,
    connecting: Boolean(apiUrl),
    syncing: false,
    recentLimit: 5,
    starting: false,
    autoStarted: false,
    claiming: new Set(),
    deleting: new Set(),
    reassigning: new Set(),
    openUnassigned: new Set(),
    offline: false,
    selectedMonth: null,
    monthTouched: false,
  };

  let renderedSnapshotId = '';

  const els = {
    startBtn: byId('startBtn'),
    startHint: byId('familyStartHint'),
    startHintText: byId('familyStartHintText'),
    startCancel: byId('familyStartCancel'),
    errorBanner: byId('familyError'),
    errorText: byId('familyErrorText'),
    errorRetry: byId('familyErrorRetry'),
    updatedAt: byId('familyUpdatedAt'),
    status: byId('familyStatus'),
    carName: byId('familyCarName'),
    kwh: byId('familyKwh'),
    cost: byId('familyCost'),
    count: byId('familyCount'),
    split: byId('familySplit'),
    rates: byId('familyRates'),
    livePanel: byId('familyLivePanel'),
    liveState: byId('familyLiveState'),
    livePower: byId('familyLivePower'),
    liveSample: byId('familyLiveSample'),
    unassigned: byId('familyUnassigned'),
    unassignedEmpty: byId('familyUnassignedEmpty'),
    liveHint: byId('familyLiveHint'),
    snapshotPanel: byId('familySnapshotPanel'),
    snapshotImg: byId('familySnapshotImg'),
    snapshotTime: byId('familySnapshotTime'),
    snapshotWarning: byId('familySnapshotWarning'),
    snapshotHint: byId('familySnapshotHint'),
    bills: byId('familyBills'),
    billsPanel: byId('familyBillsPanel'),
    recentList: byId('recentList'),
    more: byId('familyMore'),
    syncNow: byId('familySyncNow'),
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
    if (record.kWh === null) {
      return {
        text: record.source === 'live'
          ? '已自動認領 · 等待充電完成'
          : '已記錄開始 · 等待充電完成',
        pending: true,
      };
    }
    const picked = rateFor(record);
    const cost = picked.rate ? computeCost(record, picked.rate) : null;
    return {
      text: `${record.kWh.toFixed(2)} kWh${cost === null ? '' : ` · $${cost.toFixed(2)}`}`,
      pending: false,
    };
  }

  function pendingStartRecord(records) {
    return records.find((record) => (
      record.car === carId && (record.source === 'manual' || record.source === 'live')
        && record.kWh === null && !record.teslaKey
    )) || null;
  }

  function buildRecordActions(record, close) {
    if (record.car === 'unassigned') {
      const claim = document.createElement('button');
      claim.type = 'button';
      claim.className = 'secondary';
      claim.textContent = '認領呢個時段';
      claim.addEventListener('click', () => { close(); void onClaim(record); });
      return [claim];
    }
    const others = state.cars.filter((car) => car.active && car.id !== record.car);
    if (!others.length) return [];
    const picker = document.createElement('select');
    picker.setAttribute('aria-label', '改派車輛');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '改派到…';
    picker.append(placeholder);
    for (const car of others) {
      const option = document.createElement('option');
      option.value = car.id;
      option.textContent = car.name;
      picker.append(option);
    }
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'secondary';
    move.textContent = '改派';
    move.addEventListener('click', () => {
      const car = picker.value;
      if (!car) {
        showToast(els.toast, '請先選擇車輛。');
        return;
      }
      close();
      void onReassign(record, car);
    });
    const release = document.createElement('button');
    release.type = 'button';
    release.className = 'secondary';
    release.textContent = '放回未配對';
    release.addEventListener('click', () => { close(); void onDelete(record); });
    return [picker, move, release];
  }

  function makeRow(record) {
    const li = document.createElement('li');
    const photo = createRecordPhoto({
      apiUrl,
      record,
      when: `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`,
      buildActions: (close) => buildRecordActions(record, close),
      coverage: state.coverage,
    });
    if (photo) li.append(photo);
    const content = document.createElement('div');
    content.className = 'record-content';
    const head = document.createElement('div');
    head.className = 'record-head';
    const date = document.createElement('span');
    date.className = 'record-date';
    date.textContent = formatHkDate(record.startAt);
    const weekday = document.createElement('span');
    weekday.className = 'record-weekday';
    weekday.textContent = formatHkWeekday(record.startAt);
    date.append(weekday);
    const time = document.createElement('span');
    time.className = 'record-time';
    time.textContent = formatHkTime12(record.startAt);
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
        : `刪除 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} 紀錄`,
    );
    remove.addEventListener('click', () => onDelete(record));
    head.append(date, time, remove);
    const info = recordMeta(record);
    const meta = document.createElement('span');
    meta.className = info.pending ? 'record-meta pending' : 'record-meta';
    meta.textContent = info.text;
    const body = document.createElement('div');
    body.className = 'record-body';
    body.append(meta);
    const endIso = sessionEndIso(record);
    if (endIso) {
      const end = document.createElement('span');
      end.className = 'record-end';
      const sameDay = formatHkDate(endIso) === formatHkDate(record.startAt);
      end.textContent = sameDay
        ? `至 ${formatHkTime12(endIso)}`
        : `至 ${formatHkDate(endIso).slice(5)} ${formatHkTime12(endIso)}`;
      body.append(end);
    }
    content.append(head, body);
    li.append(content);
    return li;
  }

  function makeUnassignedRow(record) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'owner-row-head';
    const when = document.createElement('span');
    when.textContent = `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`;
    const kwh = document.createElement('strong');
    kwh.textContent = record.kWh === null ? '—' : `${record.kWh.toFixed(2)} kWh`;
    head.append(when, kwh);
    const photo = createRecordPhoto({
      apiUrl,
      record,
      when: `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`,
      buildActions: (close) => buildRecordActions(record, close),
      coverage: state.coverage,
    });
    if (photo) head.prepend(photo);

    const manual = !record.teslaKey;
    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    const duration = record.durationSec ? `${Math.round(record.durationSec / 60)} 分鐘` : '—';
    const end = sessionEndIso(record);
    const endLabel = end ? `${formatHkDate(end)} ${formatHkTime12(end)}` : '—';
    meta.textContent = manual
      ? `開始 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} · 手動開始，未能配對充電樁`
      : `結束 ${endLabel} · 充電樁紀錄 · ${duration} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh`;

    if (manual) {
      const note = document.createElement('span');
      note.className = 'suggestion-label';
      note.textContent = '手動開始紀錄，未能配對充電樁；如需更正請聯絡車主。';
      li.append(head, meta, note);
      return li;
    }

    let hint = null;
    if (record.suggestedCar === state.car.id && record.suggestionStatus === 'matched') {
      hint = document.createElement('span');
      hint.className = 'suggestion-label';
      const percent = record.suggestionConfidence > 0
        ? Math.round(record.suggestionConfidence * 100)
        : 0;
      hint.textContent = percent > 0
        ? `系統建議係你（${percent}%），請認領`
        : '系統建議係你，請認領';
    }

    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    const claim = document.createElement('button');
    claim.type = 'button';
    const busy = state.claiming.has(record.id);
    claim.disabled = busy;
    claim.textContent = busy ? '認領中…' : '認領';
    claim.setAttribute(
      'aria-label',
      `認領 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} 的充電樁紀錄`,
    );
    claim.addEventListener('click', () => { void onClaim(record); });
    actions.append(claim);
    li.append(head, meta);
    if (hint) li.append(hint);
    li.append(actions);
    return li;
  }

  function makeBillShareCard(bill) {
    const card = document.createElement('div');
    card.className = 'bill-card';
    const head = document.createElement('div');
    head.className = 'owner-card-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = `${bill.periodStart} – ${bill.periodEnd}`;
    const amount = document.createElement('span');
    amount.className = 'owner-card-total';
    amount.textContent = bill.myKWh > 0 ? `應付 $${bill.myAmount.toFixed(2)}` : '此期未有紀錄';
    head.append(title, amount);
    const meta = document.createElement('p');
    meta.className = 'hint';
    meta.textContent = bill.myKWh > 0
      ? `帳單 $${bill.total.toFixed(2)} · 你 ${bill.myKWh.toFixed(1)} 度 · 佔 ${(bill.myShare * 100).toFixed(1)}%`
      : `帳單 $${bill.total.toFixed(2)} · 此帳單期未有你嘅紀錄`;
    card.append(head, meta);
    return card;
  }

  function render() {
    els.carName.textContent = state.car.name || carId;
    const status = !apiUrl
      ? '未設定'
      : state.connecting
        ? '連線中'
        : state.loadError
          ? '錯誤'
          : state.offline
            ? '離線'
            : state.pending.length > 0 || !state.syncedOnce
              ? '未同步'
              : '已連接';
    setStatus(els.status, status);
    els.errorBanner.hidden = !state.loadError;
    els.errorText.textContent = state.loadError || '';
    els.updatedAt.textContent = state.updatedAt ? `資料更新於 ${formatHkTime12(state.updatedAt)}` : '';
    setBusy(els.syncNow, state.syncing || !apiUrl, '更新中…', '更新');
    const records = mergeRecords(state.server, state.pending);
    const pendingStart = pendingStartRecord(records);
    updateStartButton(pendingStart);

    const bills = state.bills;
    const months = monthsWithRecords(records);
    const billOptions = bills.map((bill) => billPeriodValue(bill));
    const options = ['all', ...billOptions, ...months];
    const fallback = billOptions.length > 0 ? billOptions[0] : defaultMonth(records, new Date());
    const selected = state.monthTouched && options.includes(state.selectedMonth)
      ? state.selectedMonth
      : fallback;
    els.monthSelect.replaceChildren();
    for (const value of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = periodLabel(value, bills);
      els.monthSelect.append(option);
    }
    els.monthSelect.value = options.includes(selected) ? selected : 'all';
    state.selectedMonth = els.monthSelect.value;
    const selectedValue = els.monthSelect.value;
    const periodRecords = filterByPeriod(records, selectedValue, bills);
    const summary = summarizeRecords(periodRecords, state.rates, 'all');
    els.kwh.textContent = summary.matched > 0 ? summary.kWh.toFixed(1) : '0';
    els.cost.textContent = summary.cost === null ? '—' : `$${summary.cost.toFixed(2)}`;
    els.count.textContent = String(summary.count);
    els.split.textContent = summary.matched > 0
      ? `非高峰 ${summary.offPeakKWh.toFixed(1)} kWh · 高峰 ${summary.peakKWh.toFixed(1)} kWh（按時段及車輛習慣估算）`
      : '所選期間未有已配對嘅充電時段。';

    const current = monthKey(new Date().toISOString());
    const picked = selectRate(current, state.rates);
    renderRateCards(els.rates, state.rates, picked.rate ? '本月費率未在列表中。' : '未設定本月費率；請確認本月費率。');

    els.exportBtn.disabled = periodRecords.length === 0;
    els.exportHint.textContent = periodRecords.length > 0
      ? `${periodRecords.length} 筆紀錄；Excel 可直接開啟。`
      : '所選期間未有紀錄。';

    els.bills.replaceChildren();
    els.billsPanel.hidden = bills.length === 0;
    for (const bill of bills) els.bills.append(makeBillShareCard(bill));

    els.recentList.replaceChildren();
    for (const record of records.slice(0, state.recentLimit)) els.recentList.append(makeRow(record));
    els.more.hidden = records.length <= state.recentLimit;
    if (!state.syncedOnce && state.connecting) {
      els.empty.hidden = false;
      els.empty.textContent = '載入中…';
    } else {
      els.empty.hidden = records.length > 0;
      els.empty.textContent = apiUrl ? '未有紀錄。' : '未設定 Google Sheet；紀錄只會存喺呢部機。';
    }

    const recentUnassigned = recentRecords(state.unassigned, 30);
    els.unassigned.replaceChildren();
    appendPendingRows(els.unassigned, recentUnassigned, makeUnassignedRow, Date.now(), state.openUnassigned);
    if (!state.syncedOnce && state.connecting) {
      els.unassignedEmpty.hidden = false;
      els.unassignedEmpty.textContent = '載入中…';
    } else {
      els.unassignedEmpty.hidden = recentUnassigned.length > 0;
      els.unassignedEmpty.textContent = !apiUrl
        ? '未設定 Google Sheet。'
        : state.unassigned.length > recentUnassigned.length
          ? '最近 30 日冇未配對紀錄；更早嘅由車主處理。'
          : '冇未配對充電樁紀錄。';
    }
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
    if (data.cars.length) state.cars = data.cars;
    state.coverage = data.coverage;
    state.rates = data.rates;
    state.bills = normalizeBillShares(data.bills);
    state.unassigned = mergeRecords(data.unassigned, []);
    state.pending = dropSyncedPending(state.pending, state.server);
    state.offline = false;
    state.updatedAt = new Date().toISOString();
    state.lastFetchAt = Date.now();
    state.loadError = '';
    state.syncedOnce = true;
    await retryPending();
    persist();
    render();
  }

  async function runSync() {
    if (!apiUrl || state.syncing) return;
    state.syncing = true;
    render();
    try {
      const result = await syncTesla(apiUrl, { family: true, manual: true });
      await fetchData();
      const matched = Number(result && result.matched) || 0;
      showToast(els.toast, matched > 0 ? `已配對 ${matched} 個充電時段。` : '冇新嘅充電時段。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '充電樁同步失敗，請檢查網絡後重試。'));
    } finally {
      state.syncing = false;
      render();
    }
  }

  function updateStartButton(pendingStart) {
    const pending = pendingStart !== undefined
      ? pendingStart
      : pendingStartRecord(mergeRecords(state.server, state.pending));
    setBusy(els.startBtn, state.starting, '儲存中…', '⚡ 開始充電');
    if (state.starting) return;
    if (pending) {
      const live = pending.source === 'live';
      els.startBtn.disabled = true;
      els.startBtn.textContent = live ? '已自動認領' : '已記錄開始時間';
      els.startBtn.title = '';
      els.startHint.hidden = false;
      els.startCancel.hidden = false;
      els.startHintText.textContent = live
        ? `${formatHkDate(pending.startAt)} ${formatHkTime12(pending.startAt)} 已自動認領（相片配對）· 充電完成後自動配對入帳 · 24 小時後失效`
        : `${formatHkDate(pending.startAt)} ${formatHkTime12(pending.startAt)} 已記錄開始 · 充電完成後自動配對 · 24 小時後失效`;
      return;
    }
    if (state.connecting && state.live === null) {
      els.startBtn.disabled = true;
      els.startBtn.textContent = '檢查充電樁…';
      els.startBtn.title = '';
      return;
    }
    if (state.live && state.live.available && state.live.charging) {
      els.startBtn.disabled = true;
      els.startBtn.textContent = '充電樁充電中…';
      els.startBtn.title = '充電樁而家充緊電；完成後會自動配對，唔需要按開始。';
      if (state.claimError) {
        els.startHint.hidden = false;
        els.startCancel.hidden = true;
        els.startHintText.textContent = `未能自動認領（${state.claimError}）；完成後可手動認領。`;
      } else {
        els.startHint.hidden = true;
      }
      return;
    }
    els.startHint.hidden = true;
    els.startBtn.title = '';
  }

  function claimErrorLabel(result) {
    const status = result && result.status;
    if (status === 'not_charging') return '';
    if (status === 'no_snapshot') return '未有快照';
    if (status === 'unavailable') return '讀取唔到充電樁';
    if (status === 'other_car') return '相中係另一部車';
    if (status === 'policy_blocked') return '回饋規則暫停';
    return result && result.reason ? String(result.reason).slice(0, 40) : '未能辨識';
  }

  async function maybeClaimLive() {
    if (!apiUrl || state.claimAttempted) return;
    if (!state.syncedOnce || !state.live || !state.live.available || !state.live.charging) return;
    const records = mergeRecords(state.server, state.pending);
    if (pendingStartRecord(records)) return;
    state.claimAttempted = true;
    try {
      const result = await liveClaim(apiUrl, carId);
      if (result && result.status === 'claimed') {
        const percent = result.confidence === null || result.confidence === undefined
          ? null
          : Math.round(Number(result.confidence) * 100);
        showToast(els.toast, `已自動認領 ${state.car.name || carId}${percent === null ? '' : `（${percent}%）`}；完成後自動入帳。`);
        state.claimError = '';
        await refreshRecords();
      } else {
        state.claimError = claimErrorLabel(result);
        render();
      }
    } catch (error) {
      state.claimError = friendlyError(error, '自動認領失敗');
      render();
    }
  }

  async function renderFamilySnapshot(snapshot) {
    if (!snapshot) {
      els.snapshotPanel.hidden = false;
      els.snapshotImg.hidden = true;
      els.snapshotTime.textContent = '';
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = '相機未有新相片（可能離線）。';
      return;
    }
    els.snapshotPanel.hidden = false;
    els.snapshotTime.textContent = `拍攝於 ${formatHkDate(snapshot.capturedAt)} ${formatHkTime12(snapshot.capturedAt)}`;
    const ageMinutes = Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 60000);
    if (ageMinutes > 15) {
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = `最後相片已經 ${ageMinutes} 分鐘前（相機可能離線）。`;
    } else {
      els.snapshotWarning.hidden = true;
    }
    if (snapshot.id === renderedSnapshotId) return;
    renderedSnapshotId = snapshot.id;
    try {
      const data = await fetchLatestSnapshotImage(apiUrl);
      if (!data || !data.image) throw new Error('no image');
      els.snapshotImg.src = `data:image/jpeg;base64,${data.image}`;
      els.snapshotImg.hidden = false;
      els.snapshotHint.textContent = data.snapshot && data.snapshot.crop === 'full'
        ? '測試模式：全畫面；每 60 秒更新，相機每 5 分鐘拍攝一次。'
        : '每 60 秒更新；相機每 5 分鐘拍攝一次。';
    } catch {
      els.snapshotImg.hidden = true;
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = '快照載入失敗；每分鐘重試。';
    }
  }

  function renderLive(live) {
    const wasCharging = state.lastLiveCharging;
    state.live = live;
    updateStartButton();
    if (!live) {
      els.livePanel.hidden = true;
      state.lastLiveCharging = false;
      return;
    }
    els.livePanel.hidden = false;
    const charging = live.available && live.charging;
    state.lastLiveCharging = charging;
    els.liveState.textContent = !live.available ? '狀態不可用' : charging ? '充電中' : '未充電';
    els.liveState.dataset.state = !live.available ? 'warn' : charging ? 'charging' : 'idle';
    els.livePower.textContent = live.available && live.powerW > 0 ? `${(live.powerW / 1000).toFixed(1)} kW` : '—';
    els.liveSample.textContent = live.sampledAt ? formatHkTime12(live.sampledAt) : '—';
    const pending = pendingStartRecord(mergeRecords(state.server, state.pending));
    const parts = [];
    if (!live.available) parts.push('暫時讀取唔到充電樁狀態，會自動重試。');
    else if (charging) {
      if (pending && pending.source === 'live') {
        parts.push(`已自動認領（${formatHkTime12(pending.startAt)}）；充電完成後會自動配對。`);
      } else if (pending) {
        parts.push(`手動開始（${formatHkTime12(pending.startAt)}）；完成後以 Tesla 紀錄為準。`);
      } else {
        parts.push('充電樁充電中；完成後會自動配對，唔需要按開始。');
      }
    } else parts.push('充電樁而家未充電。');
    els.liveHint.textContent = parts.join(' ');
    if (wasCharging && !charging && live.available) void refreshRecords();
    if (charging) void maybeClaimLive();
  }

  async function refreshRecords() {
    if (!apiUrl) return;
    try {
      await fetchData();
      render();
    } catch {
      // keep the last good data until the next visibility refresh
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
      void maybeClaimLive();
      await maybeAutoStart();
    } catch (error) {
      state.connecting = false;
      state.loadError = friendlyError(error, '未能連接，請檢查網絡後重試。');
      render();
      await maybeAutoStart();
    }
  }

  async function maybeAutoStart() {
    if (!autoStart || state.autoStarted) return;
    state.autoStarted = true;
    // Give the first live read a moment so a QR start cannot join a session
    // that is already charging.
    const deadline = Date.now() + 2500;
    while (state.live === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
    if (pendingStartRecord(records)) {
      showToast(els.toast, '已經記錄咗開始時間，完成配對後再開始下一次。');
      return;
    }
    if (isRecentDuplicate(records[0]?.startAt, Date.now())) {
      showToast(els.toast, '已經記錄咗，請稍等 2 秒再試。');
      return;
    }
    if (state.live && state.live.available && state.live.charging) {
      showToast(els.toast, '充電樁而家充緊電；完成後會自動配對，唔需要按開始。');
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
      ? '刪除呢筆紀錄？充電樁紀錄會放返去「未配對充電樁紀錄」，其他車可以認領。'
      : '刪除呢筆紀錄？';
    if (!window.confirm(message)) return;
    state.deleting.add(record.id);
    render();
    try {
      const localOnly = state.pending.some((row) => row.id === record.id);
      let released = false;
      if (apiUrl && !localOnly) {
        const result = await deleteRecord(apiUrl, record.id, { car: carId });
        released = result.released === true;
      }
      state.pending = state.pending.filter((row) => row.id !== record.id);
      state.server = state.server.filter((row) => row.id !== record.id);
      persist();
      render();
      let refreshFailed = false;
      if (released) {
        try {
          await fetchData();
        } catch {
          refreshFailed = true;
          state.offline = true;
          render();
        }
      }
      showToast(
        els.toast,
        released
          ? (refreshFailed
            ? '已放回未配對充電樁紀錄；未能重新載入，請重新整理。'
            : '已刪除，並放回未配對充電樁紀錄。')
          : '已刪除。',
      );
    } catch (error) {
      state.offline = true;
      render();
      showToast(els.toast, friendlyError(error, '刪除失敗，請檢查網絡後重試。'));
    } finally {
      state.deleting.delete(record.id);
      render();
    }
  }

  async function onReassign(record, car) {
    if (!apiUrl || !car || car === record.car || state.reassigning.has(record.id)) return;
    state.reassigning.add(record.id);
    render();
    try {
      await reassignSession(apiUrl, record.id, car, { actor: 'family' });
      await fetchData();
      showToast(els.toast, '已改派。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '改派失敗，請檢查網絡後重試。'));
    } finally {
      state.reassigning.delete(record.id);
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
    const value = els.monthSelect.value || 'all';
    const selected = filterByPeriod(records, value, state.bills);
    if (selected.length === 0) return;
    const suffix = value === 'all'
      ? '-all'
      : value.startsWith('bill:')
        ? `-bill-${value.slice(5).replace(':', '_')}`
        : `-${value}`;
    downloadCsv(
      toCsv(selected, {
        carNames: { [carId]: state.car.name || carId },
        rates: state.rates,
      }),
      `ev-charge-${carId}${suffix}.csv`,
    );
    showToast(els.toast, 'CSV 已下載。');
  }

  els.startBtn.addEventListener('click', onStart);
  els.syncNow.addEventListener('click', () => { void runSync(); });
  els.more.addEventListener('click', () => {
    state.recentLimit += 5;
    render();
  });
  els.exportBtn.addEventListener('click', onExport);
  els.errorRetry.addEventListener('click', () => { if (apiUrl) void load(); });
  els.startCancel.addEventListener('click', () => {
    const row = pendingStartRecord(mergeRecords(state.server, state.pending));
    if (row) void onDelete(row);
  });
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
  if (apiUrl) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - state.lastFetchAt < 60000) return;
      void load();
    });
  }

  if (cached.corrupt || queued.corrupt) showToast(els.toast, '本機紀錄格式有誤，已忽略。');
  if (cachedRates.corrupt) showToast(els.toast, '費率快取格式有誤，已忽略。');
  if (apiUrl) {
    startChargerLive({
      apiUrl,
      getStartAt: () => {
        const row = mergeRecords(state.server, state.pending).find((record) => (
          record.source === 'manual' && record.kWh === null && !record.teslaKey
        ));
        return row ? row.startAt : null;
      },
      getRates: () => state.rates,
      onChange: renderLive,
    });
    startSnapshotPolling({
      apiUrl,
      onSnapshot: (snapshot) => { void renderFamilySnapshot(snapshot); },
      onError: () => {
        els.snapshotPanel.hidden = false;
        els.snapshotWarning.hidden = false;
        els.snapshotWarning.textContent = '快照更新失敗；每分鐘重試。';
      },
    });
  }
  void load();
}
