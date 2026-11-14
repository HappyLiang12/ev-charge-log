# EV Charge Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-login, mobile-first EV charging start-time logger hosted on GitHub Pages, synced through a Google Sheet via Apps Script, with month-filtered CSV export.

**Architecture:** Static ES-module app with pure logic and DOM wiring in `app.js`; localStorage cache plus pending queue; a Google Apps Script Web App exposes GET/POST JSON over a Google Sheet. The UI has exactly two primary actions: start charging and export CSV.

**Tech Stack:** Vanilla HTML/CSS/ES modules, Node 24 built-in test runner, Google Apps Script (V8 runtime), GitHub Pages. No npm dependencies, no build step.

**Spec:** `docs/superpowers/specs/2026-11-14-ev-charge-log-design.md`

## Global Constraints

- Zero runtime dependencies, no build step, no third-party scripts or fonts.
- No secrets or tokens in the repo. `config.js` holds only the public Apps Script URL and Sheet URL.
- UI copy is Traditional Chinese (zh-HK), 24-hour time. All code, docs, and commit messages are English.
- Mobile-first layout verified at 390x844; primary button full-width and thumb-reachable.
- Persist only `ev-charge-log.cache.v1` and `ev-charge-log.pending.v1` in localStorage.
- `/Users/happy/Documents/project/tmp/ev-charge-log` is the repo root; every task ends with a commit.

---

### Task 1: Pure logic core (formatting, merge, month filter, CSV)

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `app.js`
- Create: `test/logic.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `formatLocalDate(iso)`, `formatLocalTime(iso)`, `formatWeekday(iso)`, `monthKey(iso)`, `isValidRecord(value)`, `normalizeRecords(list)`, `parseServerRecords(payload)`, `mergeRecords(serverRecords, pending)`, `monthsWithRecords(records)`, `defaultMonth(records, now)`, `filterByMonth(records, month)`, `csvEscape(value)`, `toCsv(records)`, `isRecentDuplicate(lastStartAt, nowMs, windowMs)`, `dropSyncedPending(pending, serverRecords)`, `STORAGE_KEYS`.

- [ ] **Step 1: Create `package.json` and `.gitignore`**

`package.json`:

```json
{
  "name": "ev-charge-log",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/logic.test.mjs"
  }
}
```

`.gitignore`:

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 2: Write the failing tests**

Create `test/logic.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidRecord,
  normalizeRecords,
  parseServerRecords,
  formatLocalDate,
  formatLocalTime,
  formatWeekday,
  monthKey,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  csvEscape,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
} from '../app.js';

const atLocal = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).toISOString();
const rec = (id, iso) => ({ id, startAt: iso });

test('formatLocalDate, formatLocalTime, formatWeekday use local calendar values', () => {
  const iso = atLocal(2026, 11, 14, 21, 5);
  assert.equal(formatLocalDate(iso), '2026-11-14');
  assert.equal(formatLocalTime(iso), '21:05');
  assert.equal(formatWeekday(iso), '週六');
});

test('isValidRecord accepts UUID-like ids and ISO dates only', () => {
  assert.equal(isValidRecord({ id: 'abc-123', startAt: atLocal(2026, 11, 14, 9, 0) }), true);
  assert.equal(isValidRecord({ id: 'bad id', startAt: atLocal(2026, 11, 14, 9, 0) }), false);
  assert.equal(isValidRecord({ id: 'abc', startAt: 'nope' }), false);
  assert.equal(isValidRecord(null), false);
});

test('normalizeRecords drops malformed entries and copies fields', () => {
  const good = rec('abc-123', atLocal(2026, 11, 14, 9, 0));
  const normalized = normalizeRecords([
    good,
    { id: 'bad id', startAt: good.startAt },
    { id: 'x', startAt: 'nope' },
    null,
  ]);
  assert.deepEqual(normalized, [good]);
});

test('parseServerRecords validates the envelope and entries', () => {
  const good = rec('abc-123', atLocal(2026, 11, 14, 9, 0));
  assert.deepEqual(
    parseServerRecords({ ok: true, records: [good, { id: 'x', startAt: 'nope' }] }),
    [good],
  );
  assert.throws(() => parseServerRecords({ ok: false }), /Invalid API response/);
  assert.throws(() => parseServerRecords(null), /Invalid API response/);
});

