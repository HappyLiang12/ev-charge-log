import test from 'node:test';
import assert from 'node:assert/strict';
import { formatHkDate, formatHkTime12, monthKey } from '../logic.js';
import {
  BILLS_HEADER,
  FUEL_URL,
  TARIFF_URL,
  createHarness,
  defaultSheets,
  loadUi,
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
    evidenceUrl: '',
    suggestedCar: '',
    suggestionConfidence: null,
    suggestionPlate: '',
    suggestionStatus: '',
    identifiedAt: null,
    suggestionEngine: '',
    suggestionSnapshotId: '',
  };
}

function assignedRecord(id, startAt) {
  return {
    id,
    car: 'model3',
    startAt,
    kWh: 12,
    durationSec: 3600,
    teslaStartAt: startAt,
    teslaEndAt: new Date(Date.parse(startAt) + 3600 * 1000).toISOString(),
    peakKWh: 0,
    offPeakKWh: 12,
    teslaKey: `din:${id}`,
    source: 'tesla',
    evidenceUrl: '',
    suggestedCar: '',
    suggestionConfidence: null,
    suggestionPlate: '',
    suggestionStatus: '',
    identifiedAt: null,
    suggestionEngine: '',
    suggestionSnapshotId: '',
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

test('family UI: a live claim shows the auto-claim state', { timeout: 20000 }, async () => {
  const startAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const sheets = defaultSheets({
    records: [{ id: 'live-claim', car: 'model3', startAt, kWh: null, source: 'live' }],
  });
  const harness = await createHarness({ sheets, livePowerW: 7200 });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('startBtn').textContent === '已自動認領', 12000);
    assert.equal(ui.document.getElementById('startBtn').disabled, true);
    assert.match(ui.document.getElementById('familyStartHintText').textContent, /自動認領 · 完成後自動入帳 · 24 小時後失效/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: QR start is refused while the charger is charging', { timeout: 20000 }, async () => {
  const harness = await createHarness({ livePowerW: 7200 });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3&start=1' });
  try {
    await waitFor(() => /充電樁而家充緊電/.test(ui.document.getElementById('familyToast').textContent), 12000);
    assert.equal(harness.env.call('readLog_').length, 0);
    assert.equal(ui.document.getElementById('startBtn').disabled, true);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: pending count chip and data freshness are visible', { timeout: 20000 }, async () => {
  const now = Date.now();
  const sheets = defaultSheets({
    records: [
      { id: 'manual-pending', car: 'model3', startAt: new Date(now - 10 * 60000).toISOString(), kWh: null, source: 'manual' },
    ],
  });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerPendingCount').hidden === false, 12000);
    assert.match(ui.document.getElementById('ownerPendingCount').textContent, /待配對 1/);
    assert.match(ui.document.getElementById('ownerUpdatedAt').textContent, /資料更新於/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: no snapshot shows a camera placeholder instead of hiding the panel', { timeout: 20000 }, async () => {
  const harness = await createHarness();
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerSnapshotWarning').hidden === false, 12000);
    assert.match(ui.document.getElementById('ownerSnapshotWarning').textContent, /相機未有新相片/);
    assert.equal(ui.document.getElementById('ownerSnapshotPanel').hidden, false);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: suggested unassigned groups open by default', { timeout: 20000 }, async () => {
  const startAt = new Date(Date.now() - 10 * 86400000).toISOString();
  const record = {
    ...unassignedRecord('u-matched', startAt, 'din:matched'),
    suggestedCar: 'model3',
    suggestionConfidence: 0.9,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
  };
  const sheets = defaultSheets({ records: [record] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.querySelector('#familyUnassigned details[open]'), 12000);
    assert.match(ui.document.getElementById('familyUnassigned').textContent, /認領/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: an invalid link shows a persistent error with retry', { timeout: 20000 }, async () => {
  const harness = await createHarness();
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=unknown' });
  try {
    await waitFor(() => ui.document.getElementById('familyError').hidden === false, 12000);
    assert.match(ui.document.getElementById('familyErrorText').textContent, /車輛連結無效/);
    assert.equal(ui.document.getElementById('familyStatus').textContent, '錯誤');
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
    await waitFor(() => ui.document.getElementById('startBtn').textContent === '已記錄開始時間', 12000);
    assert.equal(ui.document.getElementById('startBtn').disabled, true);
    assert.match(ui.document.getElementById('familyStartHintText').textContent, /開始 · 配對後自動恢復 · 24 小時後失效/);
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
  let ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('familyStatus').textContent === '已連接');
    await waitFor(() => !ui.document.getElementById('startBtn').disabled);
    assert.equal(ui.document.getElementById('syncBtn'), null);
    assert.ok(
      Array.from(ui.document.querySelectorAll('#familyView h2'))
        .some((heading) => /充電樁紀錄/.test(heading.textContent)),
    );
    await waitFor(() => ui.document.querySelectorAll('#familyRates .owner-card').length === 1);
    assert.deepEqual(
      Array.from(ui.document.querySelectorAll('#familyView main > section h2')).map((h) => h.textContent),
      ['充電狀態', '即時快照', '帳單', '未配對充電樁紀錄', '最近紀錄', '費率與拆分', '匯出'],
    );
    assert.equal(ui.document.querySelectorAll('#familyRates .owner-card a').length, 2);

    ui.document.getElementById('startBtn').click();
    await waitFor(() => ui.document.querySelectorAll('#recentList li').length === 1);
    await waitFor(() => ui.document.getElementById('startBtn').textContent === '已記錄開始時間');
    assert.equal(ui.document.getElementById('startBtn').disabled, true);
    ui.document.getElementById('startBtn').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.env.call('readLog_').length, 1);

    // The family page syncs on load; reopening it picks up the completed session.
    ui.close();
    ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
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

    ui.document.querySelector('#recentList li .delete-btn').click();
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
    await waitFor(() => ui.document.querySelector('#familyUnassigned .owner-row-actions button'));
    assert.match(ui.document.querySelector('#familyUnassigned li').textContent, /結束 .* (AM|PM)/);
    ui.document.querySelector('#familyUnassigned .owner-row-actions button').click();
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

test('family sees a suggestion hint and no evidence', { timeout: 20000 }, async () => {
  const mine = {
    ...unassignedRecord('u-family', '2026-11-21T04:00:00.000Z', 'din:f'),
    suggestedCar: 'model3',
    suggestionConfidence: 0.9,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
  };
  const other = {
    ...unassignedRecord('u-other', '2026-11-21T03:00:00.000Z', 'din:o'),
    suggestedCar: 'leaf',
    suggestionConfidence: 0.95,
    suggestionStatus: 'matched',
    suggestionEngine: 'plate',
    evidenceUrl: 'https://drive.google.com/file/d/file-2/view',
  };
  const sheets = defaultSheets({ records: [mine, other] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.querySelector('.suggestion-label'), 12000);
    const hints = ui.document.querySelectorAll('#familyUnassigned .suggestion-label');
    assert.equal(hints.length, 1);
    assert.match(hints[0].textContent, /系統建議係你（90%），請認領/);
    assert.equal(ui.document.querySelector('.evidence-link'), null);
    assert.doesNotMatch(ui.document.getElementById('familyUnassigned').innerHTML, /drive\.google\.com/);
    assert.doesNotMatch(ui.document.getElementById('familyUnassigned').textContent, /視覺|車牌/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: charging without a manual start shows the live panel and blocks start', { timeout: 20000 }, async () => {
  const harness = await createHarness({ livePowerW: 6500 });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('familyLivePanel').hidden === false, 12000);
    assert.match(ui.document.getElementById('familyLiveState').textContent, /充電中/);
    assert.match(ui.document.getElementById('familyLivePower').textContent, /6\.5 kW/);
    assert.equal(ui.document.getElementById('familyLiveKwh').textContent, '—');
    assert.match(ui.document.getElementById('familyLiveHint').textContent, /完成後會自動配對/);
    const start = ui.document.getElementById('startBtn');
    assert.equal(start.disabled, true);
    assert.match(start.textContent, /充電樁充電中/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: unassigned list only shows the last 30 days', { timeout: 20000 }, async () => {
  const oldIso = new Date(Date.now() - 60 * 86400000).toISOString();
  const recentIso = new Date(Date.now() - 2 * 86400000).toISOString();
  const sheets = defaultSheets({
    records: [
      unassignedRecord('u-old', oldIso, 'din:old'),
      unassignedRecord('u-recent', recentIso, 'din:recent'),
    ],
  });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => /11 月/.test(ui.document.getElementById('familyUnassigned').textContent), 12000);
    const text = ui.document.getElementById('familyUnassigned').textContent;
    assert.doesNotMatch(text, /9 月/);
    assert.doesNotMatch(text, /u-old/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner sees the latest snapshot card with capture time and mode', { timeout: 20000 }, async () => {
  const snapshotsHeader = [
    'id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height',
    'bytes', 'source', 'createdAt', 'crop',
  ];
  const sheets = {
    ...defaultSheets({ records: [assignedRecord('r-snapshot', '2026-11-21T04:00:00.000Z')] }),
    Snapshots: [
      snapshotsHeader,
      ['snap-old', '2026-11-21T08:00:00.000Z', 'file-old',
        'https://drive.google.com/file/d/file-old/view', 1920, 1080, 100, 'pi',
        '2026-11-21T08:00:05.000Z', 'full'],
      ['snap-new', '2026-11-21T09:07:07.000Z', 'file-new',
        'https://drive.google.com/file/d/file-new/view', 1920, 1080, 100, 'pi',
        '2026-11-21T09:07:12.000Z', 'full'],
    ],
  };
  const harness = await createHarness({ sheets });
  harness.env.driveFiles.push({ id: 'file-new', getBlob: () => ({ getBytes: () => [0xff, 0xd8, 0xff, 0xd9] }) });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerSnapshotPanel').hidden === false, 12000);
    const img = ui.document.getElementById('ownerSnapshotImg');
    await waitFor(() => /^data:image\/jpeg;base64,/.test(img.src), 12000);
    assert.match(ui.document.getElementById('ownerSnapshotTime').textContent, /拍攝於/);
    assert.match(ui.document.getElementById('ownerSnapshotHint').textContent, /全畫面/);
    assert.equal(ui.document.querySelector('#ownerSnapshotPanel a'), null);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner sees snapshot, engine, confidence, adopt, and ignore', { timeout: 20000 }, async () => {
  const record = {
    ...unassignedRecord('u-suggest', '2026-11-21T04:00:00.000Z', 'din:s'),
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
    suggestedCar: 'model3',
    suggestionConfidence: 0.84,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
  };
  const sheets = defaultSheets({ records: [record] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.querySelector('.suggestion-label'), 12000);
    const when = `${formatHkDate(record.startAt)} ${formatHkTime12(record.startAt)}`;
    assert.match(ui.document.querySelector('.suggestion-label').textContent, /Model 3.*84%/);
    assert.match(ui.document.querySelector('.suggestion-label').textContent, /視覺/);
    const select = ui.document.querySelector('#ownerPending select');
    const adopt = ui.document.querySelector('.owner-suggestion');
    const ignore = ui.document.querySelector('.owner-ignore');
    assert.equal(adopt.getAttribute('aria-label'), `採用建議（${when}）`);
    assert.equal(ignore.getAttribute('aria-label'), `非家中車輛（忽略，${when}）`);
    adopt.click();
    assert.equal(select.value, 'model3');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const unchanged = harness.env.call('readLog_');
    assert.equal(unchanged.length, 1);
    assert.equal(unchanged[0].car, 'unassigned');
    assert.ok(ignore);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: engine labels and the manual-selection fallback', { timeout: 20000 }, async () => {
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const plate = {
    ...unassignedRecord('u-plate', at(1), 'din:p'),
    evidenceUrl: 'https://drive.google.com/file/d/file-plate/view',
    suggestedCar: 'leaf',
    suggestionConfidence: 0.98,
    suggestionStatus: 'matched',
    suggestionEngine: 'plate',
  };
  const unknown = {
    ...unassignedRecord('u-unknown', at(2), 'din:u'),
    evidenceUrl: 'https://drive.google.com/file/d/file-unknown/view',
    suggestionStatus: 'unknown',
  };
  const failed = {
    ...unassignedRecord('u-error', at(3), 'din:e'),
    evidenceUrl: 'https://drive.google.com/file/d/file-error/view',
    suggestionStatus: 'error',
  };
  const limited = {
    ...unassignedRecord('u-limited', at(4), 'din:r'),
    evidenceUrl: 'https://drive.google.com/file/d/file-limited/view',
    suggestionStatus: 'rate_limited',
  };
  const fallback = {
    ...unassignedRecord('u-fallback', at(5), 'din:x'),
    evidenceUrl: 'https://drive.google.com/file/view',
    suggestionStatus: 'unknown',
  };
  const tampered = {
    ...unassignedRecord('u-tampered', at(6), 'din:t'),
    suggestedCar: 'leaf',
    suggestionConfidence: 0.5,
    suggestionStatus: 'matched',
    suggestionEngine: 'constructor',
  };
  const sheets = defaultSheets({ records: [plate, unknown, failed, limited, fallback, tampered] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.querySelectorAll('#ownerPending .suggestion-label').length === 6, 12000);
    const labels = Array.from(
      ui.document.querySelectorAll('#ownerPending .suggestion-label'),
      (label) => label.textContent,
    );
    assert.ok(labels.some((text) => /建議：Leaf（98%，車牌）/.test(text)));
    // An unknown engine string must not resolve to Object.prototype members.
    assert.ok(labels.some((text) => /建議：Leaf（50%）/.test(text)));
    assert.ok(labels.every((text) => !/function/.test(text)));
    assert.equal(labels.filter((text) => /未能辨識，請人手選擇/.test(text)).length, 2);
    assert.equal(labels.filter((text) => /辨識失敗，請人手選擇/.test(text)).length, 2);
    const limitedRow = Array.from(ui.document.querySelectorAll('#ownerPending > li'))
      .find((row) => row.textContent.includes(formatHkTime12(limited.startAt)));
    assert.match(limitedRow.querySelector('.suggestion-label').textContent, /辨識失敗/);
    assert.equal(ui.document.querySelectorAll('#ownerPending .owner-ignore').length, 6);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: ignoring an unassigned session deletes it and records guest feedback', { timeout: 20000 }, async () => {
  const record = {
    ...unassignedRecord('u-ignore', '2026-11-21T04:00:00.000Z', 'din:ignore'),
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
    suggestedCar: 'model3',
    suggestionConfidence: 0.6,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
  };
  const sheets = defaultSheets({ records: [record], feedback: [] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1', confirm: () => true });
  try {
    await waitFor(() => ui.document.querySelector('.owner-ignore'), 12000);
    ui.document.querySelector('.owner-ignore').click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending > li').length === 0, 12000);
    assert.match(ui.document.getElementById('ownerToast').textContent, /已標記為非家中車輛/);
    assert.equal(harness.env.call('readLog_').length, 0);
    const feedback = harness.env.call('readFeedback_');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].recordId, record.id);
    assert.equal(feedback[0].chosenCar, 'guest');
    assert.equal(feedback[0].actor, 'owner');
    assert.equal(ui.document.getElementById('ownerPendingEmpty').hidden, false);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: cancelling a manual pending start deletes the record', { timeout: 20000 }, async () => {
  const startAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sheets = defaultSheets({
    records: [{ id: 'manual-pending', car: 'model3', startAt, kWh: null, source: 'manual' }],
  });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1', confirm: () => true });
  try {
    await waitFor(() => ui.document.querySelector('#ownerPending .owner-ignore'), 12000);
    const cancel = ui.document.querySelector('#ownerPending .owner-ignore');
    assert.match(cancel.textContent, /取消開始/);
    assert.match(cancel.getAttribute('aria-label'), /取消.*手動開始紀錄/);
    cancel.click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending > li').length === 0, 12000);
    assert.match(ui.document.getElementById('ownerToast').textContent, /已取消手動開始/);
    assert.equal(harness.env.call('readLog_').length, 0);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: cancelling the ignore confirmation leaves the session untouched', { timeout: 20000 }, async () => {
  const record = {
    ...unassignedRecord('u-ignore-cancel', '2026-11-21T04:00:00.000Z', 'din:cancel'),
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
    suggestedCar: 'model3',
    suggestionConfidence: 0.6,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
  };
  const sheets = defaultSheets({ records: [record], feedback: [] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1', confirm: () => false });
  try {
    await waitFor(() => ui.document.querySelector('.owner-ignore'), 12000);
    ui.document.querySelector('.owner-ignore').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    // No POST: the Log row survives, no Feedback is appended, no toast.
    const records = harness.env.call('readLog_');
    assert.equal(records.length, 1);
    assert.equal(records[0].car, 'unassigned');
    assert.equal(harness.env.call('readFeedback_').length, 0);
    assert.doesNotMatch(ui.document.getElementById('ownerToast').textContent, /已標記/);
    assert.equal(ui.document.querySelectorAll('#ownerPending > li').length, 1);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: record photos open the revote overlay and reassign', { timeout: 20000 }, async () => {
  const startAt = `${monthKey(new Date().toISOString())}-01T04:00:00.000Z`;
  const capturedAt = new Date(Date.parse(startAt) + 3 * 60 * 1000).toISOString();
  const record = {
    ...assignedRecord('assigned-1', startAt),
    suggestedCar: 'model3',
    suggestionConfidence: 0.98,
    suggestionPlate: 'AB1234',
    suggestionStatus: 'matched',
    identifiedAt: startAt,
    suggestionEngine: 'plate',
    suggestionSnapshotId: 'snap-photo',
  };
  const sheets = {
    ...defaultSheets({ records: [record], feedback: [] }),
    Snapshots: [
      ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt', 'crop'],
      ['snap-photo', capturedAt, 'file-photo', 'https://drive.google.com/file/d/file-photo/view',
        960, 750, 100, 'pi', capturedAt, '0:550:960:750'],
    ],
  };
  const harness = await createHarness({ sheets });
  harness.env.driveFiles.push({ id: 'file-photo', getBlob: () => ({ getBytes: () => [0xff, 0xd8, 0xff, 0xd9] }) });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.querySelector('#ownerAssigned .record-photo-button:not(.loading)'), 12000);
    const photo = ui.document.querySelector('#ownerAssigned .record-photo-button');
    assert.match(photo.querySelector('img').src, /^data:image\/jpeg;base64,/);
    photo.click();
    const overlay = ui.document.querySelector('.photo-overlay');
    assert.ok(overlay);
    assert.match(overlay.querySelector('.photo-large').src, /^data:image\/jpeg;base64,/);
    const picker = overlay.querySelector('.photo-actions select');
    picker.value = 'leaf';
    overlay.querySelector('.photo-actions button').click();
    await waitFor(() => harness.env.call('readLog_').some((row) => row.car === 'leaf'), 12000);
    assert.equal(ui.document.querySelector('.photo-overlay'), null);
    assert.match(ui.document.getElementById('ownerToast').textContent, /已改派/);
    const feedback = harness.env.call('readFeedback_');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].recordId, record.id);
    assert.equal(feedback[0].chosenCar, 'leaf');
    assert.equal(feedback[0].actor, 'owner');
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: every assigned record in the period is rendered and reassignable', { timeout: 20000 }, async () => {
  const month = monthKey(new Date().toISOString());
  const records = [];
  for (let day = 1; day <= 11; day += 1) {
    records.push(assignedRecord(`assigned-${day}`, `${month}-${String(day).padStart(2, '0')}T04:00:00.000Z`));
  }
  const oldest = records[0];
  const harness = await createHarness({ sheets: defaultSheets({ records }) });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.querySelectorAll('#ownerAssigned > li').length === 11, 12000);
    const rows = Array.from(ui.document.querySelectorAll('#ownerAssigned > li'));
    const oldestLabel = `${formatHkDate(oldest.startAt)} ${formatHkTime12(oldest.startAt)}`;
    assert.equal(rows[0].querySelector('.owner-row-head span').textContent, `${formatHkDate(records[10].startAt)} ${formatHkTime12(records[10].startAt)}`);
    assert.equal(rows[10].querySelector('.owner-row-head span').textContent, oldestLabel);
    const select = rows[10].querySelector('select');
    assert.equal(select.value, 'model3');
    assert.equal(
      select.getAttribute('aria-label'),
      `改派 ${oldestLabel} 的車輛`,
    );
    const reassign = rows[10].querySelector('.owner-reassign');
    assert.ok(reassign);
    assert.equal(reassign.disabled, false);
    assert.equal(ui.document.getElementById('ownerAssignedEmpty').hidden, true);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: record photos open the revote overlay and reassign with family feedback', { timeout: 20000 }, async () => {
  const startAt = '2026-11-21T04:00:00.000Z';
  const capturedAt = new Date(Date.parse(startAt) + 2 * 60 * 1000).toISOString();
  const record = {
    ...assignedRecord('fam-photo', startAt),
    suggestionSnapshotId: 'snap-fam',
  };
  const sheets = {
    ...defaultSheets({ records: [record] }),
    Snapshots: [
      ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt', 'crop'],
      ['snap-fam', capturedAt, 'file-fam', 'https://drive.google.com/file/d/file-fam/view',
        960, 750, 100, 'pi', capturedAt, '0:550:960:750'],
    ],
  };
  const harness = await createHarness({ sheets });
  harness.env.driveFiles.push({ id: 'file-fam', getBlob: () => ({ getBytes: () => [0xff, 0xd8, 0xff, 0xd9] }) });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.querySelector('#recentList .record-photo-button:not(.loading)'), 12000);
    ui.document.querySelector('#recentList .record-photo-button').click();
    const overlay = ui.document.querySelector('.photo-overlay');
    assert.ok(overlay);
    const picker = overlay.querySelector('.photo-actions select');
    assert.deepEqual(Array.from(picker.options, (option) => option.value), ['', 'leaf']);
    picker.value = 'leaf';
    overlay.querySelector('.photo-actions button').click();
    await waitFor(() => harness.env.call('readLog_').some((row) => row.car === 'leaf'), 12000);
    assert.match(ui.document.getElementById('familyToast').textContent, /已改派/);
    const feedback = harness.env.call('readFeedback_');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].recordId, record.id);
    assert.equal(feedback[0].chosenCar, 'leaf');
    assert.equal(feedback[0].actor, 'family');
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
    assert.equal(ui.document.getElementById('ownerSyncBtn').textContent, '同步紀錄');
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
    ui.document.querySelectorAll('#ownerPending .owner-row-actions button:not(.owner-ignore)')[0].click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending li').length === 1);
    await waitFor(() => harness.env.call('readLog_').some((record) => record.car === 'leaf'));

    const secondSelect = ui.document.querySelector('#ownerPending select');
    await waitFor(() => !secondSelect.disabled);
    secondSelect.value = 'model3';
    ui.document.querySelector('#ownerPending .owner-row-actions button:not(.owner-ignore)').click();
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
    const liveKwh = () => Number(ui.document.getElementById('ownerLiveKwh').textContent.replace(/[^0-9.]/g, ''));
    await waitFor(() => liveKwh() > 0, 12000);
    const firstKwh = liveKwh();
    assert.ok(firstKwh > 0);
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.ok(liveKwh() > firstKwh);
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
    assert.match(card.textContent, /帳單高峰 77 \/ 非高峰 809/);

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
    set('ownerBillCutoff', '2026-11-04T22:59:27');
    await waitFor(() => ui.document.querySelectorAll('#ownerBillPreview .bill-table tr').length >= 3);
    ui.document.getElementById('ownerBillSave').click();
    await waitFor(() => {
      const rows = harness.env.call('readBills_');
      return rows.length === 1
        && Number(rows[0].total) === 900
        && rows[0].cutoff === '2026-11-04T14:59:27.000Z';
    });
    assert.match(ui.document.getElementById('ownerToast').textContent, /帳單已記錄/);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: saving a bill learns per-car peak factors', { timeout: 25000 }, async () => {
  const records = [
    {
      id: 'ix3-oct', car: 'ix3', startAt: '2026-10-10T10:00:00.000Z', kWh: 100,
      durationSec: 7200, teslaStartAt: '2026-10-10T10:00:00.000Z', teslaEndAt: '2026-10-10T12:00:00.000Z',
      peakKWh: 100, offPeakKWh: 0, teslaKey: 'din:ix3-oct', source: 'tesla',
    },
    {
      id: 'm3-oct', car: 'model3', startAt: '2026-10-20T10:00:00.000Z', kWh: 80,
      durationSec: 7200, teslaStartAt: '2026-10-20T10:00:00.000Z', teslaEndAt: '2026-10-20T12:00:00.000Z',
      peakKWh: 80, offPeakKWh: 0, teslaKey: 'din:m3-oct', source: 'tesla',
    },
  ];
  const sheets = defaultSheets({
    rates: [rateRow('2026-10', 46.2), rateRow('2026-11', 47.4)],
    records,
    cars: [['ix3', 'iX3', true, 'x'], ['model3', 'Model 3', true, 'x']],
  });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    ui.document.getElementById('ownerBillManualBtn').click();
    const set = (id, value) => {
      const input = ui.document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
    };
    set('ownerBillStart', '2026-10-03');
    set('ownerBillEnd', '2026-11-04');
    set('ownerBillUnits', '180');
    set('ownerBillTotal', '500');
    set('ownerBillPeak', '98');
    set('ownerBillOff', '82');
    set('ownerBillCutoff', '2026-11-04T22:59:27');
    await waitFor(() => ui.document.querySelectorAll('#ownerBillPreview .bill-table tr').length >= 3);
    ui.document.getElementById('ownerBillSave').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('已按 1 張帳單校準'));
    await waitFor(() => harness.env.call('readCars_')
      .some((car) => car.id === 'model3' && car.peakFactor === 0));
    const model3Card = Array.from(ui.document.querySelectorAll('#ownerCarTotals .owner-card'))
      .find((card) => card.textContent.includes('Model 3'));
    assert.ok(model3Card);
    assert.ok(model3Card.textContent.includes('高峰係數'));
    assert.ok(model3Card.textContent.includes('0.00（按帳單校準）'));
    const model3 = harness.env.call('readLog_').find((record) => record.id === 'm3-oct');
    assert.equal(model3.peakKWh, 0);
    assert.equal(model3.offPeakKWh, 80);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('owner UI: bill period is the default summary and publishing is blocked by unassigned sessions', { timeout: 30000 }, async () => {
  const records = [
    {
      id: 'ix3-oct', car: 'ix3', startAt: '2026-10-10T10:00:00.000Z', kWh: 600,
      durationSec: 7200, teslaStartAt: '2026-10-10T10:00:00.000Z', teslaEndAt: '2026-10-10T12:00:00.000Z',
      peakKWh: 600, offPeakKWh: 0, teslaKey: 'din:ix3-oct', source: 'tesla',
    },
    {
      id: 'm3-oct', car: 'model3', startAt: '2026-10-20T10:00:00.000Z', kWh: 200,
      durationSec: 7200, teslaStartAt: '2026-10-20T10:00:00.000Z', teslaEndAt: '2026-10-20T12:00:00.000Z',
      peakKWh: 200, offPeakKWh: 0, teslaKey: 'din:m3-oct', source: 'tesla',
    },
    unassignedRecord('u-1', '2026-10-12T10:00:00.000Z', 'din:u1'),
  ];
  const sheets = defaultSheets({
    rates: [rateRow('2026-10', 46.2), rateRow('2026-11', 47.4)],
    records,
    cars: [['ix3', 'iX3', true, 'x'], ['model3', 'Model 3', true, 'x']],
  });
  const harness = await createHarness({ sheets });
  const bill = {
    periodStart: '2026-10-03',
    periodEnd: '2026-11-04',
    cutoff: '2026-11-04T22:59:27+08:00',
    units: 880,
    peakKWh: 800,
    offPeakKWh: 80,
    total: 1280,
  };
  const saved = JSON.parse(harness.env.call('doPost', {
    postData: { contents: JSON.stringify({ action: 'bill', bill }) },
  }).getContent());
  assert.equal(saved.ok, true);
  assert.equal(saved.bill.publishedAt, '');
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.getElementById('ownerStatus').textContent === '已連接');
    const month = ui.document.getElementById('ownerMonth');
    assert.equal(month.value, 'bill:2026-10-03:2026-11-04');
    assert.match(month.selectedOptions[0].textContent, /帳單 2026-10-03 – 2026-11-04/);
    await waitFor(() => ui.document.querySelectorAll('#ownerBills .bill-card').length === 1);
    const publishButton = ui.document.querySelector('#ownerBills .bill-publish button');
    assert.equal(publishButton.textContent, '發布分攤');
    assert.equal(publishButton.disabled, true);
    assert.match(ui.document.getElementById('ownerBills').textContent, /仍有 1 筆未分配/);
    assert.match(ui.document.getElementById('ownerCarTotals').textContent, /600\.0/);

    const select = ui.document.querySelector('#ownerPending select');
    select.value = 'ix3';
    ui.document.querySelector('#ownerPending .owner-row-actions button:not(.owner-ignore)').click();
    await waitFor(() => ui.document.querySelectorAll('#ownerPending li').length === 0);
    await waitFor(() => !ui.document.querySelector('#ownerBills .bill-publish button').disabled);
    ui.document.querySelector('#ownerBills .bill-publish button').click();
    await waitFor(() => ui.document.getElementById('ownerToast').textContent.includes('已發布分攤'));
    await waitFor(() => ui.document.getElementById('ownerBills').textContent.includes('已發布'));
    assert.ok(harness.env.call('readBills_')[0].publishedAt);

    const family = JSON.parse(harness.env.call('doGet', { parameter: { car: 'ix3' } }).getContent());
    assert.equal(family.ok, true);
    assert.equal(family.bills.length, 1);
    assert.equal(family.bills[0].myKWh, 612);
    assert.equal(Math.round(family.bills[0].myShare * 10000) / 10000, 0.7537);
    assert.equal(Math.round(family.bills[0].myAmount * 100) / 100, 964.73);
  } finally {
    ui.close();
    await harness.close();
  }
});

test('family UI: published bill period drives the summary and shows the payable share', { timeout: 30000 }, async () => {
  const records = [
    {
      id: 'ix3-oct', car: 'ix3', startAt: '2026-10-10T10:00:00.000Z', kWh: 600,
      durationSec: 7200, teslaStartAt: '2026-10-10T10:00:00.000Z', teslaEndAt: '2026-10-10T12:00:00.000Z',
      peakKWh: 600, offPeakKWh: 0, teslaKey: 'din:ix3-oct', source: 'tesla',
    },
    {
      id: 'm3-oct', car: 'model3', startAt: '2026-10-20T10:00:00.000Z', kWh: 200,
      durationSec: 7200, teslaStartAt: '2026-10-20T10:00:00.000Z', teslaEndAt: '2026-10-20T12:00:00.000Z',
      peakKWh: 200, offPeakKWh: 0, teslaKey: 'din:m3-oct', source: 'tesla',
    },
  ];
  const sheets = defaultSheets({
    rates: [rateRow('2026-10', 46.2), rateRow('2026-11', 47.4)],
    records,
    cars: [['ix3', 'iX3', true, 'x'], ['model3', 'Model 3', true, 'x']],
  });
  const harness = await createHarness({ sheets });
  const bill = {
    periodStart: '2026-10-03',
    periodEnd: '2026-11-04',
    cutoff: '2026-11-04T22:59:27+08:00',
    units: 880,
    peakKWh: 800,
    offPeakKWh: 80,
    total: 1280,
  };
  const saved = JSON.parse(harness.env.call('doPost', {
    postData: { contents: JSON.stringify({ action: 'bill', bill }) },
  }).getContent());
  assert.equal(saved.ok, true);
  const published = JSON.parse(harness.env.call('doPost', {
    postData: { contents: JSON.stringify({ action: 'publishBill', periodStart: '2026-10-03', periodEnd: '2026-11-04' }) },
  }).getContent());
  assert.equal(published.ok, true);
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.getElementById('familyStatus').textContent === '已連接');
    await waitFor(() => !ui.document.getElementById('familyBillsPanel').hidden);
    const month = ui.document.getElementById('monthSelect');
    assert.equal(month.value, 'bill:2026-10-03:2026-11-04');
    assert.equal(ui.document.getElementById('familyKwh').textContent, '200.0');
    assert.equal(ui.document.getElementById('familyCount').textContent, '1');
    assert.equal(ui.document.getElementById('familyCost').textContent, '$367.40');
    const text = ui.document.getElementById('familyBills').textContent;
    assert.match(text, /應付 \$320\.00/);
    assert.match(text, /你 200\.0 度 · 佔 25\.0%/);
    assert.match(text, /帳單 \$1280\.00/);
  } finally {
    ui.close();
    await harness.close();
  }
});
