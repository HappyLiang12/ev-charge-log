import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHkDate, formatHkTime12 } from '../logic.js';
import {
  BILLS_HEADER,
  FUEL_URL,
  TARIFF_URL,
  createHarness,
  defaultSheets,
  loadUi,
  logRow,
  rateRow,
  teslaSession,
  waitFor,
} from './integration-harness.mjs';

const RATE_MONTHS = [
  ['2026-01', 39.4],
  ['2026-02', 39.4],
  ['2026-03', 39.2],
  ['2026-04', 39.8],
  ['2026-05', 40.4],
  ['2026-06', 42.6],
  ['2026-07', 43.5],
  ['2026-08', 45.0],
  ['2026-09', 45.1],
  ['2026-10', 46.2],
  ['2026-11', 47.4],
];

function duplicateRateRows() {
  const rows = [];
  for (const [month, fuel] of RATE_MONTHS) {
    rows.push(rateRow(month, fuel));
    rows.push(rateRow(month, fuel, { duplicate: true }));
  }
  return rows;
}

function unassignedRecord(id, startAt, teslaKey) {
  return {
    id,
    car: 'unassigned',
    startAt,
    kWh: 12,
    durationSec: 3600,
    teslaStartAt: startAt,
    teslaEndAt: new Date(Date.parse(startAt) + 3600 * 1000).toISOString(),
    peakKWh: 0,
    offPeakKWh: 12,
    teslaKey,
    source: 'tesla',
  };
}