test('monthKey and filterByMonth use the local month', () => {
  const nov = rec('a', atLocal(2026, 11, 30, 23, 59));
  const dec = rec('b', atLocal(2026, 12, 1, 0, 0));
  assert.equal(monthKey(nov.startAt), '2026-11');
  assert.equal(monthKey(dec.startAt), '2026-12');
  assert.deepEqual(filterByMonth([nov, dec], '2026-11').map((r) => r.id), ['a']);
  assert.equal(filterByMonth([nov, dec], 'all').length, 2);
});

test('mergeRecords unions by id and sorts newest first', () => {
  const older = rec('a', atLocal(2026, 11, 1, 8, 0));
  const newer = rec('b', atLocal(2026, 11, 2, 8, 0));
  const merged = mergeRecords([older], [newer, older]);
  assert.deepEqual(merged.map((r) => r.id), ['b', 'a']);
});

test('monthsWithRecords and defaultMonth prefer current then newest', () => {
  const nov = rec('a', atLocal(2026, 11, 5, 9, 0));
  const oct = rec('b', atLocal(2026, 10, 5, 9, 0));
  assert.deepEqual(monthsWithRecords([oct, nov]), ['2026-11', '2026-10']);
  assert.equal(defaultMonth([nov, oct], new Date(2026, 10, 14)), '2026-11');
  assert.equal(defaultMonth([oct], new Date(2026, 10, 14)), '2026-10');
  assert.equal(defaultMonth([], new Date(2026, 10, 14)), 'all');
});

test('toCsv emits BOM, CRLF, header, and chronological rows', () => {
  const later = rec('b', atLocal(2026, 11, 14, 21, 30));
  const earlier = rec('a', atLocal(2026, 11, 14, 9, 5));
  const csv = toCsv([later, earlier]);
  assert.equal(csv, '\uFEFF日期,時間\r\n2026-11-14,09:05\r\n2026-11-14,21:30\r\n');
});

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
});

test('isRecentDuplicate only matches the last 2 seconds', () => {
  const iso = atLocal(2026, 11, 14, 21, 0);
  const t = Date.parse(iso);
  assert.equal(isRecentDuplicate(iso, t + 1500), true);
  assert.equal(isRecentDuplicate(iso, t + 2000), false);
  assert.equal(isRecentDuplicate(null, t), false);
});

