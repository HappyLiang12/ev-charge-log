import {
  formatHkDate,
  formatHkTime12,
  sessionEndIso,
  filterByMonth,
  monthKey,
  monthsWithRecords,
  familyStartUrl,
  summarizeRecords,
  toCsv,
} from './logic.js';
import { formatStamp, renderRateCards } from './rate-view.js';
import {
  fetchOwnerData,
  syncTesla,
  refreshRates,
  assignSession,
  saveBill,
} from './api.js';
import {
  parseBillLines,
  extractPdfLines,
  inferCutoff,
  allocateBill,
  normalizeBillRows,
} from './bill.js';
import { byId, showToast, setStatus, setBusy, friendlyError, appendPendingRows } from './ui.js';
import { startChargerLive } from './live.js';

export function initOwner({ apiUrl }) {
  const state = {
    cars: [],
    records: [],
    rates: [],
    bills: [],
    sheetUrl: '',
    loading: Boolean(apiUrl),
    offline: false,
    busy: false,
    selectedMonth: null,
    monthTouched: false,
    openPending: new Set(),
    billExtras: {},
    billFileName: '',
    billBusy: false,
  };

  const els = {
    status: byId('ownerStatus'),
    syncBtn: byId('ownerSyncBtn'),
    ratesBtn: byId('ownerRatesBtn'),
    sheetLink: byId('ownerSheetLink'),
    month: byId('ownerMonth'),
    exportBtn: byId('ownerExportBtn'),
    carTotals: byId('ownerCarTotals'),
    legacy: byId('ownerLegacy'),
    pending: byId('ownerPending'),
    pendingEmpty: byId('ownerPendingEmpty'),
    rates: byId('ownerRates'),
    rateSource: byId('ownerRateSource'),
    links: byId('ownerLinks'),
    toast: byId('ownerToast'),
    livePanel: byId('ownerLivePanel'),
    liveState: byId('ownerLiveState'),
    livePower: byId('ownerLivePower'),
    liveKwh: byId('ownerLiveKwh'),
    liveCost: byId('ownerLiveCost'),
    billFile: byId('ownerBillFile'),
    billManualBtn: byId('ownerBillManualBtn'),
    billStatus: byId('ownerBillStatus'),
    billForm: byId('ownerBillForm'),
    billStart: byId('ownerBillStart'),
    billEnd: byId('ownerBillEnd'),
    billUnits: byId('ownerBillUnits'),
    billTotal: byId('ownerBillTotal'),
    billPeak: byId('ownerBillPeak'),
    billOff: byId('ownerBillOff'),
    billCutoff: byId('ownerBillCutoff'),
    billExtract: byId('ownerBillExtract'),
    billPreview: byId('ownerBillPreview'),
    billSave: byId('ownerBillSave'),
    bills: byId('ownerBills'),
  };

  function textRow(label, value) {
    const row = document.createElement('div');
    row.className = 'owner-card-row';
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('strong');
    right.textContent = value;
    row.append(left, right);
    return row;
  }

  function emptyLabel(message) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = message;
    return p;
  }

  function pctLabel(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  }

  function hkLocalInput(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return '';
    return new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
  }

  function isoFromLocalInput(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return '';
    const at = Date.parse(`${text}:00+08:00`);
    return Number.isFinite(at) ? new Date(at).toISOString() : '';
  }

  function setBillStatus(text) {
    els.billStatus.textContent = text;
  }

  function fillBillForm(bill, fileName) {
    els.billForm.hidden = false;
    els.billStart.value = bill.periodStart || '';
    els.billEnd.value = bill.periodEnd || '';
    els.billUnits.value = bill.units === null || bill.units === undefined ? '' : bill.units;
    els.billTotal.value = bill.total === null || bill.total === undefined ? '' : bill.total;
    els.billPeak.value = bill.peakKWh === null || bill.peakKWh === undefined ? '' : bill.peakKWh;
    els.billOff.value = bill.offPeakKWh === null || bill.offPeakKWh === undefined ? '' : bill.offPeakKWh;
    els.billCutoff.value = bill.cutoff ? hkLocalInput(bill.cutoff) : '';
    els.billExtract.textContent = fileName
      ? `檔案：${fileName}${billComponentText(bill)}`
      : '';
  }

  function billComponentText(bill) {
    const parts = [];
    if (bill.energyCharge !== null && bill.energyCharge !== undefined) parts.push(`電費 $${Number(bill.energyCharge).toFixed(2)}`);
    if (bill.fuelCharge !== null && bill.fuelCharge !== undefined) parts.push(`燃料 $${Number(bill.fuelCharge).toFixed(2)}`);
    if (bill.others !== null && bill.others !== undefined) parts.push(`其他 $${Number(bill.others).toFixed(2)}`);
    if (parts.length < 2) return '';
    const derived = bill.totalSource === 'derived' ? '；總額由分項核對' : '';
    return ` · ${parts.join(' + ')}${derived}`;
  }

  function readBillForm() {
    const periodStart = els.billStart.value;
    const periodEnd = els.billEnd.value;
    const units = Number(els.billUnits.value);
    const total = Number(els.billTotal.value);
    const peakRaw = els.billPeak.value.trim();
    const offRaw = els.billOff.value.trim();
    const peakKWh = peakRaw === '' ? null : Number(peakRaw);
    const offPeakKWh = offRaw === '' ? null : Number(offRaw);
    const cutoff = isoFromLocalInput(els.billCutoff.value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) return null;
    if (periodStart >= periodEnd) return null;
    if (!(units > 0) || !(total > 0) || !cutoff) return null;
    if ((peakKWh === null) !== (offPeakKWh === null)) return null;
    if (peakKWh !== null && Math.abs(peakKWh + offPeakKWh - units) > 1.5) return null;
    return { periodStart, periodEnd, units, total, peakKWh, offPeakKWh, cutoff };
  }

  function makeAllocationTable(allocation, bill) {
    const wrap = document.createElement('div');
    wrap.className = 'bill-allocation';
    if (!allocation.rows.length) {
      wrap.append(emptyLabel('此帳單期內未有已配對的充電紀錄。'));
      return wrap;
    }
    const table = document.createElement('table');
    table.className = 'bill-table';
    const head = document.createElement('tr');
    for (const label of ['車輛', 'kWh', '佔比', '應收']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    table.append(head);
    for (const row of allocation.rows) {
      const tr = document.createElement('tr');
      for (const value of [row.name, row.kWh.toFixed(1), `${(row.share * 100).toFixed(1)}%`, `$${row.amount.toFixed(2)}`]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      table.append(tr);
    }
    const foot = document.createElement('tr');
    foot.className = 'bill-total-row';
    for (const value of ['合計', allocation.loggedKWh.toFixed(1), '100%', `$${bill.total.toFixed(2)}`]) {
      const td = document.createElement('td');
      td.textContent = value;
      foot.append(td);
    }
    table.append(foot);
    wrap.append(table);
    const drift = document.createElement('p');
    drift.className = 'hint';
    drift.textContent = `記錄 ${allocation.loggedKWh.toFixed(1)} 度 vs 帳單 ${bill.units} 度（${pctLabel(allocation.driftUnitsPct)}）；按記錄用量比例分攤。`;
    wrap.append(drift);
    if (bill.peakKWh !== null && bill.offPeakKWh !== null) {
      const split = document.createElement('p');
      split.className = 'hint';
      split.textContent = `帳單高峯 ${bill.peakKWh} / 非高峯 ${bill.offPeakKWh} 度；記錄按時間比例估算 ${allocation.peakKWh.toFixed(0)} / ${allocation.offPeakKWh.toFixed(0)}（僅參考）。`;
      wrap.append(split);
    }
    return wrap;
  }

  function makeBillCard(bill) {
    const activeCars = state.cars.filter((car) => car.active);
    const allocation = allocateBill(state.records, bill, activeCars, state.rates, bill.cutoff);
    const card = document.createElement('div');
    card.className = 'bill-card';
    const head = document.createElement('div');
    head.className = 'owner-card-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = `${bill.periodStart} – ${bill.periodEnd}`;
    const total = document.createElement('span');
    total.className = 'owner-card-total';
    total.textContent = `$${bill.total.toFixed(2)}`;
    head.append(title, total);
    card.append(head);
    const meta = document.createElement('p');
    meta.className = 'hint';
    meta.textContent = `${bill.units} 度 · 高峯 ${bill.peakKWh === null ? '—' : bill.peakKWh} / 非高峯 ${bill.offPeakKWh === null ? '—' : bill.offPeakKWh} · 截止 ${formatHkDate(bill.cutoff)} ${formatHkTime12(bill.cutoff)}${bill.fileName ? ` · ${bill.fileName}` : ''}`;
    card.append(meta);
    const components = billComponentText(bill);
    if (components) {
      const breakdown = document.createElement('p');
      breakdown.className = 'hint';
      breakdown.textContent = components.replace(/^ · /, '');
      card.append(breakdown);
    }
    card.append(makeAllocationTable(allocation, bill));
    return card;
  }

  function renderBills() {
    const bills = normalizeBillRows(state.bills);
    els.bills.replaceChildren();
    if (!bills.length) {
      els.bills.append(emptyLabel('未有帳單。上載中電帳單 PDF 或手動輸入。'));
      return;
    }
    for (const bill of bills) els.bills.append(makeBillCard(bill));
  }

  function renderBillPreview() {
    if (els.billForm.hidden) return;
    const bill = readBillForm();
    els.billSave.disabled = state.billBusy || !apiUrl || !bill;
    els.billPreview.replaceChildren();
    if (!bill) {
      els.billPreview.append(emptyLabel('請填寫帳單期、總度數、總額及截止時間。'));
      return;
    }
    const activeCars = state.cars.filter((car) => car.active);
    els.billPreview.append(makeAllocationTable(
      allocateBill(state.records, bill, activeCars, state.rates, bill.cutoff),
      bill,
    ));
  }

  async function onBillFile() {
    const file = els.billFile.files && els.billFile.files[0];
    if (!file) return;
    state.billFileName = file.name;
    setBillStatus('解析中…');
    try {
      if (!window.pdfjsLib) throw new Error('PDF 解析元件未載入');
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', document.baseURI).toString();
      const buffer = await file.arrayBuffer();
      const lines = await extractPdfLines(buffer, window.pdfjsLib);
      const parsed = parseBillLines(lines);
      const inferred = inferCutoff(state.records, parsed);
      state.billExtras = {
        energyCharge: parsed.energyCharge,
        fuelCharge: parsed.fuelCharge,
        others: parsed.others,
      };
      fillBillForm({ ...parsed, cutoff: inferred.cutoff }, file.name);
      setBillStatus(inferred.source === 'bill'
        ? '已讀取帳單；截止時間按帳單分月用量推算，可手動調整。'
        : '已讀取帳單；請確認截止時間。');
      renderBillPreview();
    } catch (error) {
      els.billForm.hidden = false;
      setBillStatus(friendlyError(error, '未能讀取 PDF；請手動輸入帳單數字。'));
      renderBillPreview();
    } finally {
      els.billFile.value = '';
    }
  }

  async function onSaveBill() {
    const bill = readBillForm();
    if (!bill) {
      setBillStatus('請檢查帳單期、度數、總額、高峯/非高峯及截止時間。');
      renderBillPreview();
      return;
    }
    if (!apiUrl || state.billBusy) return;
    state.billBusy = true;
    renderBillPreview();
    try {
      await saveBill(apiUrl, {
        ...bill,
        energyCharge: state.billExtras.energyCharge ?? null,
        fuelCharge: state.billExtras.fuelCharge ?? null,
        others: state.billExtras.others ?? null,
        fileName: state.billFileName,
      });
      showToast(els.toast, '帳單已記錄。');
      setBillStatus('帳單已記錄，可按「更新充電樁」後再核對。');
      els.billForm.hidden = true;
      state.billExtras = {};
      state.billFileName = '';
      await refreshOrWarn('帳單已記錄，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '帳單記錄失敗，請檢查網絡後重試。'));
    } finally {
      state.billBusy = false;
      render();
      renderBillPreview();
    }
  }

  function makeCarCard(car, rows) {
    const summary = summarizeRecords(rows, state.rates, 'all');
    const card = document.createElement('div');
    card.className = 'owner-card';
    const head = document.createElement('div');
    head.className = 'owner-card-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = car.name;
    const total = document.createElement('span');
    total.className = 'owner-card-total';
    total.textContent = summary.cost === null ? '—' : `$${summary.cost.toFixed(2)}`;
    head.append(title, total);
    card.append(head);
    card.append(textRow('次數 / 已配對', `${summary.count} / ${summary.matched}`));
    card.append(textRow('kWh', summary.kWh.toFixed(1)));
    card.append(textRow('非高峰 / 高峰', `${summary.offPeakKWh.toFixed(1)} / ${summary.peakKWh.toFixed(1)} kWh`));
    if (summary.pending > 0) card.append(textRow('待配對', String(summary.pending)));
    if (summary.missingRate > 0) card.append(textRow('缺少費率', `${summary.missingRate} 筆`));
    return card;
  }

  function makeQr(url) {
    if (typeof window.qrcode !== 'function') return null;
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return {
      svg: qr.createSvgTag(4, 2),
      png: qr.createDataURL(8, 4),
    };
  }

  function makeLinkCard(car) {
    const card = document.createElement('div');
    card.className = 'owner-link';
    const head = document.createElement('div');
    head.className = 'owner-link-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = car.name;
    const actions = document.createElement('div');
    actions.className = 'owner-link-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '複製連結';
    const qrButton = document.createElement('button');
    qrButton.type = 'button';
    qrButton.textContent = 'QR';
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('car', car.id);
    url.hash = '';
    copy.addEventListener('click', () => { void onCopy(url.toString()); });
    const qrBox = document.createElement('div');
    qrBox.className = 'owner-qr';
    qrBox.hidden = true;
    qrButton.addEventListener('click', () => {
      qrBox.hidden = !qrBox.hidden;
      if (qrBox.hidden || qrBox.dataset.ready) return;
      const qr = makeQr(familyStartUrl(url.toString(), car.id));
      if (!qr) {
        qrBox.textContent = '未能產生 QR。';
        return;
      }
      const holder = document.createElement('div');
      holder.className = 'owner-qr-image';
      holder.innerHTML = qr.svg;
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = '掃描即開始充電；貼喺充電樁或車旁。';
      const download = document.createElement('a');
      download.href = qr.png;
      download.download = `ev-charge-qr-${car.id}.gif`;
      download.textContent = '下載 QR';
      qrBox.append(holder, hint, download);
      qrBox.dataset.ready = '1';
    });
    actions.append(copy, qrButton);
    head.append(title, actions);
    const link = document.createElement('a');
    link.className = 'owner-link-url';
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = url.toString();
    card.append(head, link, qrBox);
    return card;
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

    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    const duration = record.durationSec ? `${Math.round(record.durationSec / 60)} 分鐘` : '—';
    const end = sessionEndIso(record);
    const endLabel = end ? `${formatHkDate(end)} ${formatHkTime12(end)}` : '—';
    meta.textContent = `結束 ${endLabel} · 充電樁紀錄 · ${duration} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh`;

    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    const select = document.createElement('select');
    select.setAttribute('aria-label', '分配車輛');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '選擇車輛';
    select.append(placeholder);
    for (const car of state.cars.filter((item) => item.active)) {
      const option = document.createElement('option');
      option.value = car.id;
      option.textContent = car.name;
      select.append(option);
    }
    select.disabled = state.busy;
    const assign = document.createElement('button');
    assign.type = 'button';
    assign.textContent = '分配';
    assign.disabled = state.busy;
    assign.addEventListener('click', () => { void onAssign(record, select); });
    actions.append(select, assign);
    li.append(head, meta, actions);
    return li;
  }

  function makePendingRow(record) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'owner-row-head';
    const when = document.createElement('span');
    when.textContent = `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`;
    const car = state.cars.find((item) => item.id === record.car);
    const title = document.createElement('strong');
    title.textContent = car ? car.name : record.car;
    head.append(when, title);
    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    meta.textContent = '手動開始紀錄，等待充電樁紀錄配對。';
    li.append(head, meta);
    return li;
  }

  function render() {
    const status = !apiUrl
      ? '未設定'
      : state.loading
        ? '連線中'
        : state.offline
          ? '離線'
          : '已連接';
    setStatus(els.status, status);
    setBusy(els.syncBtn, state.loading || state.busy || !apiUrl, '更新中…', '更新充電樁');
    setBusy(els.ratesBtn, state.loading || state.busy || !apiUrl, '更新中…', '更新費率');
    if (state.sheetUrl) {
      els.sheetLink.href = state.sheetUrl;
      els.sheetLink.hidden = false;
    } else {
      els.sheetLink.hidden = true;
    }

    const records = state.records;
    const months = monthsWithRecords(records);
    const currentMonth = monthKey(new Date().toISOString());
    const monthOptions = [...new Set([...months, currentMonth])].sort().reverse();
    const selected = state.monthTouched
      && (state.selectedMonth === 'all' || monthOptions.includes(state.selectedMonth))
      ? state.selectedMonth
      : currentMonth;
    const options = ['all', ...monthOptions];
    els.month.replaceChildren();
    for (const month of options) {
      const option = document.createElement('option');
      option.value = month;
      option.textContent = month === 'all'
        ? '全部月份'
        : `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
      els.month.append(option);
    }
    els.month.value = options.includes(selected) ? selected : 'all';
    els.month.disabled = state.loading || state.busy;
    state.selectedMonth = els.month.value;
    const filtered = filterByMonth(records, els.month.value);
    const billable = filtered.filter((record) => (
      record.car && record.car !== 'unassigned' && record.source !== 'legacy'
    ));
    els.exportBtn.disabled = billable.length === 0;

    const activeCars = state.cars.filter((car) => car.active);
    els.carTotals.replaceChildren();
    if (activeCars.length === 0) {
      els.carTotals.append(emptyLabel('未有車輛；請在 Google Sheet 的 Cars 工作表加入。'));
    } else {
      for (const car of activeCars) {
        els.carTotals.append(makeCarCard(car, filtered.filter((record) => record.car === car.id)));
      }
    }

    const legacy = filtered.filter((record) => record.source === 'legacy' || !record.car).length;
    els.legacy.textContent = legacy > 0 ? `Legacy 紀錄 ${legacy} 筆，未計入以上月結。` : '';

    const pending = state.records.filter((record) => (
      record.car === 'unassigned'
      || (record.car && record.car !== 'unassigned' && record.kWh === null && record.source !== 'legacy')
    ));
    els.pending.replaceChildren();
    appendPendingRows(
      els.pending,
      pending,
      (record) => (record.car === 'unassigned' ? makeUnassignedRow(record) : makePendingRow(record)),
      Date.now(),
      state.openPending,
    );
    els.pendingEmpty.hidden = pending.length > 0;
    els.pendingEmpty.textContent = '所有紀錄都已配對。';

    els.rates.replaceChildren();
    renderRateCards(els.rates, state.rates, '未有費率；請按「更新費率」。');
    const latest = state.rates.slice().sort((a, b) => b.month.localeCompare(a.month))[0];
    els.rateSource.textContent = latest
      ? `來源：${latest.manualOverride ? '手動設定' : 'CLP 官方網站'} · 最後更新 ${formatStamp(latest.fetchedAt)}`
      : '未有費率資料。';

    els.links.replaceChildren();
    if (activeCars.length === 0) {
      els.links.append(emptyLabel('未有車輛連結。'));
    } else {
      for (const car of activeCars) els.links.append(makeLinkCard(car));
    }
    renderBills();
  }

  async function refreshData() {
    const data = await fetchOwnerData(apiUrl);
    state.cars = data.cars;
    state.records = data.records;
    state.rates = data.rates;
    state.bills = data.bills || [];
    state.sheetUrl = data.sheetUrl;
    state.offline = false;
  }

  async function refreshOrWarn(message) {
    try {
      await refreshData();
    } catch {
      state.offline = true;
      showToast(els.toast, message);
    }
  }

  async function load() {
    render();
    if (!apiUrl) return;
    state.loading = true;
    render();
    try {
      await refreshData();
      state.loading = false;
      render();
    } catch (error) {
      state.loading = false;
      state.offline = true;
      render();
      showToast(els.toast, friendlyError(error, '未能載入管理資料，請檢查網絡。'));
    }
  }

  async function onSync() {
    if (!apiUrl || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await syncTesla(apiUrl);
      if (result.skipped) {
        showToast(els.toast, '未有待配對的手動紀錄；請家人先按「開始充電」，或設定 SYNC_FROM 後再試。');
      } else {
        showToast(els.toast, `已配對 ${Number(result.matched) || 0} 個；新增未分配 ${Number(result.unassigned) || 0} 個。`);
      }
      await refreshOrWarn('同步完成，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '充電樁同步失敗，請檢查網絡後重試。'));
    } finally {
      state.busy = false;
      render();
    }
  }

  async function onRates() {
    if (!apiUrl || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await refreshRates(apiUrl);
      showToast(els.toast, `已更新 ${Number(result.updated) || 0} 個月份費率。`);
      await refreshOrWarn('費率已更新，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '費率更新失敗，請檢查網絡後重試。'));
    } finally {
      state.busy = false;
      render();
    }
  }

  async function onAssign(record, select) {
    const car = select.value;
    if (!car) {
      showToast(els.toast, '請先選擇車輛。');
      return;
    }
    if (!apiUrl || state.busy) return;
    state.busy = true;
    render();
    try {
      await assignSession(apiUrl, record.id, car);
      showToast(els.toast, '已分配。');
      await refreshOrWarn('已分配，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '分配失敗，請檢查網絡後重試。'));
    } finally {
      state.busy = false;
      render();
    }
  }

  async function onCopy(url) {
    try {
      await navigator.clipboard.writeText(url);
      showToast(els.toast, '連結已複製。');
    } catch {
      showToast(els.toast, '未能複製，請長按選取連結。');
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

  function renderLive(live) {
    if (!live) {
      els.livePanel.hidden = true;
      return;
    }
    els.livePanel.hidden = false;
    const charging = live.available && live.charging;
    els.liveState.textContent = !live.available ? '狀態不可用' : charging ? '充電中' : '未充電';
    els.liveState.dataset.state = charging ? 'charging' : 'idle';
    els.livePower.textContent = live.powerW > 0 ? `${(live.powerW / 1000).toFixed(1)} kW` : '—';
    els.liveKwh.textContent = live.kWh.toFixed(3);
    els.liveCost.textContent = live.cost === null ? '—' : `$${live.cost.toFixed(3)}`;
  }

  function onExport() {
    const month = els.month.value || 'all';
    const billable = filterByMonth(state.records, month).filter((record) => (
      record.car && record.car !== 'unassigned' && record.source !== 'legacy'
    ));
    if (billable.length === 0) return;
    const carNames = {};
    for (const car of state.cars) carNames[car.id] = car.name;
    const filename = month === 'all' ? 'ev-charge-all.csv' : `ev-charge-all-${month}.csv`;
    downloadCsv(toCsv(billable, { carNames, rates: state.rates }), filename);
    showToast(els.toast, 'CSV 已下載。');
  }

  els.month.addEventListener('change', () => {
    state.monthTouched = true;
    state.selectedMonth = els.month.value;
    render();
  });
  els.exportBtn.addEventListener('click', onExport);
  els.syncBtn.addEventListener('click', () => { void onSync(); });
  els.ratesBtn.addEventListener('click', () => { void onRates(); });
  els.billFile.addEventListener('change', () => { void onBillFile(); });
  els.billManualBtn.addEventListener('click', () => {
    els.billForm.hidden = false;
    renderBillPreview();
  });
  for (const field of [
    els.billStart, els.billEnd, els.billUnits, els.billTotal,
    els.billPeak, els.billOff, els.billCutoff,
  ]) {
    field.addEventListener('input', renderBillPreview);
  }
  els.billSave.addEventListener('click', () => { void onSaveBill(); });
  window.addEventListener('online', () => {
    if (apiUrl) void load();
  });
  if (apiUrl) {
    startChargerLive({
      apiUrl,
      getStartAt: () => {
        const row = state.records.find((record) => (
          record.source === 'manual' && record.car && record.car !== 'unassigned'
          && record.kWh === null && !record.teslaKey
        ));
        return row ? row.startAt : null;
      },
      getRates: () => state.rates,
      onChange: renderLive,
    });
  }
  void load();
}