test('family UI: start=1 records a start and clears the query parameter', { timeout: 20000 }, async () => {
  const harness = await createHarness();
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3&start=1' });
  try {
    await waitFor(() => harness.env.call('readLog_').length === 1, 12000);
    await waitFor(() => !new URL(ui.window.location.href).searchParams.has('start'), 12000);
    const [record] = harness.env.call('readLog_');
    assert.equal(record.car, 'model3');
    assert.equal(record.source, 'manual');
    assert.equal(new URL(ui.window.location.href).searchParams.has('start'), false);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: start=1 does not duplicate an existing pending start', { timeout: 20000 }, async () => {
  const startAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sheets = defaultSheets({
    records: [{ id: 'manual-existing', car: 'model3', startAt, kWh: null, source: 'manual' }],
  });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3&start=1' });
  try {
    await waitFor(() => ui.document.getElementById('startBtn').disabled, 12000);
    assert.equal(ui.document.getElementById('startBtn').textContent, '已記錄開始時間');
    await waitFor(() => !new URL(ui.window.location.href).searchParams.has('start'), 12000);
    assert.match(ui.document.getElementById('familyToast').textContent, /已經記錄咗開始時間/);
    assert.equal(harness.env.call('readLog_').length, 1);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: start, sync Tesla, and delete through the live API contract', { timeout: 20000 }, async () => {
  const sessionStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const harness = await createHarness({ teslaSessions: [teslaSession(sessionStart)] });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('familyStatus').textContent === '已連接');
    await waitFor(() => !ui.document.getElementById('startBtn').disabled);
    assert.equal(ui.document.getElementById('syncBtn').textContent, '更新充電樁');
    assert.ok(
      Array.from(ui.document.querySelectorAll('#familyView h2'))
        .some((heading) => /充電樁紀錄/.test(heading.textContent)),
    );
    await waitFor(() => ui.document.querySelectorAll('#familyRates .owner-card').length === 1);
    assert.deepEqual(
      Array.from(ui.document.querySelectorAll('#familyView main > section h2')).map((h) => h.textContent),
      ['充電狀態', '未配對充電樁紀錄', '最近紀錄', '費率與拆分', '匯出'],
    );
    assert.equal(ui.document.querySelectorAll('#familyRates .owner-card a').length, 2);

    ui.document.getElementById('startBtn').click();
    await waitFor(() => ui.document.querySelectorAll('#recentList li').length === 1);
    await waitFor(() => ui.document.getElementById('startBtn').textContent === '已記錄開始時間');
    assert.equal(ui.document.getElementById('startBtn').disabled, true);
    ui.document.getElementById('startBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.env.call('readLog_').length, 1);

    ui.document.getElementById('syncBtn').click();
    await waitFor(() => ui.document.getElementById('familyKwh').textContent === '12.0');
    assert.equal(ui.document.getElementById('familyCount').textContent, '1');
    assert.match(ui.document.getElementById('recentList').textContent, /12\.00 kWh/);
    await waitFor(() => !ui.document.getElementById('startBtn').disabled);
    assert.equal(ui.document.getElementById('startBtn').textContent, '⚡ 開始充電');

    const log = harness.env.call('readLog_');
    assert.equal(log.length, 1);
    assert.equal(log[0].car, 'model3');
    assert.equal(log[0].kWh, 12);
    assert.equal(log[0].source, 'tesla+manual');
    const endIso = new Date(Date.parse(log[0].teslaStartAt) + log[0].durationSec * 1000).toISOString();
    const endLabel = `至 ${
      formatHkDate(endIso) === formatHkDate(log[0].startAt) ? '' : `${formatHkDate(endIso).slice(5)} `
    }${formatHkTime12(endIso)}`;
    assert.ok(ui.document.getElementById('recentList').textContent.includes(endLabel));

    ui.document.querySelector('#recentList li button').click();
    await waitFor(() => ui.document.querySelectorAll('#recentList li').length === 0);
    await waitFor(() => ui.document.querySelectorAll('#familyUnassigned li').length === 1);
    assert.match(ui.document.getElementById('familyUnassigned').textContent, /認領/);
    const released = harness.env.call('readLog_');
    assert.equal(released.length, 1);
    assert.equal(released[0].car, 'unassigned');
    assert.equal(released[0].source, 'tesla');
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: claim an unassigned Tesla session', { timeout: 20000 }, async () => {
  const sessionStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const unassigned = unassignedRecord('u-1', sessionStart, 'din:claim');
  const harness = await createHarness({
    sheets: defaultSheets({ rates: [rateRow('2026-11', 47.4)], records: [unassigned] }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.querySelector('#familyUnassigned button'));
    assert.match(ui.document.querySelector('#familyUnassigned li').textContent, /結束 .* (AM|PM)/);
    ui.document.querySelector('#familyUnassigned button').click();
    await waitFor(() => ui.document.querySelectorAll('#familyUnassigned li').length === 0);
    assert.equal(ui.document.getElementById('familyCount').textContent, '1');
    const log = harness.env.call('readLog_');
    assert.equal(log.length, 1);
    assert.equal(log[0].car, 'model3');
    assert.equal(log[0].source, 'tesla');
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: dedupe rates, refresh CLP, source links, assign, and CSV', { timeout: 25000 }, async () => {
  const unassigned = [
    unassignedRecord('u-1', new Date(Date.now() - 10 * 60 * 1000).toISOString(), 'din:u1'),
    unassignedRecord('u-2', new Date(Date.now() - 20 * 60 * 1000).toISOString(), 'din:u2'),
  ];
  const harness = await createHarness({
    sheets: defaultSheets({ rates: duplicateRateRows(), records: unassigned }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    await waitFor(() => ui.document.querySelectorAll('#ownerRates .owner-card').length === 11);
    assert.equal(ui.document.getElementById('ownerSyncBtn').textContent, '更新充電樁');
    const details = ui.document.querySelector('#ownerRates details');
    assert.ok(details);
    assert.equal(details.open, false);
    assert.equal(details.querySelectorAll('.owner-card').length, 10);
    assert.equal(ui.document.querySelectorAll('#ownerRates > .owner-card').length, 1);
    assert.equal(
      ui.document.getElementById('ownerSheetLink').href,
      'https://docs.google.com/spreadsheets/d/fake-sheet/edit',
    );

    const november = Array.from(ui.document.querySelectorAll('#ownerRates .owner-card'))
      .find((card) => card.textContent.includes('2026-11'));
    const links = Array.from(november.querySelectorAll('a'));
    assert.deepEqual(links.map((link) => link.href), [FUEL_URL, TARIFF_URL]);

    const linkCard = ui.document.querySelector('#ownerLinks .owner-link');
    const qrButton = Array.from(linkCard.querySelectorAll('button')).find((button) => button.textContent === 'QR');
    qrButton.click();
    await waitFor(() => linkCard.querySelector('.owner-qr svg'));
    const qrDownload = linkCard.querySelector('.owner-qr a');
    assert.match(qrDownload.getAttribute('download'), /model3\.gif$/);
    assert.match(qrDownload.href, /^data:image\//);

    ui.document.getElementById('ownerRatesBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('已更新 11'));
    await waitFor(() => harness.env.values('Rates').length === 12);
    await waitFor(() => ui.document.querySelectorAll('#ownerRates .owner-card').length === 11);

    const firstSelect = ui.document.querySelector('#ownerPending select');
    await waitFor(() => !firstSelect.disabled);
    firstSelect.value = 'leaf';
    ui.document.querySelectorAll('#ownerPending li button')[0].click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending li').length === 1);
    await waitFor(() => harness.env.call('readLog_').some((record) => record.car === 'leaf'));

    const secondSelect = ui.document.querySelector('#ownerPending select');
    await waitFor(() => !secondSelect.disabled);
    secondSelect.value = 'model3';
    ui.document.querySelector('#ownerPending li button').click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending li').length === 0);
    const log = harness.env.call('readLog_');
    assert.deepEqual(Array.from(log, (record) => record.car).sort(), ['leaf', 'model3']);

    ui.document.getElementById('ownerExportBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('CSV 已下載'));
    const csv = await ui.blobs[0].text();
    assert.match(csv, /Leaf/);
    assert.match(csv, /日期,時間,車/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: one pending list includes manual starts and unassigned charger sessions', { timeout: 20000 }, async () => {
  const now = Date.now();
  const manual = {
    id: 'manual-pending',
    car: 'model3',
    startAt: new Date(now - 10 * 60 * 1000).toISOString(),
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
    source: 'manual',
  };
  const unassigned = unassignedRecord('unassigned-pending', new Date(now - 20 * 60 * 1000).toISOString(), 'din:pending');
  const harness = await createHarness({
    livePowerW: 7200,
    sheets: defaultSheets({ rates: [rateRow('2026-11', 47.4)], records: [manual, unassigned] }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    await waitFor(() => ui.document.querySelectorAll('#ownerPending > li').length === 2);
    assert.match(ui.document.getElementById('ownerPending').textContent, /等待充電樁紀錄配對/);
    assert.match(ui.document.getElementById('ownerPending').textContent, /充電樁紀錄/);
    assert.equal(ui.document.querySelectorAll('#ownerPending select').length, 1);
    await waitFor(() => ui.document.getElementById('ownerLiveState').textContent === '充電中');
    assert.equal(ui.document.getElementById('ownerLivePower').textContent, '7.2 kW');
    const firstKwh = Number(ui.document.getElementById('ownerLiveKwh').textContent);
    assert.ok(firstKwh > 0);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.ok(Number(ui.document.getElementById('ownerLiveKwh').textContent) > firstKwh);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: sync without a manual record imports the last 30 days as unassigned', { timeout: 20000 }, async () => {
  const sessionStart = new Date(Date.now() - 3 * 86400000).toISOString();
  const harness = await createHarness({ teslaSessions: [teslaSession(sessionStart)] });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    ui.document.getElementById('ownerSyncBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('新增未分配 1'));
    await waitFor(() => ui.document.querySelector('#ownerPending .unassigned-day'));
    const dayGroup = ui.document.querySelector('#ownerPending .unassigned-day');
    assert.equal(dayGroup.querySelector('details').open, false);
    assert.equal(dayGroup.querySelectorAll('.owner-list li').length, 1);
    const log = harness.env.call('readLog_');
    assert.equal(log.length, 1);
    assert.equal(log[0].car, 'unassigned');
    assert.equal(log[0].source, 'tesla');

    ui.document.getElementById('ownerSyncBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('新增未分配 0'));
    assert.equal(harness.env.call('readLog_').length, 1);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: older unassigned sessions are grouped by month and day and collapsed', { timeout: 20000 }, async () => {
  const now = Date.now();
  const records = [
    unassignedRecord('recent', new Date(now - 60 * 60 * 1000).toISOString(), 'din:recent'),
    unassignedRecord('old-a', new Date(now - 3 * 86400000).toISOString(), 'din:old-a'),
    unassignedRecord('old-b', new Date(now - 4 * 86400000).toISOString(), 'din:old-b'),
    unassignedRecord('old-c', new Date(now - 40 * 86400000).toISOString(), 'din:old-c'),
  ];
  const harness = await createHarness({
    sheets: defaultSheets({ rates: [rateRow('2026-11', 47.4)], records }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    assert.equal(
      ui.document.querySelectorAll('#ownerPending > li:not(.unassigned-month):not(.unassigned-day)').length,
      1,
    );
    const months = ui.document.querySelectorAll('#ownerPending .unassigned-month');
    assert.equal(months.length, 2);
    assert.equal(months[0].querySelector('details').open, false);
    months[0].querySelector('details').open = true;
    const days = months[0].querySelectorAll('.unassigned-day');
    assert.equal(days.length, 2);
    assert.equal(days[0].querySelector('details').open, false);
    days[0].querySelector('details').open = true;
    assert.equal(days[0].querySelectorAll('.owner-list li').length, 1);

    const select = days[0].querySelector('select');
    select.value = 'leaf';
    days[0].querySelectorAll('.owner-row-actions button')[0].click();
    await waitFor(() => harness.env.call('readLog_').some((record) => record.car === 'leaf'));
    const reopenedMonth = Array.from(ui.document.querySelectorAll('#ownerPending .unassigned-month'))
      .find((month) => month.textContent.includes('2026-11'));
    assert.equal(reopenedMonth.querySelector('details').open, true);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: CLP parse failure shows the manual-override message and keeps rates', { timeout: 20000 }, async () => {
  const harness = await createHarness({
    fuel: 'no monthly rates here',
    sheets: defaultSheets({ rates: [rateRow('2026-11', 47.4)] }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    ui.document.getElementById('ownerRatesBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('manualOverride'));
    assert.equal(harness.env.values('Rates').length, 2);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: saved bill shows per-car amounts by kWh share and manual entry saves', { timeout: 25000 }, async () => {
  const records = [
    {
      id: 'bill-ix3', car: 'ix3', startAt: '2026-10-10T02:00:00.000Z', kWh: 600,
      durationSec: 3600, teslaStartAt: '2026-10-10T02:00:00.000Z', teslaEndAt: '2026-10-10T03:00:00.000Z',
      peakKWh: 100, offPeakKWh: 500, teslaKey: 'din:bill-ix3', source: 'tesla',
    },
    {
      id: 'bill-m3', car: 'model3', startAt: '2026-10-20T02:00:00.000Z', kWh: 200,
      durationSec: 3600, teslaStartAt: '2026-10-20T02:00:00.000Z', teslaEndAt: '2026-10-20T03:00:00.000Z',
      peakKWh: 50, offPeakKWh: 150, teslaKey: 'din:bill-m3', source: 'tesla',
    },
  ];
  const sheets = defaultSheets({
    rates: [rateRow('2026-10', 46.2), rateRow('2026-11', 47.4)],
    records,
    cars: [['ix3', 'iX3', true, 'x'], ['model3', 'Model 3', true, 'x']],
  });
  sheets.Bills = [
    BILLS_HEADER,
    ['2026-10-03', '2026-11-04', '2026-11-04T14:59:27.000Z', 886, 77, 809, 870.39, 410.32, -0.71, 1280, 'bill.pdf', '2026-11-18T00:00:00.000Z'],
  ];
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    const card = await waitFor(() => ui.document.querySelector('#ownerBills .bill-card'));
    assert.match(card.textContent, /2026-10-03 – 2026-11-04/);
    assert.match(card.textContent, /\$960\.00/);
    assert.match(card.textContent, /\$320\.00/);
    assert.match(card.textContent, /800\.0 度 vs 帳單 886 度/);
    assert.match(card.textContent, /帳單高峯 77 \/ 非高峯 809/);

    ui.document.getElementById('ownerBillManualBtn').click();
    const set = (id, value) => {
      const input = ui.document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    };
    set('ownerBillStart', '2026-10-03');
    set('ownerBillEnd', '2026-11-04');
    set('ownerBillUnits', '886');
    set('ownerBillTotal', '900');
    set('ownerBillCutoff', '2026-11-04T22:59');
    await waitFor(() => ui.document.querySelectorAll('#ownerBillPreview .bill-table tr').length >= 3);
    ui.document.getElementById('ownerBillSave').click();
    await waitFor(() => {
      const rows = harness.env.call('readBills_');
      return rows.length === 1 && Number(rows[0].total) === 900;
    });
    assert.match(ui.document.getElementById('ownerToast').textContent, /帳單已記錄/);
  } finally {
    ui.close();
    await harness.close();
  }
});