test('dropSyncedPending removes ids already present on the server', () => {
  const a = rec('a', atLocal(2026, 11, 1, 1, 0));
  const b = rec('b', atLocal(2026, 11, 2, 1, 0));
  assert.deepEqual(dropSyncedPending([a, b], [a]).map((r) => r.id), ['b']);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/happy/Documents/project/tmp/ev-charge-log && npm test`

Expected: FAIL — `Cannot find module '../app.js'` or missing exports (`formatLocalDate is not a function`).

- [ ] **Step 4: Write the minimal implementation**

Create `app.js`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS — 11 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore app.js test/logic.test.mjs
git commit -m "feat: add pure logic core and tests"
```

---

### Task 2: Storage helpers and Apps Script API client

**Files:**
- Modify: `app.js` (append after `dropSyncedPending`)
- Modify: `test/logic.test.mjs` (extend imports, append tests)

**Interfaces:**
- Consumes: `normalizeRecords`, `parseServerRecords`, `formatLocalDate`, `formatLocalTime` from Task 1.
- Produces: `readStored(storage, key)` -> `{ value, corrupt }`; `writeStored(storage, key, value)` -> boolean; `fetchRecords(apiUrl, fetchImpl)` -> `Record[]`; `postRecord(apiUrl, record, fetchImpl)` -> `void`.

- [ ] **Step 1: Extend the test imports**

In `test/logic.test.mjs`, replace the import block with:

```js
import {
  isValidRecord,
  normalizeRecords,
  parseServerRecords,
  formatLocalDate,
  formatLocalTime,
  formatWeekday,
  monthKey,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  csvEscape,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
  readStored,
  writeStored,
  fetchRecords,
  postRecord,
} from '../app.js';
```

- [ ] **Step 2: Append the failing tests**

Append to `test/logic.test.mjs`:

```js
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

const fakeResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});

test('readStored handles missing, corrupt, and valid data', () => {
  const storage = fakeStorage();
  assert.deepEqual(readStored(storage, 'missing'), { value: null, corrupt: false });
  storage.setItem('bad', '{oops');
  assert.deepEqual(readStored(storage, 'bad'), { value: null, corrupt: true });
  storage.setItem('good', '[1,2]');
  assert.deepEqual(readStored(storage, 'good'), { value: [1, 2], corrupt: false });
  assert.deepEqual(readStored(null, 'good'), { value: null, corrupt: false });
});

test('writeStored returns false when storage throws', () => {
  assert.equal(writeStored({ setItem() { throw new Error('quota'); } }, 'k', 1), false);
  assert.equal(writeStored(null, 'k', 1), false);
});

test('fetchRecords sends GET and returns validated records', async () => {
  const iso = atLocal(2026, 11, 14, 9, 0);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return fakeResponse({ ok: true, records: [{ id: 'a', startAt: iso }] });
  };
  const records = await fetchRecords('https://example.test/api', fetchImpl);
  assert.deepEqual(records, [{ id: 'a', startAt: iso }]);
  assert.equal(calls[0].url, 'https://example.test/api');
  assert.equal(calls[0].init.method, 'GET');
});

test('fetchRecords throws on HTTP and envelope failures', async () => {
  await assert.rejects(
    fetchRecords('u', async () => fakeResponse(null, { ok: false, status: 500 })),
    /HTTP 500/,
  );
  await assert.rejects(
    fetchRecords('u', async () => fakeResponse({ ok: false })),
    /Invalid API response/,
  );
});

test('postRecord sends a text/plain body with local date and time', async () => {
  const iso = atLocal(2026, 11, 14, 9, 5);
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return fakeResponse({ ok: true });
  };
  await postRecord('https://example.test/api', { id: 'a', startAt: iso }, fetchImpl);
  assert.equal(captured.url, 'https://example.test/api');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(captured.init.body), {
    id: 'a',
    startAt: iso,
    date: '2026-11-14',
    time: '09:05',
  });
});

test('postRecord rejects HTTP and API-level errors', async () => {
  const record = { id: 'a', startAt: atLocal(2026, 11, 14, 9, 5) };
  await assert.rejects(
    postRecord('u', record, async () => fakeResponse(null, { ok: false, status: 502 })),
    /HTTP 502/,
  );
  await assert.rejects(
    postRecord('u', record, async () => fakeResponse({ ok: false, error: 'nope' })),
    /nope/,
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL — `readStored is not a function` (three new tests fail).

- [ ] **Step 4: Implement the helpers**

Append to `app.js` after `dropSyncedPending`:

```js
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`

Expected: PASS — 17 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add app.js test/logic.test.mjs
git commit -m "feat: add storage helpers and Apps Script API client"
```

---

### Task 3: Mobile UI shell and local-only behavior

**Files:**
- Create: `index.html`
- Create: `style.css`
- Create: `config.js`
- Create: `icon.svg`
- Modify: `app.js` (append DOM section)

**Interfaces:**
- Consumes: all pure functions from Tasks 1-2.
- Produces: DOM ids used in later tasks: `startBtn`, `exportBtn`, `monthSelect`, `statusChip`, `toast`, `summaryMonth`, `summaryTotal`, `summaryLast`, `recentList`, `emptyState`, `emptyHint`, `sheetLink`; functional local-only recording, month selection, CSV download, persistence.

- [ ] **Step 1: Create `index.html`**

```html
<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b0f0e">
  <title>EV 充電紀錄</title>
  <link rel="icon" href="icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="icon.svg">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div>
        <h1>EV 充電紀錄</h1>
        <p class="subtitle">紀錄開始充電時間</p>
      </div>
      <span id="statusChip" class="chip" data-state="idle">未設定</span>
    </header>

    <main>
      <button id="startBtn" class="primary" type="button">⚡ 開始充電</button>

      <section class="stats" aria-label="統計">
        <div class="stat">
          <span id="summaryMonth" class="stat-value">0</span>
          <span class="stat-label">本月</span>
        </div>
        <div class="stat">
          <span id="summaryTotal" class="stat-value">0</span>
          <span class="stat-label">總次數</span>
        </div>
        <div class="stat">
          <span id="summaryLast" class="stat-value stat-last">—</span>
          <span class="stat-label">最近一次</span>
        </div>
      </section>

      <section class="panel" aria-labelledby="recentTitle">
        <h2 id="recentTitle">最近紀錄</h2>
        <ul id="recentList" class="records"></ul>
        <p id="emptyState" class="empty">未有紀錄，按上面個掣開始。</p>
        <p id="emptyHint" class="hint" hidden></p>
      </section>

      <section class="panel export" aria-labelledby="exportTitle">
        <h2 id="exportTitle">匯出</h2>
        <div class="export-row">
          <select id="monthSelect" aria-label="匯出月份"></select>
          <button id="exportBtn" type="button" disabled>匯出 CSV</button>
        </div>
        <a id="sheetLink" class="sheet-link" href="#" hidden>打開 Google Sheet</a>
      </section>
    </main>

    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  </div>
  <script src="config.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `style.css`**

```css
:root {
  --bg: #070b0a;
  --surface: #101715;
  --surface-2: #16211d;
  --text: #e7f0eb;
  --muted: #93a69d;
  --accent: #4ade80;
  --accent-ink: #04140a;
  --warn: #fbbf24;
  --line: #1b2723;
  --radius: 16px;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  min-height: 100dvh;
  background: radial-gradient(120% 80% at 50% 0%, #0e1915 0%, var(--bg) 60%);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
}

.app {
  max-width: 480px;
  margin: 0 auto;
  padding: calc(16px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
  display: grid;
  gap: 16px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

h1 { font-size: 22px; margin: 0; letter-spacing: 0.01em; }

.subtitle { margin: 2px 0 0; color: var(--muted); font-size: 13px; }

.chip {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid #24322c;
  color: var(--muted);
  white-space: nowrap;
}

.chip[data-state="ok"] { color: var(--accent); border-color: #1f4a2e; background: #0c1f14; }
.chip[data-state="warn"] { color: var(--warn); border-color: #4a3a12; background: #1f1908; }

.primary {
  width: 100%;
  min-height: 72px;
  font-size: 22px;
  font-weight: 700;
  border: 0;
  border-radius: 20px;
  background: linear-gradient(180deg, #5ef08f, #34d16b);
  color: var(--accent-ink);
  box-shadow: 0 8px 24px rgb(52 209 107 / 0.25);
  cursor: pointer;
}

.primary:active { transform: translateY(1px); }

button { font: inherit; }

button:focus-visible, select:focus-visible, a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.stats { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 8px; }

.stat {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.stat-value { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.stat-last { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-label { color: var(--muted); font-size: 12px; }

.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px;
}

.panel h2 { font-size: 14px; margin: 0 0 8px; color: var(--muted); font-weight: 600; }

.records { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }

.records li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 10px 4px;
  border-bottom: 1px solid #16211d;
  font-variant-numeric: tabular-nums;
}

.records li:last-child { border-bottom: 0; }
.record-date { color: var(--text); }
.record-weekday { color: var(--muted); font-size: 12px; margin-left: 6px; }
.record-time { color: var(--accent); font-weight: 600; }
.empty { margin: 8px 4px 0; color: var(--muted); font-size: 14px; }
.hint { margin: 6px 4px 0; color: var(--muted); font-size: 12px; }

.export-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }

select, #exportBtn {
  min-height: 48px;
  border-radius: 12px;
  border: 1px solid #24322c;
  background: var(--surface-2);
  color: var(--text);
  padding: 0 12px;
  font: inherit;
}

#exportBtn {
  border: 0;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
  padding: 0 16px;
  cursor: pointer;
}

#exportBtn:disabled { opacity: 0.4; cursor: default; }

.sheet-link {
  display: inline-block;
  margin-top: 10px;
  color: var(--muted);
  font-size: 13px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

[hidden] { display: none !important; }

.toast {
  position: fixed;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom));
  transform: translate(-50%, 12px);
  background: #1c2924;
  color: var(--text);
  border: 1px solid #2b3a33;
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 14px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
  max-width: calc(100vw - 32px);
  text-align: center;
}

.toast.show { opacity: 1; transform: translate(-50%, 0); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
  .primary:active { transform: none; }
}
```

- [ ] **Step 3: Create `config.js` and `icon.svg`**

`config.js`:

```js
window.APP_CONFIG = {
  API_URL: '',
  SHEET_URL: '',
};
```

`icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#0b0f0e"/>
  <path d="M36 8 18 36h12l-4 20 20-30H34l2-18z" fill="#4ade80"/>
</svg>
```

- [ ] **Step 4: Append the DOM wiring to `app.js`**

Append:

```js
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
  els.monthSelect.addEventListener('change', render);

  render();
  if (cacheRead.corrupt || pendingRead.corrupt) {
    showToast('本機資料損壞，已重新載入');
  }

  function merged() {
    return mergeRecords(state.server, state.pending);
  }

  function persistCache() {
    writeStored(storage, STORAGE_KEYS.cache, state.server);
  }

  function persistPending() {
    writeStored(storage, STORAGE_KEYS.pending, state.pending);
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
    const preferred = previous && options.some((option) => option.value === previous)
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
```

- [ ] **Step 5: Run the unit tests**

Run: `npm test`

Expected: PASS — 17 tests, 0 failures (importing `app.js` under Node must not execute `init`).

- [ ] **Step 6: Browser smoke, local-only mode**

Run: `python3 -m http.server 8000` in the repo root.

Using the browser tool at viewport 390x844:

1. Navigate to `http://127.0.0.1:8000/`.
2. Take a snapshot; verify header, "⚡ 開始充電", empty state, chip text `未設定`, export disabled.
3. Click "開始充電"; verify a row appears, toast shows, 本月/總次數 are `1`.
4. Reload; verify the record is still there (localStorage).
5. Patch export capture and click export:
   Function: `() => { window.__csv = null; const original = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((text) => { window.__csv = text; }); return original.call(URL, blob); }; }`
   Then evaluate `() => window.__csv`; expected prefix `\uFEFF日期,時間\r\n` and one data row.
6. Inject two records in different months through localStorage (`ev-charge-log.pending.v1`) and reload; verify month selector options include two months plus 全部月份, and switching updates the export count.
7. Screenshot 390x844 for a visual check; no horizontal scroll.

Expected: all checks pass, console has no errors.

- [ ] **Step 7: Commit**

```bash
git add index.html style.css config.js icon.svg app.js
git commit -m "feat: add mobile UI with local recording and CSV export"
```

---

### Task 4: Google Sheet sync integration and offline queue

**Files:**
- Modify: `app.js` (init block, `onStart`, add `sync`/`retryPending`)
- Create: `test/dev-server.mjs`

**Interfaces:**
- Consumes: `fetchRecords`, `postRecord`, `dropSyncedPending`, `normalizeRecords`.
- Produces: sync status chip states, offline pending retry, `test/dev-server.mjs` mock API + config injection for browser smoke. API contract: GET returns `{ ok: true, records: [{ id, startAt }] }`; POST accepts `{ id, startAt, date, time }` with idempotent ids.

- [ ] **Step 1: Add the online listener and initial sync to `init`**

In `app.js`, replace:

```js
  render();
  if (cacheRead.corrupt || pendingRead.corrupt) {
    showToast('本機資料損壞，已重新載入');
  }
```

with:

```js
  window.addEventListener('online', () => {
    state.offline = false;
    void sync();
  });

  render();
  if (cacheRead.corrupt || pendingRead.corrupt) {
    showToast('本機資料損壞，已重新載入');
  }
  void sync();
```

- [ ] **Step 2: Replace `onStart` with the synced version**

Replace the entire `onStart` function in `app.js` with:

```js
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
```

- [ ] **Step 3: Add `sync` and `retryPending` inside `init`**

Insert after `persistPending`:

```js
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
```

- [ ] **Step 4: Create the mock dev server**

Create `test/dev-server.mjs`:

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const port = Number(process.env.PORT || 8787);
const apiUrl = process.env.SMOKE_API_URL || `http://127.0.0.1:${port}/api`;
const records = [];
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, records });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        if (!records.some((record) => record.id === data.id)) {
          records.push({ id: data.id, startAt: data.startAt });
        }
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 400, { ok: false, error: 'invalid payload' });
      }
      return;
    }
  }

  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (path === '/config.js') {
    res.writeHead(200, { 'Content-Type': types['.js'] });
    res.end(`window.APP_CONFIG = { API_URL: '${apiUrl}', SHEET_URL: '' };\n`);
    return;
  }

  try {
    const filePath = normalize(join(root, path));
    if (!filePath.startsWith(`${root}/`)) throw new Error('forbidden');
    const content = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': types[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${port}`);
  console.log(`mock API:  ${apiUrl}`);
});
```

- [ ] **Step 5: Browser smoke with mock sync**

Run: `PORT=8787 node test/dev-server.mjs` in one shell.

In the browser at 390x844:

1. Navigate to `http://127.0.0.1:8787/`; verify chip becomes `已連接`.
2. Click "開始充電"; verify the row appears and chip stays `已連接`.
3. Verify the mock API stored it: evaluate `async () => (await (await fetch('/api')).json())`; expect one record.
4. Reload; verify the record is still shown and the chip remains `已連接`.
5. Simulate a second device: evaluate `() => localStorage.clear()`, reload; verify the record still appears from the server.
6. Stop the dev server and start a fresh one on 8788 with an unreachable API:
   `PORT=8788 SMOKE_API_URL=http://127.0.0.1:9/api node test/dev-server.mjs`
   Navigate to `http://127.0.0.1:8788/`; verify chip `未同步` or `離線`.
   Click "開始充電"; verify the row shows, chip `未同步`, and the toast reports it will retry.
