import test from 'node:test';
import assert from 'node:assert/strict';
import {
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

test('family UI: start, sync Tesla, and delete through the live API contract', { timeout: 20000 }, async () => {
  const sessionStart = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const harness = await createHarness({ teslaSessions: [teslaSession(sessionStart)] });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('familyStatus').textContent === '已連接');
    await waitFor(() => !ui.document.getElementById('startBtn').disabled);

    ui.document.getElementById('startBtn').click();
    await waitFor(() => ui.document.querySelectorAll('#recentList li').length === 1);

    ui.document.getElementById('syncBtn').click();
    await waitFor(() => ui.document.getElementById('familyKwh').textContent === '12.0');
    assert.equal(ui.document.getElementById('familyCount').textContent, '1');
    assert.match(ui.document.getElementById('recentList').textContent, /12\.00 kWh/);

    const log = harness.env.call('readLog_');
    assert.equal(log.length, 1);
    assert.equal(log[0].car, 'model3');
    assert.equal(log[0].kWh, 12);
    assert.equal(log[0].source, 'tesla+manual');

    ui.document.querySelector('#recentList li button').click();
    await waitFor(() => ui.document.querySelectorAll('#recentList li').length === 0);
    assert.equal(harness.env.call('readLog_').length, 0);
    assert.equal(harness.env.call('readIgnored_').length, 1);
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

test('owner UI: dedupe rates, refresh CLP, source links, assign, ignore, and CSV', { timeout: 25000 }, async () => {
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

    ui.document.getElementById('ownerRatesBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('已更新 11'));
    await waitFor(() => harness.env.values('Rates').length === 12);
    await waitFor(() => ui.document.querySelectorAll('#ownerRates .owner-card').length === 11);

    const firstSelect = ui.document.querySelector('#ownerUnassigned select');
    firstSelect.value = 'leaf';
    ui.document.querySelectorAll('#ownerUnassigned li button')[0].click();
    await waitFor(() => ui.document.querySelectorAll('#ownerUnassigned li').length === 1);
    await waitFor(() => harness.env.call('readLog_').some((record) => record.car === 'leaf'));

    ui.document.querySelectorAll('#ownerUnassigned li button')[1].click();
    await waitFor(() => ui.document.querySelectorAll('#ownerUnassigned li').length === 0);
    assert.equal(harness.env.call('readIgnored_').length, 1);

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

test('owner UI: sync without a manual record imports the last 30 days as unassigned', { timeout: 20000 }, async () => {
  const sessionStart = new Date(Date.now() - 3 * 86400000).toISOString();
  const harness = await createHarness({ teslaSessions: [teslaSession(sessionStart)] });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    ui.document.getElementById('ownerSyncBtn').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('新增未分配 1'));
    await waitFor(() => ui.document.querySelector('#ownerUnassigned .unassigned-day'));
    const dayGroup = ui.document.querySelector('#ownerUnassigned .unassigned-day');
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

test('owner UI: older unassigned sessions are grouped by day and collapsed', { timeout: 20000 }, async () => {
  const now = Date.now();
  const records = [
    unassignedRecord('recent', new Date(now - 60 * 60 * 1000).toISOString(), 'din:recent'),
    unassignedRecord('old-a', new Date(now - 3 * 86400000).toISOString(), 'din:old-a'),
    unassignedRecord('old-b', new Date(now - 4 * 86400000).toISOString(), 'din:old-b'),
  ];
  const harness = await createHarness({
    sheets: defaultSheets({ rates: [rateRow('2026-11', 47.4)], records }),
  });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    assert.equal(ui.document.querySelectorAll('#ownerUnassigned > li:not(.unassigned-day)').length, 1);
    const groups = ui.document.querySelectorAll('#ownerUnassigned .unassigned-day');
    assert.equal(groups.length, 2);
    assert.equal(groups[0].querySelector('details').open, false);
    groups[0].querySelector('details').open = true;
    assert.equal(groups[0].querySelectorAll('.owner-list li').length, 1);
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
