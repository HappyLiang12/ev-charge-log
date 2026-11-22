import {
  formatHkDate,
  formatHkTime12,
  sessionEndIso,
  billPeriodValue,
  filterByPeriod,
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
  deleteRecord,
  ignoreSession,
  reassignSession,
  saveBill,
  publishBill,
  fetchLatestSnapshotImage,
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
import { startSnapshotPolling } from './snapshot.js';
import { createRecordPhoto } from './record-photo.js';

// Null prototype: a tampered engine string must never resolve to an
// Object.prototype member and render function source.
const ENGINE_LABELS = Object.create(null);
ENGINE_LABELS.plate = '車牌';
ENGINE_LABELS.vlm = '視覺';

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
    publishing: new Set(),
    rowBusy: new Set(),
    updatedAt: '',
    lastFetchAt: 0,
    lastLiveCharging: false,
    liveStartRow: null,
  };

  const els = {
    status: byId('ownerStatus'),
    pendingCount: byId('ownerPendingCount'),
    updatedAt: byId('ownerUpdatedAt'),
    snapshotWarning: byId('ownerSnapshotWarning'),
    syncBtn: byId('ownerSyncBtn'),
    ratesBtn: byId('ownerRatesBtn'),
    sheetLink: byId('ownerSheetLink'),
    month: byId('ownerMonth'),
    exportBtn: byId('ownerExportBtn'),
    carTotals: byId('ownerCarTotals'),
    legacy: byId('ownerLegacy'),
    pending: byId('ownerPending'),
    pendingEmpty: byId('ownerPendingEmpty'),
    assigned: byId('ownerAssigned'),
    assignedEmpty: byId('ownerAssignedEmpty'),
    rates: byId('ownerRates'),
    rateSource: byId('ownerRateSource'),
    links: byId('ownerLinks'),
    toast: byId('ownerToast'),
    livePanel: byId('ownerLivePanel'),
    liveHint: byId('ownerLiveHint'),
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
    snapshotPanel: byId('ownerSnapshotPanel'),
    snapshotImg: byId('ownerSnapshotImg'),
    snapshotTime: byId('ownerSnapshotTime'),
    snapshotHint: byId('ownerSnapshotHint'),
  };
  let renderedSnapshotId = '';

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

  function carLabel(id) {
    const car = state.cars.find((item) => item.id === id);
    return car ? car.name : id;
  }

  function confidencePercent(value) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 100);
  }

  function suggestionLabel(record) {
    const parts = [];
    const percent = confidencePercent(record.suggestionConfidence);
    if (percent > 0) parts.push(`${percent}%`);
    const engine = ENGINE_LABELS[record.suggestionEngine];
    if (engine) parts.push(engine);
    return parts.length
      ? `建議：${carLabel(record.suggestedCar)}（${parts.join('，')}）`
      : `建議：${carLabel(record.suggestedCar)}`;
  }

  function recordWhen(record) {
    return `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`;
  }

  async function renderSnapshot(snapshot) {
    if (!snapshot) {
      els.snapshotPanel.hidden = false;
      els.snapshotImg.hidden = true;
      els.snapshotTime.textContent = '';
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = '相機未有新相片（可能離線）。';
      els.snapshotHint.textContent = '每 60 秒重試。';
      return;
    }
    const when = `${formatHkDate(snapshot.capturedAt)} ${formatHkTime12(snapshot.capturedAt)}`.trim();
    const ageMinutes = Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 60000);
    els.snapshotPanel.hidden = false;
    els.snapshotTime.textContent = when ? `拍攝於 ${when}` : '';
    if (ageMinutes > 15) {
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = `最後相片已經 ${ageMinutes} 分鐘前（相機可能離線）。`;
    } else {
      els.snapshotWarning.hidden = true;
    }
    els.snapshotHint.textContent = snapshot.crop === 'full'
      ? '測試模式：全畫面；每 60 秒更新，相機每 5 分鐘拍攝一次。'
      : '每 60 秒更新；相機每 5 分鐘拍攝一次。';
    if (snapshot.id === renderedSnapshotId) return;
    renderedSnapshotId = snapshot.id;
    try {
      const data = await fetchLatestSnapshotImage(apiUrl);
      if (!data || !data.image) throw new Error('no image');
      els.snapshotImg.src = `data:image/jpeg;base64,${data.image}`;
      els.snapshotImg.hidden = false;
    } catch {
      els.snapshotImg.hidden = true;
      els.snapshotWarning.hidden = false;
      els.snapshotWarning.textContent = '快照載入失敗；每分鐘重試。';
    }
  }

  function billCalibrationMessage(calibration, periodEnd) {
    let message;
    if (!calibration) {
      message = '帳單已記錄。';
    } else if (!calibration.applied) {
      message = calibration.reason === 'insufficient labeled data'
        ? '帳單已記錄；已分配車輛嘅紀錄不足，未校準高峰係數。'
        : '帳單已記錄；未校準高峰係數。';
    } else {
      const changes = Array.isArray(calibration.updatedCars) ? calibration.updatedCars : [];
      const parts = changes.map((car) => (
        `${car.name || car.id} ${Number(car.from).toFixed(2)} → ${Number(car.to).toFixed(2)}`
      ));
      message = changes.length
        ? `帳單已記錄；已按 ${calibration.billsUsed} 張帳單校準：${parts.join('、')}。`
        : '帳單已記錄；估算已貼合帳單，高峰係數不變。';
    }
    const skipped = Array.isArray(calibration && calibration.skipped)
      ? calibration.skipped.find((item) => item.label === periodEnd)
      : null;
    if (skipped) {
      const reasons = {
        'unlabeled sessions': '此帳單有未分配充電時段',
        'missing sessions': '此帳單嘅充電時段覆蓋不足',
        'no peak/off-peak': '此帳單冇高峰/非高峰度數',
        'no sessions': '此帳單期內冇充電時段',
        'invalid period': '此帳單期無效',
      };
      message += ` ${reasons[skipped.reason] || '此帳單'}，未納入校準。`;
    }
    return message;
  }

  function hkLocalInput(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return '';
    return new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  }

  function isoFromLocalInput(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) return '';
    const at = Date.parse(`${text.length === 16 ? `${text}:00` : text}+08:00`);
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
      split.textContent = `帳單高峰 ${bill.peakKWh} / 非高峰 ${bill.offPeakKWh} 度；記錄按時段及車輛習慣估算 ${allocation.peakKWh.toFixed(0)} / ${allocation.offPeakKWh.toFixed(0)}（僅參考）。`;
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
    meta.textContent = `${bill.units} 度 · 高峰 ${bill.peakKWh === null ? '—' : bill.peakKWh} / 非高峰 ${bill.offPeakKWh === null ? '—' : bill.offPeakKWh} · 截止 ${formatHkDate(bill.cutoff)} ${formatHkTime12(bill.cutoff)}${bill.fileName ? ` · ${bill.fileName}` : ''}`;
    card.append(meta);
    const components = billComponentText(bill);
    if (components) {
      const breakdown = document.createElement('p');
      breakdown.className = 'hint';
      breakdown.textContent = components.replace(/^ · /, '');
      card.append(breakdown);
    }
    card.append(makeAllocationTable(allocation, bill));
    const publish = document.createElement('div');
    publish.className = 'bill-publish';
    const publishInfo = document.createElement('span');
    const publishBtn = document.createElement('button');
    publishBtn.type = 'button';
    publishBtn.className = 'secondary';
    const busy = state.publishing.has(bill.periodEnd);
    const blocked = allocation.unassignedCount > 0;
    const empty = !(allocation.loggedKWh > 0);
    if (bill.publishedAt) {
      publishInfo.textContent = blocked
        ? `已發布，但此期有 ${allocation.unassignedCount} 筆未分配，已暫停家人顯示`
        : `已發布 ${formatStamp(bill.publishedAt)}`;
      publishBtn.textContent = busy ? '更新中…' : '更新分攤';
    } else {
      publishInfo.textContent = blocked
        ? `仍有 ${allocation.unassignedCount} 筆未分配（${allocation.unassignedKWh.toFixed(1)} kWh），請先分配`
        : empty
          ? '此期未有已分配紀錄，未能發布'
          : '未發布；家人連結未顯示應付金額';
      publishBtn.textContent = busy ? '發布中…' : '發布分攤';
    }
    publishBtn.disabled = !apiUrl || busy || blocked || empty;
    publishBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
    publishBtn.addEventListener('click', () => { void onPublishBill(bill); });
    publish.append(publishInfo, publishBtn);
    card.append(publish);
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
      setBillStatus('請檢查帳單期、度數、總額、高峰/非高峰及截止時間。');
      renderBillPreview();
      return;
    }
    if (!apiUrl || state.billBusy) return;
    state.billBusy = true;
    renderBillPreview();
    try {
      const saved = await saveBill(apiUrl, {
        ...bill,
        energyCharge: state.billExtras.energyCharge ?? null,
        fuelCharge: state.billExtras.fuelCharge ?? null,
        others: state.billExtras.others ?? null,
        fileName: state.billFileName,
      });
      const message = billCalibrationMessage(saved.calibration, bill.periodEnd);
      showToast(els.toast, message);
      setBillStatus(`${message} 可按「同步紀錄」後再核對。`);
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

  async function onPublishBill(bill) {
    if (!apiUrl || state.publishing.has(bill.periodEnd)) return;
    state.publishing.add(bill.periodEnd);
    render();
    try {
      await publishBill(apiUrl, bill.periodStart, bill.periodEnd);
      await refreshData();
      showToast(els.toast, '已發布分攤；家人連結會見到應付金額。');
    } catch (error) {
      const message = String(error && error.message ? error.message : '');
      const validationError = /unassigned|no assigned sessions/i.test(message);
      if (!validationError) state.offline = true;
      showToast(els.toast, /unassigned/i.test(message)
        ? '此期仍有未分配紀錄，請先分配再發布。'
        : /no assigned sessions/i.test(message)
          ? '此期未有已分配紀錄，未能發布。'
          : friendlyError(error, '發布失敗，請檢查網絡後重試。'));
    } finally {
      state.publishing.delete(bill.periodEnd);
      render();
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
    card.append(textRow('紀錄', `總數 ${summary.count} · 已配對 ${summary.matched}`));
    card.append(textRow('kWh', summary.kWh.toFixed(1)));
    card.append(textRow('非高峰 / 高峰', `${summary.offPeakKWh.toFixed(1)} / ${summary.peakKWh.toFixed(1)} kWh`));
    const peakFactor = Number(car.peakFactor);
    if (Number.isFinite(peakFactor) && peakFactor < 0.995) {
      card.append(textRow('高峰係數', `${peakFactor.toFixed(2)}（按帳單校準）`));
    }
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

  function fillCarOptions(select, { placeholder, current } = {}) {
    if (placeholder !== undefined) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = placeholder;
      select.append(option);
    }
    for (const car of state.cars.filter((item) => item.active)) {
      const option = document.createElement('option');
      option.value = car.id;
      option.textContent = car.name;
      select.append(option);
    }
    if (current && !state.cars.some((car) => car.active && car.id === current)) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = `${carLabel(current)}（已停用）`;
      option.disabled = true;
      select.append(option);
    }
    if (current) select.value = current;
    return select;
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

    // Manual rows have no Tesla session to claim; only removing them makes sense.
    const manual = !record.teslaKey;
    const rowBusy = state.busy || state.rowBusy.has(record.id);
    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    const duration = record.durationSec ? `${Math.round(record.durationSec / 60)} 分鐘` : '—';
    const end = sessionEndIso(record);
    const endLabel = end ? `${formatHkDate(end)} ${formatHkTime12(end)}` : '—';
    meta.textContent = manual
      ? `開始 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} · 手動開始，未能配對充電樁`
      : `結束 ${endLabel} · 充電樁紀錄 · ${duration} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh`;

    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    if (!manual) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', '分配車輛');
      fillCarOptions(select, { placeholder: '選擇車輛' });
      select.disabled = rowBusy;

      let suggestion = null;
      if (record.suggestedCar && record.suggestionStatus === 'matched') {
        suggestion = document.createElement('div');
        suggestion.className = 'suggestion-row';
        const label = document.createElement('span');
        label.className = 'suggestion-label';
        label.textContent = suggestionLabel(record);
        const adopt = document.createElement('button');
        adopt.type = 'button';
        adopt.className = 'owner-suggestion';
        adopt.textContent = '採用建議';
        adopt.setAttribute('aria-label', `採用建議（${recordWhen(record)}）`);
        adopt.disabled = rowBusy
          || !state.cars.some((car) => car.active && car.id === record.suggestedCar);
        adopt.addEventListener('click', () => { select.value = record.suggestedCar; });
        suggestion.append(label, adopt);
      } else if (record.evidenceUrl) {
        suggestion = document.createElement('span');
        suggestion.className = 'suggestion-label';
        suggestion.textContent = record.suggestionStatus === 'error'
          || record.suggestionStatus === 'rate_limited'
          ? '辨識失敗，請人手選擇'
          : '未能辨識，請人手選擇';
      }

      const assign = document.createElement('button');
      assign.type = 'button';
      assign.textContent = '分配';
      assign.disabled = rowBusy;
      assign.addEventListener('click', () => { void onAssign(record, select); });
      actions.append(select, assign);
      li.append(head, meta);
      if (suggestion) li.append(suggestion);
    } else {
      li.append(head, meta);
      const note = document.createElement('span');
      note.className = 'suggestion-label';
      note.textContent = '手動開始紀錄，未能配對充電樁；可忽略刪除。';
      li.append(note);
    }

    const photo = createRecordPhoto({
      apiUrl,
      record,
      when: recordWhen(record),
      buildActions: (close) => {
        if (manual) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'secondary';
          remove.textContent = '刪除此紀錄';
          remove.addEventListener('click', () => { close(); void onIgnore(record); });
          return [remove];
        }
        const picker = document.createElement('select');
        picker.setAttribute('aria-label', '分配車輛');
        fillCarOptions(picker, { placeholder: '選擇車輛' });
        const assign = document.createElement('button');
        assign.type = 'button';
        assign.className = 'secondary';
        assign.textContent = '分配';
        assign.addEventListener('click', () => { close(); void onAssign(record, picker); });
        return [picker, assign];
      },
    });
    if (photo) li.append(photo);
    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.className = 'owner-ignore';
    ignore.textContent = manual ? '刪除此紀錄' : '非家中車輛（忽略）';
    ignore.setAttribute('aria-label', manual
      ? `刪除 ${recordWhen(record)} 的手動開始紀錄`
      : `非家中車輛（忽略，${recordWhen(record)}）`);
    ignore.disabled = rowBusy;
    ignore.addEventListener('click', () => { void onIgnore(record); });
    actions.append(ignore);
    li.append(actions);
    return li;
  }

  function makeAssignedRow(record) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'owner-row-head';
    const when = document.createElement('span');
    when.textContent = `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`;
    const title = document.createElement('strong');
    title.textContent = carLabel(record.car);
    head.append(when, title);

    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    const duration = record.durationSec ? `${Math.round(record.durationSec / 60)} 分鐘` : '—';
    meta.textContent = `${record.kWh === null ? '—' : `${record.kWh.toFixed(2)} kWh`} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh · ${duration}`;

    const select = document.createElement('select');
    select.setAttribute('aria-label', `改派 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} 的車輛`);
    fillCarOptions(select, { current: record.car });
    const rowBusy = state.busy || state.rowBusy.has(record.id);
    select.disabled = rowBusy;
    const reassign = document.createElement('button');
    reassign.type = 'button';
    reassign.className = 'owner-reassign';
    reassign.textContent = '改派';
    reassign.disabled = rowBusy;
    reassign.addEventListener('click', () => { void onReassign(record, select); });
    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    actions.append(select, reassign);

    li.append(head, meta);
    const photo = createRecordPhoto({
      apiUrl,
      record,
      when: recordWhen(record),
      buildActions: (close) => {
        const picker = document.createElement('select');
        picker.setAttribute('aria-label', '改派車輛');
        fillCarOptions(picker, { current: record.car });
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'secondary';
        move.textContent = '改派';
        move.addEventListener('click', () => { close(); void onReassign(record, picker); });
        return [picker, move];
      },
    });
    if (photo) li.append(photo);
    li.append(actions);
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
    const live = record.source === 'live';
    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    meta.textContent = live
      ? '自動認領紀錄（相片配對），等待充電完成配對。'
      : '手動開始紀錄，等待充電樁紀錄配對。';
    const actions = document.createElement('div');
    actions.className = 'owner-row-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'owner-ignore';
    cancel.textContent = live ? '取消認領' : '取消開始';
    cancel.setAttribute('aria-label', `取消 ${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)} 的${live ? '自動認領' : '手動開始'}紀錄`);
    cancel.disabled = state.busy || state.rowBusy.has(record.id);
    cancel.addEventListener('click', () => { void onCancelPending(record); });
    actions.append(cancel);
    const photo = createRecordPhoto({
      apiUrl,
      record,
      when: recordWhen(record),
      buildActions: (close) => {
        const stop = document.createElement('button');
        stop.type = 'button';
        stop.className = 'secondary';
        stop.textContent = live ? '取消認領' : '取消開始';
        stop.addEventListener('click', () => { close(); void onCancelPending(record); });
        return [stop];
      },
    });
    li.append(head, meta);
    if (photo) li.append(photo);
    li.append(actions);
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
    els.updatedAt.textContent = state.updatedAt ? `資料更新於 ${formatHkTime12(state.updatedAt)}` : '';
    setBusy(els.syncBtn, state.loading || state.busy || !apiUrl, '更新中…', '同步紀錄');
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
    const bills = normalizeBillRows(state.bills);
    const billOptions = bills.map((bill) => ({
      value: billPeriodValue(bill),
      label: `帳單 ${bill.periodStart} – ${bill.periodEnd}`,
    }));
    const monthOptions = [...new Set([...months, currentMonth])].sort().reverse();
    const optionValues = ['all', ...billOptions.map((option) => option.value), ...monthOptions];
    const selected = state.monthTouched && optionValues.includes(state.selectedMonth)
      ? state.selectedMonth
      : billOptions.length > 0
        ? billOptions[0].value
        : currentMonth;
    const labels = new Map(billOptions.map((option) => [option.value, option.label]));
    els.month.replaceChildren();
    for (const value of optionValues) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'all'
        ? '全部月份'
        : labels.get(value) || `${value.slice(0, 4)} 年 ${Number(value.slice(5))} 月`;
      els.month.append(option);
    }
    els.month.value = optionValues.includes(selected) ? selected : 'all';
    els.month.disabled = state.loading || state.busy;
    state.selectedMonth = els.month.value;
    const filtered = filterByPeriod(records, els.month.value, bills);
    const billable = filtered.filter((record) => (
      record.car && record.car !== 'unassigned' && record.source !== 'legacy'
    ));
    els.exportBtn.disabled = billable.length === 0;

    const activeCars = state.cars.filter((car) => car.active);
    els.carTotals.replaceChildren();
    if (activeCars.length === 0) {
      els.carTotals.append(emptyLabel(state.loading
        ? '載入中…'
        : '未有車輛；請在 Google Sheet 的 Cars 工作表加入。'));
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
    els.pendingCount.hidden = pending.length === 0;
    els.pendingCount.textContent = `待配對 ${pending.length}`;
    if (state.loading && state.records.length === 0) {
      els.pendingEmpty.hidden = false;
      els.pendingEmpty.textContent = '載入中…';
    } else {
      els.pendingEmpty.hidden = pending.length > 0;
      els.pendingEmpty.textContent = '所有紀錄都已配對。';
    }

    const assigned = filtered
      .filter((record) => (
        record.car && record.car !== 'unassigned' && record.kWh !== null && record.source !== 'legacy'
      ))
      .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));
    els.assigned.replaceChildren();
    for (const record of assigned) els.assigned.append(makeAssignedRow(record));
    if (state.loading && state.records.length === 0) {
      els.assignedEmpty.hidden = false;
      els.assignedEmpty.textContent = '載入中…';
    } else {
      els.assignedEmpty.hidden = assigned.length > 0;
    }

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
    state.updatedAt = new Date().toISOString();
    state.lastFetchAt = Date.now();
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
    if (!apiUrl || state.busy || state.rowBusy.has(record.id)) return;
    state.rowBusy.add(record.id);
    render();
    try {
      await assignSession(apiUrl, record.id, car);
      showToast(els.toast, '已分配。');
      await refreshOrWarn('已分配，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '分配失敗，請檢查網絡後重試。'));
    } finally {
      state.rowBusy.delete(record.id);
      render();
    }
  }

  async function onIgnore(record) {
    if (!apiUrl || state.busy || state.rowBusy.has(record.id)) return;
    // Ignore deletes the Log row and persists the ignored key; recovery needs a
    // manual Sheet edit, so require an explicit confirmation.
    if (!window.confirm('忽略此非家中車輛紀錄？紀錄會從帳單移除，且無法復原。')) return;
    state.rowBusy.add(record.id);
    render();
    try {
      await ignoreSession(apiUrl, record.id);
      showToast(els.toast, '已標記為非家中車輛。');
      await refreshOrWarn('已忽略，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '忽略失敗，請檢查網絡後重試。'));
    } finally {
      state.rowBusy.delete(record.id);
      render();
    }
  }

  async function onCancelPending(record) {
    if (!apiUrl || state.busy || state.rowBusy.has(record.id)) return;
    if (!window.confirm('取消呢次手動開始？紀錄會刪除。')) return;
    state.rowBusy.add(record.id);
    render();
    try {
      await deleteRecord(apiUrl, record.id, { car: record.car });
      showToast(els.toast, '已取消手動開始。');
      await refreshOrWarn('已取消，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '取消失敗，請檢查網絡後重試。'));
    } finally {
      state.rowBusy.delete(record.id);
      render();
    }
  }

  async function onReassign(record, select) {
    const car = select.value;
    if (!car) {
      showToast(els.toast, '請先選擇車輛。');
      return;
    }
    if (car === record.car) {
      showToast(els.toast, '請選擇其他車輛。');
      return;
    }
    if (!apiUrl || state.busy || state.rowBusy.has(record.id)) return;
    state.rowBusy.add(record.id);
    render();
    try {
      await reassignSession(apiUrl, record.id, car);
      showToast(els.toast, '已改派。');
      await refreshOrWarn('已改派，但未能載入最新資料，請重新載入。');
    } catch (error) {
      state.offline = true;
      showToast(els.toast, friendlyError(error, '改派失敗，請檢查網絡後重試。'));
    } finally {
      state.rowBusy.delete(record.id);
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
    const wasCharging = state.lastLiveCharging;
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
    els.liveKwh.textContent = live.active ? `≈ ${live.kWh.toFixed(2)}` : '—';
    els.liveCost.textContent = live.active && live.cost !== null ? `≈$${live.cost.toFixed(2)}` : '—';
    const parts = [];
    if (!live.available) parts.push('暫時讀取唔到充電樁狀態，會自動重試。');
    else if (live.active) {
      const row = state.liveStartRow;
      const car = row ? state.cars.find((item) => item.id === row.car) : null;
      const label = row ? `（${car ? car.name : row.car} · ${formatHkTime12(row.startAt)} 開始）` : '';
      parts.push(`估算按現時電價計算${label}，完成後以 Tesla 紀錄為準。`);
    } else if (charging) parts.push('充電樁充電中；完成後會自動配對。');
    else parts.push('充電樁而家未充電。');
    if (live.sampledAt) parts.push(`最後取樣 ${formatHkTime12(live.sampledAt)}`);
    els.liveHint.textContent = parts.join(' ');
    if (wasCharging && !charging && live.available) void refreshRecords();
  }

  async function refreshRecords() {
    if (!apiUrl) return;
    try {
      await refreshData();
      render();
    } catch {
      // keep the last good data until the next visibility refresh
    }
  }

  function onExport() {
    const value = els.month.value || 'all';
    const billable = filterByPeriod(state.records, value, normalizeBillRows(state.bills)).filter((record) => (
      record.car && record.car !== 'unassigned' && record.source !== 'legacy'
    ));
    if (billable.length === 0) return;
    const carNames = {};
    for (const car of state.cars) carNames[car.id] = car.name;
    const suffix = value === 'all'
      ? ''
      : value.startsWith('bill:')
        ? `-bill-${value.slice(5).replace(':', '_')}`
        : `-${value}`;
    downloadCsv(toCsv(billable, { carNames, rates: state.rates }), `ev-charge-all${suffix}.csv`);
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
    startSnapshotPolling({
      apiUrl,
      onSnapshot: renderSnapshot,
      onError: (error) => {
        els.snapshotPanel.hidden = false;
        els.snapshotWarning.hidden = false;
        els.snapshotWarning.textContent = `相片更新失敗（${friendlyError(error, '可能係網絡問題')}）；每分鐘重試。`;
      },
    });
    startChargerLive({
      apiUrl,
      getStartAt: () => {
        const row = state.records.find((record) => (
          record.source === 'manual' && record.car && record.car !== 'unassigned'
          && record.kWh === null && !record.teslaKey
        ));
        state.liveStartRow = row || null;
        return row ? row.startAt : null;
      },
      getRates: () => state.rates,
      onChange: renderLive,
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - state.lastFetchAt < 60000) return;
      void load();
    });
  }
  void load();
}