7. Restart with a reachable API on 8789 (`PORT=8789 node test/dev-server.mjs`) is a fresh store; note that the pending record from 8788 lives in a different origin, so this is only a visual check. A retry against the same origin is covered by the unit-level idempotency and the pending merge logic.
8. Verify idempotency of the mock API with two identical POSTs (server on 8787):

```bash
curl -s -X POST http://127.0.0.1:8787/api -H 'Content-Type: text/plain' --data '{"id":"t1","startAt":"2026-11-14T13:00:00.000Z"}' 
curl -s -X POST http://127.0.0.1:8787/api -H 'Content-Type: text/plain' --data '{"id":"t1","startAt":"2026-11-14T13:00:00.000Z"}'
curl -s http://127.0.0.1:8787/api
```

Expected: GET shows exactly one `t1`.

- [ ] **Step 6: Run unit tests and commit**

Run: `npm test`

Expected: PASS — 17 tests.

```bash
git add app.js test/dev-server.mjs
git commit -m "feat: sync records through the Apps Script API with offline queue"
```

---

### Task 5: Apps Script backend, README, and screenshot

**Files:**
- Create: `apps-script/Code.gs`
- Create: `README.md`
- Create: `docs/screenshot.png` (captured from the running app)

**Interfaces:**
- Consumes: the API contract from Task 4.
- Produces: a deployable Apps Script backend; complete setup docs; real screenshot for the README.

- [ ] **Step 1: Create `apps-script/Code.gs`**

```js
const SHEET_ID = 'PASTE_SHEET_ID_HERE';
const SHEET_NAME = 'Log';
const HEADER = ['id', 'startAt', '日期', '時間'];
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function getSheet_() {
  const spreadsheet = SpreadsheetApp.openById(SHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  const sheet = getSheet_();
  const last = sheet.getLastRow();
  const records = [];
  if (last > 1) {
    const values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (const row of values) {
      const id = String(row[0] || '');
      const raw = row[1];
      const startAt = raw instanceof Date ? raw.toISOString() : String(raw || '');
      if (ID_RE.test(id) && !Number.isNaN(Date.parse(startAt))) {
        records.push({ id, startAt });
      }
    }
  }
  return json_({ ok: true, records });
}

function doPost(event) {
  try {
    const body = JSON.parse((event.postData && event.postData.contents) || '{}');
    const id = String(body.id || '');
    const startAt = String(body.startAt || '');
    const date = String(body.date || '');
    const time = String(body.time || '');
    if (!ID_RE.test(id)
      || Number.isNaN(Date.parse(startAt))
      || !DATE_RE.test(date)
      || !TIME_RE.test(time)) {
      return json_({ ok: false, error: 'invalid payload' });
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = getSheet_();
      const last = sheet.getLastRow();
      if (last > 1) {
        const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
        for (const row of ids) {
          if (String(row[0]) === id) return json_({ ok: true, duplicate: true });
        }
      }
      sheet.appendRow([id, startAt, date, time]);
      return json_({ ok: true });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error) });
  }
}
```

- [ ] **Step 2: Syntax-check the backend**

Run: `node --check apps-script/Code.gs`

Expected: exit 0, no output (runtime globals are not evaluated).

- [ ] **Step 3: Create `README.md`**

````markdown
# EV Charge Log

One-tap logger for the start time of EV charging sessions. A static app on GitHub Pages; records sync through a Google Sheet using a Google Apps Script Web App. No login, no tokens.

![EV Charge Log](docs/screenshot.png)

## Features

- One full-width button records the current time and appends it to a Google Sheet.
- Quick view: this month's count, total count, last session, and the latest five records.
- CSV export for a chosen month or all months: UTF-8 BOM, CRLF, `日期,時間` columns in device-local time; opens directly in Excel, Numbers, and Google Sheets.
- Offline-friendly: records are written to localStorage immediately and retried automatically.
- Mobile-first layout designed for a 390x844 viewport.

## One-time Google Sheet setup

1. Create a Google Sheet.
2. Open Extensions -> Apps Script and replace `Code.gs` with the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Set `SHEET_ID` at the top of the script to the ID from the Sheet URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`).
4. Deploy -> New deployment -> Web app. Execute as: Me. Who has access: Anyone. Authorize the requested Sheets scope. If your account or Workspace policy does not offer "Anyone" access, stop: this zero-login design requires it.
5. Copy the Web app URL. Every deployment URL is a public capability; anyone with it can read or append rows.

The first request creates the `Log` sheet and header row automatically. Columns: `id`, `startAt`, `日期`, `時間`.

## Configure

Edit `config.js`:

```js
window.APP_CONFIG = {
  API_URL: '<Apps Script Web app URL>',
  SHEET_URL: '<Google Sheet URL>',
};
```

Both values are public by design. Do not put tokens or secrets in this repository.

## Local development

```bash
python3 -m http.server 8000   # open http://127.0.0.1:8000/
npm test                      # unit tests, Node 20+
```

Mock the API in a browser without Google:

```bash
PORT=8787 node test/dev-server.mjs   # open http://127.0.0.1:8787/
```

## Deploy on GitHub Pages

```bash
gh repo create <user>/ev-charge-log --public --source=. --remote=origin --push
gh api --method POST repos/<user>/ev-charge-log/pages -f "source[branch]=main" -f "source[path]=/"
```

Open `https://<user>.github.io/ev-charge-log/`.

## Security model

- No accounts and no secrets in the client. The Apps Script URL is a capability: anyone who obtains it can read or append rows.
- The API is append-only; there is no delete endpoint. Clean bad rows directly in the Sheet.
- The Sheet is the durable store. Clearing browser data only removes the local cache and any pending unsynced records.
- Device clock and timezone determine recorded times.
````

- [ ] **Step 4: Capture the screenshot from the running app**

With `PORT=8787 node test/dev-server.mjs` running and a couple of records visible (add them through the UI), take a screenshot at 390x844 with `fullPage: true` and save it to `docs/screenshot.png` using the browser tool's `filePath` option with the absolute path `/Users/happy/Documents/project/tmp/ev-charge-log/docs/screenshot.png`.

Verify: `file docs/screenshot.png` reports PNG image data; the file is referenced by the README.

- [ ] **Step 5: Verify docs and tests**

Run: `node --check apps-script/Code.gs && npm test`

Expected: no syntax errors; 17 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps-script/Code.gs README.md docs/screenshot.png
git commit -m "docs: add Apps Script backend, README, and screenshot"
```

---

### Task 6: Deploy and live end-to-end verification (requires user)

**Files:**
- Modify: `config.js` (set `API_URL` and `SHEET_URL`)

**Interfaces:**
- Consumes: everything above; the user's deployed Apps Script Web app URL and Sheet URL.
- Produces: a live GitHub Pages URL with verified read/write/export behavior.

**Execution checkpoints (do not skip):**

- The user must create the Sheet and deploy `apps-script/Code.gs` themselves and provide the Web app URL and Sheet URL.
- Creating a public repo, pushing, and enabling Pages are externally visible actions: ask for explicit authorization before running them.
- Never ask for or handle a GitHub token, Google password, or any secret. The URLs are public by design.

- [ ] **Step 1: Ask the user for the two URLs and deployment authorization**

Collect: Apps Script Web app URL, Google Sheet URL, GitHub username, and explicit approval to create a public repo and enable Pages.

- [ ] **Step 2: Configure**

Edit `config.js`:

```js
window.APP_CONFIG = {
  API_URL: '<web app URL from the user>',
  SHEET_URL: '<sheet URL from the user>',
};
```

- [ ] **Step 3: Commit and verify the tree before pushing**

```bash
git add config.js
git commit -m "chore: configure Google Sheet endpoint"
git status
git log --oneline -5
```

Expected: clean tree; no secrets in the repo.

- [ ] **Step 4: Create the public repo and push**

First verify the CLI is authenticated as the intended account:

```bash
gh auth status
OWNER=$(gh api user -q .login)
gh repo create "$OWNER/ev-charge-log" --public --source=. --remote=origin --push
```

If the repo already exists, stop and ask the user how to proceed.

- [ ] **Step 5: Enable GitHub Pages**

```bash
OWNER=$(gh api user -q .login)
gh api --method POST "repos/$OWNER/ev-charge-log/pages" \
  -f "source[branch]=main" -f "source[path]=/"
```

If `gh api` rejects the bracket fields, use the JSON form instead:

```bash
OWNER=$(gh api user -q .login)
printf '{"source":{"branch":"main","path":"/"}}' \
  | gh api --method POST "repos/$OWNER/ev-charge-log/pages" --input -
```

If Pages is already enabled, skip the POST and confirm the source is `main` / `/`.

- [ ] **Step 6: Wait for the Pages build**

Poll:

```bash
OWNER=$(gh api user -q .login)
gh api "repos/$OWNER/ev-charge-log/pages/builds/latest" --jq '.status'
```

Repeat until `built` (or inspect `.error.message` if `errored`). GitHub Pages can take a few minutes and responses may be cached.

- [ ] **Step 7: Live end-to-end test**

Open `https://<owner>.github.io/ev-charge-log/` (owner from Step 4) at 390x844:

1. Verify the chip is `已連接` and the Sheet link opens the user's Sheet.
2. Click "開始充電"; verify the row appears and the chip stays `已連接`.
3. Verify the Apps Script GET returns the record: evaluate `async () => (await (await fetch(window.APP_CONFIG.API_URL)).json())`; expected one record.
4. Ask the user to confirm the row exists in the Google Sheet with the correct local date/time.
5. Reload; verify the record persists.
6. Open the URL in a private window (fresh storage); verify the same record appears from the Sheet.
7. Export the current month; verify the CSV content (BOM, CRLF, `日期,時間`, one row) by capturing the blob text with an evaluate patch.
8. Verify double-POST idempotency: the app never sends the same id twice, and a manual duplicate POST returns `{ ok: true, duplicate: true }` without adding a row.

If any step fails, capture the browser console and the Apps Script execution log, fix, and redeploy before reporting completion. If Apps Script blocks CORS, stop and report: the spec's fallback is JSONP GET plus a hidden-form POST, which needs a new plan task.

- [ ] **Step 8: Final commit (only if fixes were needed)**

```bash
git add -A
git status
git commit -m "fix: address live deployment issue"
```

---

## Plan self-review

- Spec coverage: architecture, Sheet layout (no `receivedAt`), API GET/POST, idempotency, two-button UI, quick view, month CSV, offline queue, corrupt storage, mobile-first, setup, security, live E2E are all mapped to tasks.
- Type consistency: `Record { id, startAt }` is used consistently; API body fields are `id`, `startAt`, `date`, `time`; localStorage keys are `ev-charge-log.cache.v1` and `ev-charge-log.pending.v1`.
- CORS fallback is intentionally a live-verification contingency documented in Task 6 rather than speculative code.
