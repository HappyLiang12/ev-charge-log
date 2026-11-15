# EV Charge Log — Tesla Billing Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-car URL attribution, on-demand Tesla Wall Connector sync, CLP peak/off-peak cost estimates, and an owner view to the existing EV Charge Log app.

**Architecture:** Static ES modules on GitHub Pages; a Google Apps Script Web App owns the Sheet, Tesla OAuth, CLP rate fetch, matching, and the API. Each car gets `?car=<id>`; the owner gets `?owner=<key>`. The browser never sees Tesla credentials or the owner key.

**Tech Stack:** Vanilla HTML/CSS/ES modules, Node 24 built-in test runner, Google Apps Script V8, Google Sheets, GitHub Pages. No npm dependencies, no build step, no cron.

**Spec:** `docs/superpowers/specs/2026-11-14-ev-charge-log-tesla-billing-design.md`

## Global Constraints

- Work on a feature branch or worktree. Do not implement on `main` without explicit user consent.
- Preserve the current working tree: `.gitignore`, `package.json`, `test/tesla-probe.test.mjs`, and `tools/` are part of Task 1.
- Never stage or commit `tools/.env.tesla.local` or `tools/.tesla-refresh-token.local`.
- No secrets in `config.js`, the Sheet, browser storage, CSV, logs, or git.
- Every task ends with `npm test` and a commit. Use a feature branch; do not push or deploy without explicit user authorization.
- All billing dates and months use `Asia/Hong_Kong`; Hong Kong has no DST.
- UI copy is Traditional Chinese (zh-HK), 24-hour time. Code, comments, docs, and commit messages are English.
- Preserve all existing Sheet rows. New `Log` columns are appended to the right; reads use a header map.
- No new npm dependencies. Node 24 or newer. Apps Script V8 runtime.
- Tesla API is read-only for energy data. The client secret and refresh token live only in Apps Script Script Properties.
- The family URL is `?car=<id>`; the owner URL is `?owner=<key>`. The owner key is 48 lowercase hex characters.
- Verification commands are run from `/Users/happy/Documents/project/tmp/ev-charge-log`.

## Execution preflight

- [ ] **Step 1: Confirm the tree and branch**

Run:

```bash
git status --short
git branch --show-current
```

Expected: modified `.gitignore`, modified `package.json`, untracked `test/tesla-probe.test.mjs`, untracked `tools/`. The branch must not be `main`; if it is, create `feat/tesla-billing` with `git switch -c feat/tesla-billing`. Do not discard the untracked files.

- [ ] **Step 2: Confirm the baseline**

Run:

```bash
npm test
```

Expected before Task 1: the existing probe tests pass (25 tests at the time of writing). The legacy app tests may be replaced in Task 2; that is allowed.

---

### Task 1: Tesla probe tooling and refresh-token setup

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `tools/tesla-probe.mjs`
- Modify: `test/tesla-probe.test.mjs`

**Interfaces:**
- Consumes: the existing read-only probe, env file, and OAuth flow.
- Produces: `writeRefreshTokenFile(path, token)` and `npm run auth:tesla`; a local refresh-token file with mode `0600`; `node --test` as the test command.

- [ ] **Step 1: Add the failing test**

In `test/tesla-probe.test.mjs`, extend the imports:

```js
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectChargeSessions,
  findEnergySites,
  redactSensitive,
  summarizeSessionIdentifiers,
  writeRefreshTokenFile,
} from '../tools/tesla-probe.mjs';
```

Append:

```js
test('writeRefreshTokenFile writes a 0600 file with a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tesla-refresh-'));
  const file = join(dir, '.tesla-refresh-token.local');
  try {
    writeRefreshTokenFile(file, 'refresh-token-value');
    assert.equal(readFileSync(file, 'utf8'), 'refresh-token-value\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL because `writeRefreshTokenFile` is not exported.

- [ ] **Step 3: Implement the helper and CLI mode**

In `tools/tesla-probe.mjs`:

Change the `node:fs` import to:

```js
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
```

Add near the path constants:

```js
const REFRESH_TOKEN_FILE = join(HERE, '.tesla-refresh-token.local');
const SAVE_REFRESH = process.argv.includes('--save-refresh-token');
```

Add after `loadEnvFile`:

```js
export function writeRefreshTokenFile(path, token) {
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
```

In `printUsage`, add:

```text
--save-refresh-token  Save a new Tesla refresh token locally (mode 600).
```

In `main`, before the `--register` branch:

```js
if (SAVE_REFRESH && process.argv.includes('--register')) {
  throw new Error('Use either --register or --save-refresh-token, not both.');
}
```

After `const token = await exchangeCode(code);`, add:

```js
if (SAVE_REFRESH) {
  if (!token.refresh_token) {
    throw new Error('Tesla did not return a refresh token. Revoke the app grant in the Tesla account and retry.');
  }
  writeRefreshTokenFile(REFRESH_TOKEN_FILE, token.refresh_token);
  console.log(`Refresh token saved to ${REFRESH_TOKEN_FILE} (mode 600).`);
  console.log('Do not commit this file. Copy the value into Apps Script Script Properties as TESLA_REFRESH_TOKEN.');
  return;
}
```

Add to `.gitignore`:

```text
tools/.tesla-refresh-token.local
```

Replace the `package.json` scripts with:

```json
"scripts": {
  "test": "node --test",
  "probe:tesla": "node tools/tesla-probe.mjs",
  "register:tesla": "node tools/tesla-probe.mjs --register",
  "auth:tesla": "node tools/tesla-probe.mjs --save-refresh-token"
}
```

- [ ] **Step 4: Verify the local token file is ignored and tests pass**

Run:

```bash
node --check tools/tesla-probe.mjs
npm test
git check-ignore -v tools/.env.tesla.local tools/.tesla-refresh-token.local
```

Expected: syntax check exit 0; 26 tests pass; both files are ignored. Do not print the env file contents.

- [ ] **Step 5: Commit**

```bash
git add .gitignore package.json tools/tesla-probe.mjs test/tesla-probe.test.mjs
git status --short
git commit -m "feat: add Tesla probe and refresh-token setup"
```

Expected: the commit contains no `.env.tesla.local` and no token file.

---

### Task 2: Frontend logic core

**Files:**
- Create: `logic.js`
- Replace: `test/logic.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HK_OFFSET_MS`, `RATES_KEY`, `storageKeys(car)`
  - `formatHkDate(iso)`, `formatHkTime(iso)`, `formatHkWeekday(iso)`, `monthKey(iso)`
  - `isValidRecord(value)`, `normalizeRecord(value)`, `normalizeRecords(list)`
  - `normalizeRate(value)`, `normalizeRates(list)`, `normalizeCar(value)`, `normalizeCars(list)`
  - `parseServerRecords(payload)`, `parseFamilyPayload(payload)`, `parseOwnerPayload(payload)`
  - `mergeRecords(server, pending)`, `monthsWithRecords(records)`, `defaultMonth(records, now)`, `filterByMonth(records, month)`
  - `selectRate(month, rates)`, `computeCost(record, rate)`, `summarizeRecords(records, rates, month)`
  - `csvEscape(value)`, `toCsv(records, options)`
  - `isRecentDuplicate(...)`, `dropSyncedPending(...)`, `readStored(...)`, `writeStored(...)`

- [ ] **Step 1: Write the failing tests**

Replace `test/logic.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RATES_KEY,
  storageKeys,
  formatHkDate,
  formatHkTime,
  formatHkWeekday,
  monthKey,
  isValidRecord,
  normalizeRecord,
  normalizeRecords,
  normalizeRates,
  normalizeCars,
  parseServerRecords,
  parseFamilyPayload,
  parseOwnerPayload,
  mergeRecords,
  monthsWithRecords,
  defaultMonth,
  filterByMonth,
  selectRate,
  computeCost,
  summarizeRecords,
  csvEscape,
  toCsv,
  isRecentDuplicate,
  dropSyncedPending,
  readStored,
  writeStored,
} from '../logic.js';

const iso = (value) => new Date(value).toISOString();
const base = '2026-11-14T05:00:00.000Z'; // 13:00 in Hong Kong
const rate = {
  month: '2026-11',
  basicOffPeak: 94.5,
  basicPeak: 137.5,
  fuelAdjustment: 47.4,
  rebate: 0,
  peakStart: '16:00',
  peakEnd: '23:00',
  sourceUrl: 'https://www.clp.com.hk/',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  manualOverride: false,
};
const record = (overrides = {}) => ({
  id: 'rec-1',
  car: 'model3',
  startAt: base,
  date: '2026-11-14',
  time: '13:00',
  kWh: 20,
  durationSec: 7200,
  teslaStartAt: base,
  teslaEndAt: '2026-11-14T07:00:00.000Z',
  peakKWh: 10,
  offPeakKWh: 10,
  teslaKey: 'din:1786968749',
  source: 'tesla+manual',
  ...overrides,
});

test('Hong Kong formatting and month keys ignore the device timezone', () => {
  assert.equal(formatHkDate('2026-11-14T13:05:00.000Z'), '2026-11-14');
  assert.equal(formatHkTime('2026-11-14T13:05:00.000Z'), '21:05');
  assert.equal(formatHkWeekday('2026-11-14T13:05:00.000Z'), '週六');
  assert.equal(formatHkDate('2026-11-14T16:30:00.000Z'), '2026-11-15');
  assert.equal(formatHkTime('2026-11-14T16:30:00.000Z'), '00:30');
  assert.equal(formatHkWeekday('2026-11-14T16:30:00.000Z'), '週日');
  assert.equal(monthKey('2026-11-14T16:30:00.000Z'), '2026-11');
});

test('storageKeys are per car and the rates key is shared', () => {
  assert.deepEqual(storageKeys('model3'), {
    cache: 'ev-charge-log.cache.v2.model3',
    pending: 'ev-charge-log.pending.v2.model3',
  });
  assert.equal(RATES_KEY, 'ev-charge-log.rates.v1');
});

test('normalizeRecord preserves the full billing record and marks old rows legacy', () => {
  const normalized = normalizeRecord(record());
  assert.deepEqual(normalized, record());

  const old = normalizeRecord({ id: 'old-1', startAt: base });
  assert.equal(old.car, '');
  assert.equal(old.source, 'legacy');
  assert.equal(old.date, '2026-11-14');
  assert.equal(old.time, '13:00');
  assert.equal(old.kWh, null);
  assert.equal(old.teslaKey, null);

  assert.equal(normalizeRecord({ ...record(), car: 'Bad Car' }), null);
  assert.equal(normalizeRecord({ id: 'bad id', startAt: base }), null);
  assert.equal(normalizeRecord({ id: 'x', startAt: 'nope' }), null);
});

test('normalizeRecords drops malformed entries', () => {
  assert.deepEqual(normalizeRecords([record(), { id: 'bad id', startAt: base }, null]), [record()]);
});

test('normalizeRates and normalizeCars validate server rows', () => {
  assert.deepEqual(normalizeRates([{ ...rate, manualOverride: 'TRUE' }]), [{ ...rate, manualOverride: true }]);
  assert.deepEqual(normalizeRates([{ ...rate, basicPeak: null }]), []);
  assert.deepEqual(normalizeCars([{ id: 'model3', name: 'Model 3', active: 'FALSE' }]), [
    { id: 'model3', name: 'Model 3', active: false },
  ]);
});

test('parse payloads validate the family and owner envelopes', () => {
  const family = parseFamilyPayload({
    ok: true,
    car: { id: 'model3', name: 'Model 3', active: true },
    records: [record()],
    rates: [rate],
  });
  assert.equal(family.car.name, 'Model 3');
  assert.deepEqual(family.records, [record()]);
  assert.deepEqual(family.rates, [rate]);

  const owner = parseOwnerPayload({
    ok: true,
    cars: [{ id: 'model3', name: 'Model 3', active: true }],
    records: [record()],
    rates: [rate],
  });
  assert.equal(owner.cars.length, 1);
  assert.deepEqual(owner.records, [record()]);
  assert.throws(() => parseServerRecords({ ok: false }), /Invalid API response/);
  assert.throws(() => parseFamilyPayload({ ok: true, car: null, records: [] }), /Invalid car payload/);
});

test('merge, month filtering, and default month use startAt', () => {
  const older = record({ id: 'a', startAt: '2026-10-31T16:00:00.000Z' }); // 2026-11-01 00:00 HK
  const newer = record({ id: 'b', startAt: '2026-11-02T00:00:00.000Z' });
  const merged = mergeRecords([older], [newer, older]);
  assert.deepEqual(merged.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(monthsWithRecords([older, newer]), ['2026-11']);
  assert.equal(filterByMonth([older, newer], '2026-11').length, 2);
  assert.equal(filterByMonth([older, newer], 'all').length, 2);
  assert.equal(defaultMonth([older, newer], new Date('2026-11-14T00:00:00.000Z')), '2026-11');
  assert.equal(defaultMonth([older], new Date('2026-12-14T00:00:00.000Z')), '2026-11');
  assert.equal(defaultMonth([], new Date('2026-12-14T00:00:00.000Z')), 'all');
});

test('selectRate prefers the exact month then the latest earlier month', () => {
  const october = { ...rate, month: '2026-10', fuelAdjustment: 46.2 };
  assert.deepEqual(selectRate('2026-11', [october, rate]), { rate, fallback: false });
  assert.deepEqual(selectRate('2026-12', [october, rate]), { rate, fallback: true });
  assert.deepEqual(selectRate('2026-09', [october, rate]), { rate: null, fallback: false });
});

test('computeCost applies peak, off-peak, and rebate', () => {
  assert.equal(computeCost(record(), rate), 32.68);
  assert.equal(computeCost(record(), { ...rate, rebate: 5 }), 31.68);
  assert.equal(computeCost(record({ peakKWh: null }), rate), null);
});

test('summarizeRecords totals kWh, split, cost, and missing-rate state', () => {
  assert.deepEqual(summarizeRecords([record()], [rate], '2026-11'), {
    count: 1,
    matched: 1,
    pending: 0,
    kWh: 20,
    peakKWh: 10,
    offPeakKWh: 10,
    cost: 32.68,
    missingRate: 0,
    fallback: false,
  });
  assert.deepEqual(summarizeRecords([record({ kWh: null })], [rate], '2026-11'), {
    count: 1,
    matched: 0,
    pending: 1,
    kWh: 0,
    peakKWh: 0,
    offPeakKWh: 0,
    cost: null,
    missingRate: 0,
    fallback: false,
  });
  assert.equal(summarizeRecords([record()], [], '2026-11').cost, null);
  assert.equal(summarizeRecords([record()], [], '2026-11').missingRate, 1);
});

test('toCsv emits the billing header, Hong Kong time, split, cost, and source', () => {
  const csv = toCsv([record()], { carNames: { model3: 'Model 3' }, rates: [rate] });
  assert.equal(
    csv,
    '\uFEFF日期,時間,車,kWh,非高峰 kWh,高峰 kWh,估算電費 (HKD),來源\r\n'
    + '2026-11-14,13:00,Model 3,20.00,10.00,10.00,32.68,tesla+manual\r\n',
  );
});

test('csvEscape quotes commas, quotes, and newlines', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('a\nb'), '"a\nb"');
});

test('isRecentDuplicate and dropSyncedPending keep their existing behavior', () => {
  const at = Date.parse(base);
  assert.equal(isRecentDuplicate(base, at + 1500), true);
  assert.equal(isRecentDuplicate(base, at + 2000), false);
  assert.equal(isRecentDuplicate(null, at), false);
  const a = record({ id: 'a' });
  const b = record({ id: 'b' });
  assert.deepEqual(dropSyncedPending([a, b], [a]).map((r) => r.id), ['b']);
});

test('readStored and writeStored handle storage failures and corruption', () => {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  assert.deepEqual(readStored(storage, 'missing'), { value: null, corrupt: false });
  storage.setItem('bad', '{oops');
  assert.deepEqual(readStored(storage, 'bad'), { value: null, corrupt: true });
  assert.equal(writeStored(storage, 'good', [1, 2]), true);
  assert.deepEqual(readStored(storage, 'good'), { value: [1, 2], corrupt: false });
  assert.equal(writeStored({ setItem() { throw new Error('quota'); } }, 'x', 1), false);
  assert.equal(writeStored(null, 'x', 1), false);
});

test('isValidRecord accepts the new record shape and old records', () => {
  assert.equal(isValidRecord(record()), true);
  assert.equal(isValidRecord({ id: 'old', startAt: base }), true);
  assert.equal(isValidRecord({ id: 'bad id', startAt: base }), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `logic.js` does not exist.

- [ ] **Step 3: Implement `logic.js`**

Create `logic.js`:

```js
export const HK_OFFSET_MS = 8 * 60 * 60 * 1000;
export const RATES_KEY = 'ev-charge-log.rates.v1';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const CAR_RE = /^[a-z0-9-]{1,32}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const SOURCES = new Set(['manual', 'tesla', 'tesla+manual', 'legacy']);

const pad2 = (n) => String(n).padStart(2, '0');
const text = (value) => (typeof value === 'string' ? value : '');
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const numberOrZero = (value) => numberOrNull(value) ?? 0;

function hkDate(iso) {
  return new Date(Date.parse(iso) + HK_OFFSET_MS);
}

export function formatHkDate(iso) {
  const d = hkDate(iso);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatHkTime(iso) {
  const d = hkDate(iso);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatHkWeekday(iso) {
  return WEEKDAYS[hkDate(iso).getUTCDay()];
}

export function monthKey(iso) {
  return formatHkDate(iso).slice(0, 7);
}

export function storageKeys(car) {
  const suffix = car || 'owner';
  return {
    cache: `ev-charge-log.cache.v2.${suffix}`,
    pending: `ev-charge-log.pending.v2.${suffix}`,
  };
}

export function isValidRecord(value) {
  return Boolean(value)
    && typeof value.id === 'string'
    && ID_RE.test(value.id)
    && typeof value.startAt === 'string'
    && !Number.isNaN(Date.parse(value.startAt));
}

function nullableDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function normalizeRecord(value) {
  if (!isValidRecord(value)) return null;
  const car = typeof value.car === 'string' ? value.car : '';
  if (car && car !== 'unassigned' && !CAR_RE.test(car)) return null;
  const source = SOURCES.has(value.source)
    ? value.source
    : (car ? 'manual' : 'legacy');
  return {
    id: value.id,
    car,
    startAt: value.startAt,
    date: DATE_RE.test(text(value.date)) ? value.date : formatHkDate(value.startAt),
    time: TIME_RE.test(text(value.time)) ? value.time : formatHkTime(value.startAt),
    kWh: numberOrNull(value.kWh),
    durationSec: numberOrNull(value.durationSec),
    teslaStartAt: nullableDate(value.teslaStartAt),
    teslaEndAt: nullableDate(value.teslaEndAt),
    peakKWh: numberOrNull(value.peakKWh),
    offPeakKWh: numberOrNull(value.offPeakKWh),
    teslaKey: typeof value.teslaKey === 'string' && value.teslaKey ? value.teslaKey : null,
    source,
  };
}

export function normalizeRecords(list) {
  return Array.isArray(list) ? list.map(normalizeRecord).filter(Boolean) : [];
}

export function normalizeRate(value) {
  if (!value || !MONTH_RE.test(text(value.month))) return null;
  const peakStart = text(value.peakStart) || '16:00';
  const peakEnd = text(value.peakEnd) || '23:00';
  if (!TIME_RE.test(peakStart) || !TIME_RE.test(peakEnd)) return null;
  const basicOffPeak = numberOrNull(value.basicOffPeak);
  const basicPeak = numberOrNull(value.basicPeak);
  const fuelAdjustment = numberOrNull(value.fuelAdjustment);
  if (basicOffPeak === null || basicPeak === null || fuelAdjustment === null) return null;
  return {
    month: value.month,
    basicOffPeak,
    basicPeak,
    fuelAdjustment,
    rebate: numberOrZero(value.rebate),
    peakStart,
    peakEnd,
    sourceUrl: text(value.sourceUrl),
    fetchedAt: text(value.fetchedAt),
    manualOverride: value.manualOverride === true
      || String(value.manualOverride).toUpperCase() === 'TRUE',
  };
}

export function normalizeRates(list) {
  return Array.isArray(list) ? list.map(normalizeRate).filter(Boolean) : [];
}

export function normalizeCar(value) {
  if (!value || !CAR_RE.test(text(value.id)) || !text(value.name).trim()) return null;
  return {
    id: value.id,
    name: text(value.name).trim(),
    active: value.active !== false && String(value.active).toUpperCase() !== 'FALSE',
  };
}

export function normalizeCars(list) {
  return Array.isArray(list) ? list.map(normalizeCar).filter(Boolean) : [];
}

export function parseServerRecords(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  return normalizeRecords(payload.records);
}

export function parseFamilyPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  const car = normalizeCar(payload.car);
  if (!car) throw new Error('Invalid car payload');
  return {
    car,
    records: normalizeRecords(payload.records),
    rates: normalizeRates(payload.rates),
  };
}

export function parseOwnerPayload(payload) {
  if (!payload || payload.ok !== true || !Array.isArray(payload.records)) {
    throw new Error('Invalid API response');
  }
  return {
    cars: normalizeCars(payload.cars),
    records: normalizeRecords(payload.records),
    rates: normalizeRates(payload.rates),
  };
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
  return [...new Set(normalizeRecords(records).map((record) => monthKey(record.startAt)))]
    .sort()
    .reverse();
}

export function defaultMonth(records, now = new Date()) {
  const months = monthsWithRecords(records);
  const current = monthKey(now.toISOString());
  if (months.includes(current)) return current;
  return months[0] || 'all';
}

export function filterByMonth(records, month) {
  const normalized = normalizeRecords(records);
  if (month === 'all') return normalized;
  return normalized.filter((record) => monthKey(record.startAt) === month);
}

export function csvEscape(value) {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function selectRate(month, rates) {
  const rows = normalizeRates(rates).slice().sort((a, b) => a.month.localeCompare(b.month));
  const exact = rows.find((row) => row.month === month);
  if (exact) return { rate: exact, fallback: false };
  const earlier = rows.filter((row) => row.month < month).at(-1);
  return earlier ? { rate: earlier, fallback: true } : { rate: null, fallback: false };
}

export function computeCost(record, rate) {
  if (!record || !rate || record.peakKWh === null || record.offPeakKWh === null) return null;
  const rebate = Number(rate.rebate) || 0;
  const offPeakRate = Number(rate.basicOffPeak) + Number(rate.fuelAdjustment) - rebate;
  const peakRate = Number(rate.basicPeak) + Number(rate.fuelAdjustment) - rebate;
  if (![offPeakRate, peakRate].every(Number.isFinite)) return null;
  return (record.offPeakKWh * offPeakRate + record.peakKWh * peakRate) / 100;
}

export function summarizeRecords(records, rates, month = 'all') {
  const filtered = filterByMonth(records, month);
  let kWh = 0;
  let peakKWh = 0;
  let offPeakKWh = 0;
  let cost = 0;
  let matched = 0;
  let pending = 0;
  let missingRate = 0;
  let fallback = false;

  for (const record of filtered) {
    if (record.kWh === null) {
      pending += 1;
      continue;
    }
    matched += 1;
    kWh += record.kWh;
    peakKWh += record.peakKWh || 0;
    offPeakKWh += record.offPeakKWh || 0;
    const picked = selectRate(monthKey(record.teslaStartAt || record.startAt), rates);
    if (!picked.rate) {
      missingRate += 1;
      continue;
    }
    fallback = fallback || picked.fallback;
    const value = computeCost(record, picked.rate);
    if (value === null) {
      missingRate += 1;
      continue;
    }
    cost += value;
  }

  return {
    count: filtered.length,
    matched,
    pending,
    kWh,
    peakKWh,
    offPeakKWh,
    cost: matched > 0 && missingRate === 0 ? cost : null,
    missingRate,
    fallback,
  };
}

export function toCsv(records, { carNames = {}, rates = [] } = {}) {
  const rows = normalizeRecords(records)
    .slice()
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const lines = ['日期,時間,車,kWh,非高峰 kWh,高峰 kWh,估算電費 (HKD),來源'];
  for (const record of rows) {
    const picked = selectRate(monthKey(record.teslaStartAt || record.startAt), rates);
    const cost = picked.rate ? computeCost(record, picked.rate) : null;
    const cells = [
      formatHkDate(record.startAt),
      formatHkTime(record.startAt),
      carNames[record.car] || record.car || '',
      record.kWh === null ? '' : record.kWh.toFixed(2),
      record.offPeakKWh === null ? '' : record.offPeakKWh.toFixed(2),
      record.peakKWh === null ? '' : record.peakKWh.toFixed(2),
      cost === null ? '' : cost.toFixed(2),
      record.source,
    ];
    lines.push(cells.map(csvEscape).join(','));
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: the new logic tests and the probe tests pass (number may vary; all green).

- [ ] **Step 5: Commit**

```bash
git add logic.js test/logic.test.mjs
git commit -m "feat: add billing logic core"
```

---

### Task 3: API client and shared UI helpers

**Files:**
- Create: `api.js`
- Create: `ui.js`
- Create: `test/api.test.mjs`

**Interfaces:**
- Consumes: `parseFamilyPayload`, `parseOwnerPayload`, `formatHkDate`, `formatHkTime` from Task 2.
- Produces:
  - `apiGet(apiUrl, params, fetchImpl)`, `apiPost(apiUrl, body, fetchImpl)`
  - `fetchFamilyData(apiUrl, car, fetchImpl)`, `fetchOwnerData(apiUrl, ownerKey, fetchImpl)`
  - `postRecord(apiUrl, record, car, fetchImpl)`
  - `deleteRecord(apiUrl, id, auth, fetchImpl)`
  - `syncTesla(apiUrl, auth, fetchImpl)`
  - `assignSession(apiUrl, ownerKey, id, car, fetchImpl)`
  - `ignoreSession(apiUrl, ownerKey, id, fetchImpl)`
  - `refreshRates(apiUrl, ownerKey, fetchImpl)`
  - `byId(id)`, `showToast(element, message)`, `setStatus(element, status)`, `setBusy(button, busy, busyLabel, idleLabel)`

- [ ] **Step 1: Write the failing API tests**

Create `test/api.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  apiGet,
  apiPost,
  fetchFamilyData,
  fetchOwnerData,
  postRecord,
  deleteRecord,
  syncTesla,
  assignSession,
  ignoreSession,
  refreshRates,
} from '../api.js';

const base = 'https://example.test/api';
const rate = {
  month: '2026-11',
  basicOffPeak: 94.5,
  basicPeak: 137.5,
  fuelAdjustment: 47.4,
  rebate: 0,
  peakStart: '16:00',
  peakEnd: '23:00',
  sourceUrl: 'https://www.clp.com.hk/',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  manualOverride: false,
};
const record = {
  id: 'rec-1',
  car: 'model3',
  startAt: '2026-11-14T05:00:00.000Z',
  date: '2026-11-14',
  time: '13:00',
  kWh: 20,
  durationSec: 7200,
  teslaStartAt: '2026-11-14T05:00:00.000Z',
  teslaEndAt: '2026-11-14T07:00:00.000Z',
  peakKWh: 10,
  offPeakKWh: 10,
  teslaKey: 'din:1786968749',
  source: 'tesla+manual',
};
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
});
const captureFetch = (body, captured) => async (url, init) => {
  captured.url = url;
  captured.init = init;
  return response(body);
};

test('fetchFamilyData sends the car query and parses the payload', async () => {
  const captured = {};
  const data = await fetchFamilyData(base, 'model3', captureFetch({
    ok: true,
    car: { id: 'model3', name: 'Model 3', active: true },
    records: [record],
    rates: [rate],
  }, captured));
  assert.match(captured.url, /^https:\/\/example\.test\/api\?car=model3$/);
  assert.equal(captured.init.method, 'GET');
  assert.equal(data.car.name, 'Model 3');
  assert.equal(data.records[0].id, 'rec-1');
  assert.equal(data.rates[0].month, '2026-11');
});

test('fetchOwnerData sends the owner query and parses all cars', async () => {
  const captured = {};
  const data = await fetchOwnerData(base, 'secret-key', captureFetch({
    ok: true,
    cars: [{ id: 'model3', name: 'Model 3', active: true }],
    records: [record],
    rates: [rate],
  }, captured));
  assert.match(captured.url, /^https:\/\/example\.test\/api\?owner=secret-key$/);
  assert.equal(data.cars.length, 1);
  assert.equal(data.records[0].car, 'model3');
});

test('postRecord sends car, startAt, and Hong Kong date/time as text/plain', async () => {
  const captured = {};
  await postRecord(base, record, 'model3', captureFetch({ ok: true }, captured));
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepEqual(JSON.parse(captured.init.body), {
    id: 'rec-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
  });
});

test('deleteRecord supports family and owner authorization', async () => {
  const family = {};
  await deleteRecord(base, 'rec-1', { car: 'model3' }, captureFetch({ ok: true }, family));
  assert.deepEqual(JSON.parse(family.init.body), { action: 'delete', id: 'rec-1', car: 'model3' });
  const owner = {};
  await deleteRecord(base, 'rec-1', { ownerKey: 'secret' }, captureFetch({ ok: true }, owner));
  assert.deepEqual(JSON.parse(owner.init.body), { action: 'delete', id: 'rec-1', ownerKey: 'secret' });
});

test('syncTesla, assignSession, ignoreSession, and refreshRates send their actions', async () => {
  const sync = {};
  await syncTesla(base, { car: 'model3' }, captureFetch({ ok: true }, sync));
  assert.deepEqual(JSON.parse(sync.init.body), { action: 'sync', car: 'model3' });

  const assign = {};
  await assignSession(base, 'secret', 'rec-1', 'leaf', captureFetch({ ok: true }, assign));
  assert.deepEqual(JSON.parse(assign.init.body), { action: 'assign', ownerKey: 'secret', id: 'rec-1', car: 'leaf' });

  const ignore = {};
  await ignoreSession(base, 'secret', 'rec-1', captureFetch({ ok: true }, ignore));
  assert.deepEqual(JSON.parse(ignore.init.body), { action: 'ignore', ownerKey: 'secret', id: 'rec-1' });

  const rates = {};
  await refreshRates(base, 'secret', captureFetch({ ok: true }, rates));
  assert.deepEqual(JSON.parse(rates.init.body), { action: 'refreshRates', ownerKey: 'secret' });
});

test('apiGet and apiPost reject HTTP and API-level errors', async () => {
  await assert.rejects(
    apiGet(base, { car: 'model3' }, async () => response(null, { ok: false, status: 500 })),
    /HTTP 500/,
  );
  await assert.rejects(
    apiGet(base, { car: 'model3' }, async () => response({ ok: false, error: 'nope' })),
    /nope/,
  );
  await assert.rejects(
    apiPost(base, { action: 'x' }, async () => response({ ok: false, error: 'bad' })),
    /bad/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`

Expected: FAIL because `api.js` does not exist.

- [ ] **Step 3: Implement `api.js`**

Create `api.js`:

```js
import {
  formatHkDate,
  formatHkTime,
  parseFamilyPayload,
  parseOwnerPayload,
} from './logic.js';

function withParams(apiUrl, params) {
  const url = new URL(apiUrl);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function jsonResponse(response) {
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
  return payload;
}

export async function apiGet(apiUrl, params, fetchImpl = fetch) {
  const response = await fetchImpl(withParams(apiUrl, params), {
    method: 'GET',
    redirect: 'follow',
  });
  return jsonResponse(response);
}

export async function apiPost(apiUrl, body, fetchImpl = fetch) {
  const response = await fetchImpl(apiUrl, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  return jsonResponse(response);
}

export async function fetchFamilyData(apiUrl, car, fetchImpl = fetch) {
  return parseFamilyPayload(await apiGet(apiUrl, { car }, fetchImpl));
}

export async function fetchOwnerData(apiUrl, ownerKey, fetchImpl = fetch) {
  return parseOwnerPayload(await apiGet(apiUrl, { owner: ownerKey }, fetchImpl));
}

export async function postRecord(apiUrl, record, car, fetchImpl = fetch) {
  return apiPost(apiUrl, {
    id: record.id,
    car,
    startAt: record.startAt,
    date: formatHkDate(record.startAt),
    time: formatHkTime(record.startAt),
  }, fetchImpl);
}

export async function deleteRecord(apiUrl, id, auth, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'delete', id, ...auth }, fetchImpl);
}

export async function syncTesla(apiUrl, auth, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'sync', ...auth }, fetchImpl);
}

export async function assignSession(apiUrl, ownerKey, id, car, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'assign', ownerKey, id, car }, fetchImpl);
}

export async function ignoreSession(apiUrl, ownerKey, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'ignore', ownerKey, id }, fetchImpl);
}

export async function refreshRates(apiUrl, ownerKey, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'refreshRates', ownerKey }, fetchImpl);
}
```

- [ ] **Step 4: Implement `ui.js`**

Create `ui.js`:

```js
const toastTimers = new WeakMap();

export function byId(id) {
  return document.getElementById(id);
}

export function showToast(element, message) {
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimers.get(element));
  toastTimers.set(element, setTimeout(() => element.classList.remove('show'), 2500));
}

export function setStatus(element, status) {
  if (!element) return;
  element.textContent = status;
  element.dataset.state = status === '已連接'
    ? 'ok'
    : status === '未設定'
      ? 'idle'
      : status === '連線中'
        ? 'loading'
        : 'warn';
}

export function setBusy(button, busy, busyLabel, idleLabel) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('loading', busy);
  button.textContent = busy ? busyLabel : idleLabel;
  button.setAttribute('aria-busy', busy ? 'true' : 'false');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add api.js ui.js test/api.test.mjs
git commit -m "feat: add frontend API client and UI helpers"
```

---

### Task 4: Family view, app shell, and mock server

**Files:**
- Replace: `index.html`
- Modify: `style.css`
- Create: `family.js`
- Replace: `app.js`
- Replace: `test/dev-server.mjs`

**Interfaces:**
- Consumes: `logic.js` (Task 2), `api.js` and `ui.js` (Task 3).
- Produces: `initFamily({ apiUrl, carId })`; the first working `?car=<id>` screen; the mock API used by browser smoke.

- [ ] **Step 1: Replace `index.html` with the family shell**

```html
<!doctype html>
<html lang="zh-HK">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#070b0a" />
  <meta name="referrer" content="no-referrer" />
  <title>EV 充電紀錄</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="setupView" class="app" hidden>
    <header class="topbar">
      <div>
        <h1>EV 充電紀錄</h1>
        <p class="subtitle">家庭充電記錄</p>
      </div>
    </header>
    <main>
      <section class="panel">
        <h2>請使用你的專屬連結</h2>
        <p class="empty">呢個頁面需要 <code>?car=</code> 或 <code>?owner=</code> 連結。請向車主索取。</p>
      </section>
    </main>
  </div>

  <div id="familyView" class="app" hidden>
    <header class="topbar">
      <div>
        <h1>EV 充電紀錄</h1>
        <p class="subtitle"><span id="familyCarName">充電紀錄</span></p>
      </div>
      <span id="familyStatus" class="chip" data-state="idle">未設定</span>
    </header>

    <main>
      <button id="startBtn" class="primary" type="button">⚡ 開始充電</button>

      <div class="actions">
        <button id="syncBtn" class="secondary" type="button">更新 Tesla</button>
      </div>

      <section class="stats" aria-label="本月摘要">
        <div class="stat">
          <div id="familyKwh" class="stat-value">—</div>
          <div class="stat-label">本月 kWh</div>
        </div>
        <div class="stat">
          <div id="familyCost" class="stat-value">—</div>
          <div class="stat-label">估算電費</div>
        </div>
        <div class="stat">
          <div id="familyCount" class="stat-value">—</div>
          <div class="stat-label">本月次數</div>
        </div>
      </section>

      <section class="panel">
        <h2>費率與拆分</h2>
        <p id="familySplit" class="hint">—</p>
        <p id="familyRateNote" class="rate-note">未設定費率。</p>
      </section>

      <section class="panel">
        <h2>最近紀錄</h2>
        <ul id="recentList" class="records"></ul>
        <p id="familyEmpty" class="empty" hidden>未有紀錄。</p>
      </section>

      <section class="panel">
        <h2>匯出</h2>
        <div class="export-row">
          <select id="monthSelect" aria-label="匯出月份"></select>
          <button id="exportBtn" type="button">匯出 CSV</button>
        </div>
        <p id="exportHint" class="hint">匯出所選月份。</p>
      </section>
    </main>

    <div id="familyToast" class="toast" role="status" aria-live="polite"></div>
  </div>

  <script src="config.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Add the family CSS**

In `style.css`, add after the `.primary:disabled:active` block:

```css
.actions { display: grid; gap: 10px; }

.secondary {
  width: 100%;
  min-height: 48px;
  border-radius: 12px;
  border: 1px solid #24322c;
  background: var(--surface-2);
  color: var(--text);
  padding: 0 14px;
  cursor: pointer;
}

.secondary:disabled { opacity: 0.5; cursor: default; }
```

Replace the spinner selector block:

```css
.primary.loading::before,
.secondary.loading::before,
.delete-btn.loading::before,
.chip[data-state="loading"]::before {
  content: "";
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  display: inline-block;
  animation: spin 0.7s linear infinite;
}

.primary.loading::before,
.secondary.loading::before { margin-right: 8px; }
```

Replace the reduced-motion spinner selector:

```css
.primary.loading::before,
.secondary.loading::before,
.delete-btn.loading::before,
.chip[data-state="loading"]::before {
  border-top-color: currentColor;
  opacity: 0.5;
}
```

Add after the existing `.record-weekday` block:

```css
.record-main { display: block; min-width: 0; }
.record-meta {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.record-meta.pending { color: var(--warn); }
```

Add after the existing `.hint` block:

```css
.rate-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.panel code { background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
```

- [ ] **Step 3: Write the family view module**

Create `family.js`:

```js
import {
  RATES_KEY,
  storageKeys,
  formatHkDate,
  formatHkTime,
  formatHkWeekday,
  monthKey,
  normalizeRecords,
  normalizeRates,
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
} from './logic.js';
import {
  fetchFamilyData,
  postRecord,
  deleteRecord,
  syncTesla,
} from './api.js';
import { byId, showToast, setStatus, setBusy } from './ui.js';

export function initFamily({ apiUrl, carId }) {
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
  if (cached.corrupt) storage?.removeItem(keys.cache);
  if (queued.corrupt) storage?.removeItem(keys.pending);
  if (cachedRates.corrupt) storage?.removeItem(RATES_KEY);

  const state = {
    car: { id: carId, name: carId, active: true },
    server: normalizeRecords(cached.value),
    pending: normalizeRecords(queued.value),
    rates: normalizeRates(cachedRates.value),
    syncedOnce: false,
    connecting: Boolean(apiUrl),
    syncing: false,
    deleting: new Set(),
    offline: false,
    selectedMonth: null,
  };

  const els = {
    startBtn: byId('startBtn'),
    syncBtn: byId('syncBtn'),
    status: byId('familyStatus'),
    carName: byId('familyCarName'),
    kwh: byId('familyKwh'),
    cost: byId('familyCost'),
    count: byId('familyCount'),
    split: byId('familySplit'),
    rateNote: byId('familyRateNote'),
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
    remove.setAttribute(
      'aria-label',
      `刪除 ${formatHkDate(record.startAt)} ${formatHkTime(record.startAt)} 紀錄`,
    );
    remove.addEventListener('click', () => onDelete(record));
    right.append(time, remove);
    li.append(main, right);
    return li;
  }

  function render() {
    els.carName.textContent = state.car.name || carId;
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
    setBusy(els.startBtn, state.syncing, '同步中…', '⚡ 開始充電');
    setBusy(els.syncBtn, state.syncing || !apiUrl, '更新中…', '更新 Tesla');

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
    if (!picked.rate) {
      els.rateNote.textContent = '未設定費率；電費暫不顯示。';
    } else {
      const baseline = Number(picked.rate.basicOffPeak) + Number(picked.rate.fuelAdjustment);
      const peak = Number(picked.rate.basicPeak) + Number(picked.rate.fuelAdjustment);
      const rebate = Number(picked.rate.rebate) || 0;
      const label = picked.fallback
        ? `按 CLP ${picked.rate.month} 費率估算（沿用）`
        : `按 CLP ${picked.rate.month} 費率估算`;
      els.rateNote.textContent = `${label}；非高峰 $${((baseline - rebate) / 100).toFixed(3)}/kWh；高峰 $${((peak - rebate) / 100).toFixed(3)}/kWh；實際電費以中電賬單為準。`;
    }

    const months = monthsWithRecords(records);
    const selected = state.selectedMonth === 'all' || months.includes(state.selectedMonth)
      ? state.selectedMonth
      : defaultMonth(records, new Date());
    const options = ['all', ...months];
    els.monthSelect.replaceChildren();
    for (const month of options) {
      const option = document.createElement('option');
      option.value = month;
      option.textContent = month === 'all' ? '全部月份' : month;
      els.monthSelect.append(option);
    }
    els.monthSelect.value = options.includes(selected) ? selected : 'all';
    state.selectedMonth = els.monthSelect.value;
    const selectedRecords = filterByMonth(records, els.monthSelect.value);
    els.exportBtn.disabled = selectedRecords.length === 0;
    els.exportHint.textContent = selectedRecords.length > 0
      ? `${selectedRecords.length} 筆紀錄；Excel 可直接開啟。`
      : '所選月份未有紀錄。';

    els.recentList.replaceChildren();
    for (const record of records.slice(0, 5)) els.recentList.append(makeRow(record));
    els.empty.hidden = records.length > 0;
    els.empty.textContent = apiUrl ? '未有紀錄。' : '未設定 Google Sheet；紀錄只會存喺呢部機。';
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
    state.server = data.records;
    state.car = data.car;
    state.rates = data.rates;
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
      showToast(els.toast, error.message || 'Tesla 同步失敗。');
    } finally {
      state.syncing = false;
      render();
    }
  }

  async function load() {
    render();
    if (!apiUrl) return;
    state.connecting = true;
    render();
    try {
      await fetchData();
      state.connecting = false;
      render();
      if (!state.offline) void runSync(true);
    } catch (error) {
      state.offline = true;
      state.connecting = false;
      render();
      showToast(els.toast, error.message || '未能連接，已顯示本機紀錄。');
    }
  }

  async function onStart() {
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
    state.pending = [record, ...state.pending];
    persist();
    render();
    showToast(els.toast, '已記錄開始時間。');
    if (!apiUrl) return;
    setBusy(els.startBtn, true, '同步中…', '⚡ 開始充電');
    try {
      await postRecord(apiUrl, record, carId);
      state.pending = state.pending.filter((row) => row.id !== record.id);
      state.server = [record, ...state.server];
      persist();
      render();
    } catch (error) {
      state.offline = true;
      render();
      showToast(els.toast, error.message || '暫時未能同步，會自動重試。');
    }
  }

  async function onDelete(record) {
    const message = record.teslaKey
      ? '刪除呢筆紀錄？Tesla session 亦會被忽略，之後唔會再自動匯入。'
      : '刪除呢筆紀錄？';
    if (!window.confirm(message)) return;
    state.deleting.add(record.id);
    render();
    try {
      if (apiUrl) await deleteRecord(apiUrl, record.id, { car: carId });
      state.pending = state.pending.filter((row) => row.id !== record.id);
      state.server = state.server.filter((row) => row.id !== record.id);
      persist();
      render();
      showToast(els.toast, '已刪除。');
    } catch (error) {
      showToast(els.toast, error.message || '刪除失敗，請重試。');
    } finally {
      state.deleting.delete(record.id);
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
```

- [ ] **Step 4: Replace `app.js` with the router**

```js
import { normalizeCar } from './logic.js';
import { initFamily } from './family.js';

const config = window.APP_CONFIG || {};
const apiUrl = typeof config.API_URL === 'string' ? config.API_URL.trim() : '';
const params = new URLSearchParams(window.location.search);
const familyView = document.getElementById('familyView');
const setupView = document.getElementById('setupView');
const car = params.get('car') ? normalizeCar({ id: params.get('car'), name: params.get('car') }) : null;

if (car) {
  familyView.hidden = false;
  initFamily({ apiUrl, carId: car.id });
} else {
  setupView.hidden = false;
}
```

- [ ] **Step 5: Replace the mock dev server**

Create `test/dev-server.mjs`:

```js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const port = Number(process.env.PORT || 8787);
const apiUrl = process.env.SMOKE_API_URL || `http://127.0.0.1:${port}/api`;
const delayMs = Number(process.env.SMOKE_DELAY_MS || 0);
const ownerKey = 'test-owner';
const cars = [
  { id: 'model3', name: 'Model 3', active: true },
  { id: 'leaf', name: 'Leaf', active: true },
];
const rates = [{
  month: '2026-11',
  basicOffPeak: 94.5,
  basicPeak: 137.5,
  fuelAdjustment: 47.4,
  rebate: 0,
  peakStart: '16:00',
  peakEnd: '23:00',
  sourceUrl: 'https://www.clp.com.hk/',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  manualOverride: false,
}];
const records = [
  {
    id: 'seed-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
    kWh: 20,
    durationSec: 7200,
    teslaStartAt: '2026-11-14T05:00:00.000Z',
    teslaEndAt: '2026-11-14T07:00:00.000Z',
    peakKWh: 10,
    offPeakKWh: 10,
    teslaKey: 'mock:seed-1',
    source: 'tesla+manual',
  },
  {
    id: 'seed-unassigned',
    car: 'unassigned',
    startAt: '2026-11-13T02:00:00.000Z',
    date: '2026-11-13',
    time: '10:00',
    kWh: 12,
    durationSec: 3600,
    teslaStartAt: '2026-11-13T02:00:00.000Z',
    teslaEndAt: '2026-11-13T03:00:00.000Z',
    peakKWh: 0,
    offPeakKWh: 12,
    teslaKey: 'mock:unassigned',
    source: 'tesla',
  },
];
const ignored = new Set();
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

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

function findCar(id) {
  return cars.find((car) => car.id === id);
}

function splitMock(startAt, durationSec, kwh) {
  const start = Date.parse(startAt);
  const end = start + durationSec * 1000;
  const hkStart = new Date(start + 8 * 3600 * 1000);
  const hkEnd = new Date(end + 8 * 3600 * 1000);
  const startMinutes = hkStart.getUTCHours() * 60 + hkStart.getUTCMinutes();
  const endMinutes = hkEnd.getUTCHours() * 60 + hkEnd.getUTCMinutes();
  const peakSeconds = Math.max(0, Math.min(endMinutes, 23 * 60) - Math.max(startMinutes, 16 * 60)) * 60;
  const total = Math.max(1, durationSec);
  const peakKWh = Math.round((kwh * Math.min(peakSeconds, total) / total) * 1e6) / 1e6;
  return { peakKWh, offPeakKWh: Math.round((kwh - peakKWh) * 1e6) / 1e6 };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  if (req.url?.startsWith('/api')) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET') {
      if (url.searchParams.get('owner')) {
        if (url.searchParams.get('owner') !== ownerKey) return fail(res, 403, 'Invalid owner key');
        return sendJson(res, 200, { ok: true, cars, records, rates });
      }
      const carId = url.searchParams.get('car');
      const car = findCar(carId);
      if (!car) return fail(res, 404, 'Unknown car');
      const visible = records.filter((record) => record.car === carId);
      return sendJson(res, 200, { ok: true, car, records: visible, rates });
    }
    if (req.method === 'POST') {
      let data;
      try {
        data = await readBody(req);
      } catch {
        return fail(res, 400, 'Invalid payload');
      }
      if (data.action === 'append') {
        if (!data.id || !findCar(data.car) || !data.startAt) return fail(res, 400, 'Invalid record');
        if (!records.some((record) => record.id === data.id)) {
          records.push({
            id: data.id,
            car: data.car,
            startAt: data.startAt,
            date: data.date,
            time: data.time,
            kWh: null,
            durationSec: null,
            teslaStartAt: null,
            teslaEndAt: null,
            peakKWh: null,
            offPeakKWh: null,
            teslaKey: null,
            source: 'manual',
          });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (data.action === 'delete') {
        if (data.ownerKey && data.ownerKey !== ownerKey) return fail(res, 403, 'Invalid owner key');
        const index = records.findIndex((record) => record.id === data.id);
        if (index >= 0) {
          const [removed] = records.splice(index, 1);
          if (removed.teslaKey) ignored.add(removed.teslaKey);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (data.action === 'sync') {
        const car = findCar(data.car);
        if (!car) return fail(res, 404, 'Unknown car');
        const pending = records.find((record) => (
          record.car === car.id && record.source === 'manual' && record.kWh === null
        ));
        if (pending) {
          const start = Date.parse(pending.startAt);
          pending.kWh = 20;
          pending.durationSec = 7200;
          pending.teslaStartAt = pending.startAt;
          pending.teslaEndAt = new Date(start + 7200000).toISOString();
          if (pending.id === 'seed-pending') {
            const split = splitMock(pending.startAt, 7200, 20);
            pending.peakKWh = split.peakKWh;
            pending.offPeakKWh = split.offPeakKWh;
          } else {
            // The family smoke uses a fixed 10/10 split so the expected cost is stable at any run time.
            pending.peakKWh = 10;
            pending.offPeakKWh = 10;
          }
          pending.teslaKey = `mock:${pending.id}`;
          pending.source = 'tesla+manual';
        }
        return sendJson(res, 200, { ok: true, matched: pending ? 1 : 0, unassigned: 0 });
      }
      if (data.action === 'assign') {
        if (data.ownerKey !== ownerKey) return fail(res, 403, 'Invalid owner key');
        const target = records.find((record) => record.id === data.id);
        const car = findCar(data.car);
        if (!target || !car) return fail(res, 400, 'Invalid assignment');
        target.car = car.id;
        const targetStart = Date.parse(target.teslaStartAt || target.startAt);
        const manual = records.find((record) => (
          record.id !== target.id
          && record.car === car.id
          && record.source === 'manual'
          && record.kWh === null
          && Math.abs(Date.parse(record.startAt) - targetStart) <= 1800000
        ));
        if (manual) {
          const index = records.indexOf(manual);
          records.splice(index, 1);
          target.startAt = manual.startAt;
          target.date = manual.date;
          target.time = manual.time;
          target.source = 'tesla+manual';
        }
        return sendJson(res, 200, { ok: true });
      }
      if (data.action === 'ignore') {
        if (data.ownerKey !== ownerKey) return fail(res, 403, 'Invalid owner key');
        const index = records.findIndex((record) => record.id === data.id);
        if (index >= 0) {
          const [removed] = records.splice(index, 1);
          if (removed.teslaKey) ignored.add(removed.teslaKey);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (data.action === 'refreshRates') {
        if (data.ownerKey !== ownerKey) return fail(res, 403, 'Invalid owner key');
        rates[0].fetchedAt = new Date().toISOString();
        return sendJson(res, 200, { ok: true, updated: rates.length });
      }
      return fail(res, 400, 'Unknown action');
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

- [ ] **Step 6: Run unit tests**

Run: `npm test`

Expected: all green.

- [ ] **Step 7: Browser smoke the family view**

Run the mock server in the background:

```bash
PORT=8787 node test/dev-server.mjs
```

Using the browser tool, open `http://127.0.0.1:8787/?car=model3`. Verify:

- `#familyCarName` shows `Model 3`.
- `#familyStatus` shows `已連接`.
- `#familyKwh` shows `20.0`, `#familyCost` shows `$32.68`, `#familyCount` shows `1`.
- The recent list shows the seeded 2026-11-14 record with `20.00 kWh · $32.68`.
- Click `#startBtn`; the toast shows `已記錄開始時間。`, the new first row shows `待配對 · —`.
- Click `#syncBtn`; wait for the spinner to finish; the new row shows `20.00 kWh · $32.68` and the summary kWh becomes `40.0`.
- Reload; the records still show two rows (server data).
- Set the viewport to 390x844; assert `document.documentElement.scrollWidth <= window.innerWidth`; take a screenshot and save it as `docs/screenshot-family.png` in the repo.
- Open `http://127.0.0.1:8787/` with no query; verify the setup message appears and the family view is hidden. Opening `?car=unknown` must show the family view in an offline/error state (the API rejects the unknown car); it must not fabricate a car.

If any step fails, fix the code before proceeding. Do not mark this task complete on unit tests alone.

- [ ] **Step 8: Commit**

```bash
git add index.html style.css family.js app.js test/dev-server.mjs docs/screenshot-family.png
git commit -m "feat: add family charging view"
```

---

### Task 5: Owner view and owner actions

**Files:**
- Modify: `index.html`
- Modify: `style.css`
- Modify: `app.js`
- Create: `owner.js`
- Modify: `test/dev-server.mjs`

**Interfaces:**
- Consumes: `fetchOwnerData`, `syncTesla`, `refreshRates`, `assignSession`, `ignoreSession` (Task 3); `initOwner({ apiUrl, sheetUrl, ownerKey })`.
- Produces: the `?owner=<48-hex>` management screen; per-car totals; unassigned/pending lists; rate cards; copyable family links.

- [ ] **Step 1: Add the owner view to `index.html`**

Insert this block after the closing `</div>` of `#familyView` and before `<script src="config.js">`:

```html
  <div id="ownerView" class="app" hidden>
    <header class="topbar">
      <div>
        <h1>EV 充電紀錄</h1>
        <p class="subtitle">管理</p>
      </div>
      <span id="ownerStatus" class="chip" data-state="idle">未設定</span>
    </header>

    <main>
      <div class="owner-actions">
        <button id="ownerSyncBtn" class="secondary" type="button">更新 Tesla</button>
        <button id="ownerRatesBtn" class="secondary" type="button">更新費率</button>
      </div>
      <a id="ownerSheetLink" class="sheet-link" target="_blank" rel="noreferrer" hidden>打開 Google Sheet</a>

      <section class="panel">
        <div class="owner-toolbar">
          <h2>月結</h2>
          <div class="owner-toolbar-actions">
            <select id="ownerMonth" aria-label="月結月份"></select>
            <button id="ownerExportBtn" type="button">匯出 CSV</button>
          </div>
        </div>
        <div id="ownerCarTotals" class="owner-cards"></div>
        <p id="ownerLegacy" class="hint"></p>
      </section>

      <section class="panel">
        <h2>未分配 session</h2>
        <ul id="ownerUnassigned" class="owner-list"></ul>
        <p id="ownerUnassignedEmpty" class="empty" hidden>冇未分配 session。</p>
      </section>

      <section class="panel">
        <h2>待配對</h2>
        <ul id="ownerPending" class="owner-list"></ul>
        <p id="ownerPendingEmpty" class="empty" hidden>冇待配對記錄。</p>
      </section>

      <section class="panel">
        <h2>費率</h2>
        <div id="ownerRates" class="owner-cards"></div>
        <p id="ownerRateSource" class="hint"></p>
      </section>

      <section class="panel">
        <h2>家人連結</h2>
        <div id="ownerLinks" class="owner-links"></div>
      </section>
    </main>

    <div id="ownerToast" class="toast" role="status" aria-live="polite"></div>
  </div>
```

- [ ] **Step 2: Add the owner CSS**

Append to `style.css` before the `[hidden]` rule:

```css
.owner-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.owner-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.owner-toolbar h2 { margin: 0; }
.owner-toolbar select { min-height: 44px; }
.owner-toolbar-actions { display: flex; gap: 8px; align-items: center; }

.owner-toolbar-actions button {
  min-height: 44px;
  border-radius: 10px;
  border: 0;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 700;
  padding: 0 12px;
  cursor: pointer;
}

.owner-toolbar-actions button:disabled { opacity: 0.4; cursor: default; }

.owner-cards { display: grid; gap: 10px; }

.owner-card {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 6px;
}

.owner-card-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}

.owner-card-title { font-weight: 700; }

.owner-card-total {
  color: var(--accent);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.owner-card-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.owner-card-row strong { color: var(--text); font-weight: 600; }

.owner-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }

.owner-list li {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  display: grid;
  gap: 8px;
}

.owner-row-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: baseline;
}

.owner-row-meta {
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.owner-row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.owner-row-actions select { min-height: 40px; flex: 1; min-width: 120px; }

.owner-row-actions button {
  min-height: 40px;
  border-radius: 10px;
  border: 1px solid #24322c;
  background: transparent;
  color: var(--text);
  padding: 0 12px;
  cursor: pointer;
}

.owner-row-actions .danger { color: var(--muted); }
.owner-row-actions .danger:hover { color: #f87171; border-color: #4a2323; }

.owner-links { display: grid; gap: 10px; }

.owner-link {
  display: grid;
  gap: 6px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
}

.owner-link-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.owner-link-url {
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}

.owner-link button {
  min-height: 40px;
  border-radius: 10px;
  border: 1px solid #24322c;
  background: transparent;
  color: var(--text);
  padding: 0 12px;
  cursor: pointer;
}
```

- [ ] **Step 3: Replace `app.js` with the full router**

```js
import { normalizeCar } from './logic.js';
import { initFamily } from './family.js';
import { initOwner } from './owner.js';

const config = window.APP_CONFIG || {};
const apiUrl = typeof config.API_URL === 'string' ? config.API_URL.trim() : '';
const sheetUrl = typeof config.SHEET_URL === 'string' ? config.SHEET_URL.trim() : '';
const params = new URLSearchParams(window.location.search);
const familyView = document.getElementById('familyView');
const ownerView = document.getElementById('ownerView');
const setupView = document.getElementById('setupView');
const ownerKey = params.get('owner');
const car = params.get('car')
  ? normalizeCar({ id: params.get('car'), name: params.get('car') })
  : null;

if (ownerKey && /^[a-f0-9]{48}$/.test(ownerKey)) {
  ownerView.hidden = false;
  initOwner({ apiUrl, sheetUrl, ownerKey });
} else if (car) {
  familyView.hidden = false;
  initFamily({ apiUrl, carId: car.id });
} else {
  setupView.hidden = false;
}
```

- [ ] **Step 4: Create `owner.js`**

```js
import {
  formatHkDate,
  formatHkTime,
  filterByMonth,
  monthsWithRecords,
  defaultMonth,
  summarizeRecords,
  toCsv,
} from './logic.js';
import {
  fetchOwnerData,
  syncTesla,
  refreshRates,
  assignSession,
  ignoreSession,
} from './api.js';
import { byId, showToast, setStatus, setBusy } from './ui.js';

export function initOwner({ apiUrl, sheetUrl, ownerKey }) {
  const state = {
    cars: [],
    records: [],
    rates: [],
    loading: Boolean(apiUrl),
    offline: false,
    busy: false,
    selectedMonth: null,
    monthTouched: false,
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
    unassigned: byId('ownerUnassigned'),
    unassignedEmpty: byId('ownerUnassignedEmpty'),
    pending: byId('ownerPending'),
    pendingEmpty: byId('ownerPendingEmpty'),
    rates: byId('ownerRates'),
    rateSource: byId('ownerRateSource'),
    links: byId('ownerLinks'),
    toast: byId('ownerToast'),
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

  function makeRateCard(rate) {
    const card = document.createElement('div');
    card.className = 'owner-card';
    const head = document.createElement('div');
    head.className = 'owner-card-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = rate.month;
    const badge = document.createElement('span');
    badge.className = 'owner-card-total';
    badge.textContent = rate.manualOverride ? '手動' : '自動';
    head.append(title, badge);
    card.append(head);
    const rebate = Number(rate.rebate) || 0;
    const off = (Number(rate.basicOffPeak) + Number(rate.fuelAdjustment) - rebate) / 100;
    const peak = (Number(rate.basicPeak) + Number(rate.fuelAdjustment) - rebate) / 100;
    card.append(textRow('非高峰', `$${off.toFixed(3)}/kWh`));
    card.append(textRow('高峰', `$${peak.toFixed(3)}/kWh`));
    card.append(textRow('燃料調整 / 回贈', `${Number(rate.fuelAdjustment).toFixed(1)} / ${rebate.toFixed(1)} 港仙`));
    card.append(textRow('高峰時段', `${rate.peakStart}–${rate.peakEnd}`));
    card.append(textRow('來源', rate.manualOverride ? '手動設定' : 'CLP 官方'));
    card.append(textRow('更新', rate.fetchedAt || '—'));
    return card;
  }

  function makeLinkCard(car) {
    const card = document.createElement('div');
    card.className = 'owner-link';
    const head = document.createElement('div');
    head.className = 'owner-link-head';
    const title = document.createElement('span');
    title.className = 'owner-card-title';
    title.textContent = car.name;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '複製連結';
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('car', car.id);
    url.hash = '';
    copy.addEventListener('click', () => { void onCopy(url.toString()); });
    head.append(title, copy);
    const link = document.createElement('a');
    link.className = 'owner-link-url';
    link.href = url.toString();
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = url.toString();
    card.append(head, link);
    return card;
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
    meta.textContent = `Tesla session · ${duration} · 非高峰 ${(record.offPeakKWh || 0).toFixed(2)} / 高峰 ${(record.peakKWh || 0).toFixed(2)} kWh`;

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
    const ignore = document.createElement('button');
    ignore.type = 'button';
    ignore.className = 'danger';
    ignore.textContent = '忽略';
    ignore.disabled = state.busy;
    ignore.addEventListener('click', () => { void onIgnore(record); });
    actions.append(select, assign, ignore);
    li.append(head, meta, actions);
    return li;
  }

  function makePendingRow(record) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'owner-row-head';
    const when = document.createElement('span');
    when.textContent = `${formatHkDate(record.startAt)} ${formatHkTime(record.startAt)}`;
    const car = state.cars.find((item) => item.id === record.car);
    const title = document.createElement('strong');
    title.textContent = car ? car.name : record.car;
    head.append(when, title);
    const meta = document.createElement('div');
    meta.className = 'owner-row-meta';
    meta.textContent = '手動開始紀錄，等待 Tesla session 配對。';
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
    setBusy(els.syncBtn, state.loading || state.busy || !apiUrl, '更新中…', '更新 Tesla');
    setBusy(els.ratesBtn, state.loading || state.busy || !apiUrl, '更新中…', '更新費率');
    if (sheetUrl) {
      els.sheetLink.href = sheetUrl;
      els.sheetLink.hidden = false;
    } else {
      els.sheetLink.hidden = true;
    }

    const records = state.records;
    const months = monthsWithRecords(records);
    const selected = state.monthTouched
      && (state.selectedMonth === 'all' || months.includes(state.selectedMonth))
      ? state.selectedMonth
      : defaultMonth(records, new Date());
    const options = ['all', ...months];
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

    const unassigned = filtered.filter((record) => record.car === 'unassigned');
    els.unassigned.replaceChildren();
    for (const record of unassigned) els.unassigned.append(makeUnassignedRow(record));
    els.unassignedEmpty.hidden = unassigned.length > 0;
    els.unassignedEmpty.textContent = activeCars.length === 0 ? '未有車輛可分配。' : '冇未分配 session。';

    const pending = filtered.filter((record) => record.car && record.car !== 'unassigned' && record.kWh === null);
    els.pending.replaceChildren();
    for (const record of pending) els.pending.append(makePendingRow(record));
    els.pendingEmpty.hidden = pending.length > 0;

    els.rates.replaceChildren();
    const sortedRates = state.rates.slice().sort((a, b) => b.month.localeCompare(a.month));
    if (sortedRates.length === 0) {
      els.rates.append(emptyLabel('未有費率；請按「更新費率」。'));
    } else {
      for (const rate of sortedRates) els.rates.append(makeRateCard(rate));
    }
    const latest = sortedRates[0];
    els.rateSource.textContent = latest
      ? `來源：CLP 官方網站 · 最後更新 ${latest.fetchedAt || '未記錄'}`
      : '未有費率資料。';

    els.links.replaceChildren();
    if (activeCars.length === 0) {
      els.links.append(emptyLabel('未有車輛連結。'));
    } else {
      for (const car of activeCars) els.links.append(makeLinkCard(car));
    }
  }

  async function refreshData() {
    const data = await fetchOwnerData(apiUrl, ownerKey);
    state.cars = data.cars;
    state.records = data.records;
    state.rates = data.rates;
    state.offline = false;
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
      showToast(els.toast, '未能載入管理資料，請確認管理連結及網絡。');
    }
  }

  async function onSync() {
    if (!apiUrl || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await syncTesla(apiUrl, { ownerKey });
      await refreshData();
      showToast(els.toast, `已配對 ${Number(result.matched) || 0} 個；新增未分配 ${Number(result.unassigned) || 0} 個。`);
    } catch {
      state.offline = true;
      showToast(els.toast, 'Tesla 同步失敗，請檢查網絡後重試。');
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
      const result = await refreshRates(apiUrl, ownerKey);
      await refreshData();
      showToast(els.toast, `已更新 ${Number(result.updated) || 0} 個月份費率。`);
    } catch {
      state.offline = true;
      showToast(els.toast, '費率更新失敗，請檢查網絡後重試。');
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
      await assignSession(apiUrl, ownerKey, record.id, car);
      await refreshData();
      showToast(els.toast, '已分配。');
    } catch {
      state.offline = true;
      showToast(els.toast, '分配失敗，請檢查網絡後重試。');
    } finally {
      state.busy = false;
      render();
    }
  }

  async function onIgnore(record) {
    if (!window.confirm('忽略呢個 session？之後唔會再匯入。')) return;
    if (!apiUrl || state.busy) return;
    state.busy = true;
    render();
    try {
      await ignoreSession(apiUrl, ownerKey, record.id);
      await refreshData();
      showToast(els.toast, '已忽略。');
    } catch {
      state.offline = true;
      showToast(els.toast, '忽略失敗，請檢查網絡後重試。');
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
  window.addEventListener('online', () => {
    if (apiUrl) void load();
  });
  void load();
}
```

- [ ] **Step 5: Extend the mock server for the owner smoke**

In `test/dev-server.mjs`:

Change the owner key to a value accepted by the router:

```js
const ownerKey = 'a'.repeat(48);
```

Add a pending manual record to the `records` array after `seed-unassigned`:

```js
  {
    id: 'seed-pending',
    car: 'model3',
    startAt: '2026-11-14T06:00:00.000Z',
    date: '2026-11-14',
    time: '14:00',
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
    source: 'manual',
  },
```

In the `sync` action, replace the pending lookup with the newest matching manual row:

```js
        const pending = [...records].reverse().find((record) => (
          record.car === car.id && record.source === 'manual' && record.kWh === null
        ));
```

- [ ] **Step 6: Run unit tests**

Run: `npm test`

Expected: all green.

- [ ] **Step 7: Browser smoke the owner view**

Start the mock server:

```bash
PORT=8787 node test/dev-server.mjs
```

Open `http://127.0.0.1:8787/?owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (48 `a` characters). Verify:

- `#ownerStatus` shows `已連接`.
- `#ownerCarTotals` shows `Model 3` and `Leaf`; the Model 3 total is `$32.68` before sync (the pending row has no kWh yet; only the seeded matched row contributes cost).
- `#ownerUnassigned` shows the 2026-11-13 Tesla session with its 60-minute duration; `#ownerPending` shows the 2026-11-14 manual record.
- `#ownerRates` shows the 2026-11 rate card with non-peak `$1.419/kWh`, peak `$1.849/kWh`, source `CLP 官方`, and the fetched timestamp.
- `#ownerLinks` shows `Model 3` and `Leaf` links; each URL contains `?car=model3` or `?car=leaf` and no `owner=` key.
- Click `#ownerSyncBtn`; wait; `#ownerPending` becomes empty and the Model 3 card shows 2 sessions, 40.0 kWh, and `$61.06` (the pending session runs 14:00–16:00, all off-peak).
- Select `Leaf` in the unassigned row and click `分配`; `#ownerUnassigned` becomes empty and the Leaf card shows 12.0 kWh and `$17.03`.
- Click `#ownerRatesBtn`; the toast reports the updated months.
- Click `#ownerExportBtn`; the button is enabled and a file named `ev-charge-all-2026-11.csv` is downloaded. If the browser blocks downloads, verify the button enabled state and rely on the unit-tested CSV logic.
- Click a `複製連結` button; the toast shows `連結已複製。` (grant clipboard permission if the browser asks).
- Set the viewport to 390x844; assert no horizontal scroll; save a screenshot as `docs/screenshot-owner.png`.
- Open the copied Model 3 link in the same browser; the family view loads and `#familyCarName` is `Model 3`.

If the browser blocks clipboard access, use the link text assertion (the URL is visible) and note the clipboard limitation in the commit message; do not fail the task for an environment permission.

- [ ] **Step 8: Commit**

```bash
git add index.html style.css app.js owner.js test/dev-server.mjs docs/screenshot-owner.png
git commit -m "feat: add owner management view"
```

---

### Task 6: Apps Script pure logic and parsers

**Files:**
- Create: `apps-script/Logic.gs`
- Create: `test/apps-script-logic.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (global Apps Script functions):
  - `hkDateString_(iso)`, `hkTimeString_(iso)`, `hkMonth_(iso)`
  - `validIso_(value)`, `validMonth_(value)`, `validCarId_(value)`
  - `splitPeakKwh_(startIso, durationSec, kwh, peakStart, peakEnd)` → `{ peakKWh, offPeakKWh }`
  - `closestManualCandidate_(sessionStartIso, manualRows, windowMs)` → row or `null`
  - `parseFuelAdjustmentPage_(text)` → `{ current, rows }`
  - `parseTariffPage_(text)` → `{ basicOffPeak, basicPeak, peakStart, peakEnd }` or `null`

- [ ] **Step 1: Write the failing VM tests**

Create `test/apps-script-logic.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../apps-script/Logic.gs', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const call = (name, ...args) => context[name](...args);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('hkDateString_, hkTimeString_, and hkMonth_ use Hong Kong time', () => {
  assert.equal(call('hkDateString_', '2026-11-14T16:30:00.000Z'), '2026-11-15');
  assert.equal(call('hkTimeString_', '2026-11-14T16:30:00.000Z'), '00:30');
  assert.equal(call('hkMonth_', '2026-11-14T16:30:00.000Z'), '2026-11');
  assert.equal(call('validMonth_', '2026-11'), true);
  assert.equal(call('validMonth_', '2026-13'), false);
  assert.equal(call('validCarId_', 'model3'), true);
  assert.equal(call('validCarId_', 'Bad Car'), false);
});

test('splitPeakKwh_ splits at the 16:00 and 23:00 Hong Kong boundaries', () => {
  // 15:30 HK, one hour: 30 minutes off-peak, 30 minutes peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T07:30:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 3.6,
    offPeakKWh: 3.6,
  });
  // 16:00 HK, one hour: all peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T08:00:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 7.2,
    offPeakKWh: 0,
  });
  // 22:30 HK, one hour: 30 minutes peak, 30 minutes off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T14:30:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 3.6,
    offPeakKWh: 3.6,
  });
  // 23:00 HK, one hour: all off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T15:00:00.000Z', 3600, 7.2, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 7.2,
  });
  // Crosses midnight from 23:30; still all off-peak.
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T15:30:00.000Z', 7200, 14.4, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 14.4,
  });
  // Rounded split sums to the original energy.
  const rounded = plain(call('splitPeakKwh_', '2026-11-14T07:20:00.000Z', 2700, 5.4, '16:00', '23:00'));
  assert.equal(Number((rounded.peakKWh + rounded.offPeakKWh).toFixed(6)), 5.4);
});

test('splitPeakKwh_ falls back to all off-peak without duration or energy', () => {
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T05:00:00.000Z', 0, 0, '16:00', '23:00')), {
    peakKWh: 0,
    offPeakKWh: 0,
  });
  assert.deepEqual(plain(call('splitPeakKwh_', '2026-11-14T05:00:00.000Z', 3600, 10, '', '')), {
    peakKWh: 0,
    offPeakKWh: 10,
  });
});

test('closestManualCandidate_ matches the nearest unlinked manual row within the window', () => {
  const rows = [
    {
      id: 'm1', car: 'model3', startAt: '2026-11-14T05:00:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm2', car: 'model3', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm3', car: 'model3', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: 1, teslaKey: null,
    },
    {
      id: 'm4', car: 'unassigned', startAt: '2026-11-14T05:10:00.000Z', source: 'manual', kWh: null, teslaKey: null,
    },
    {
      id: 'm5', car: 'model3', startAt: '2026-11-14T06:00:00.000Z', source: 'manual', kWh: null, teslaKey: 'din:x',
    },
  ];
  const match = call('closestManualCandidate_', '2026-11-14T05:12:00.000Z', rows, 30 * 60 * 1000);
  assert.equal(match.id, 'm2');
  assert.equal(call('closestManualCandidate_', '2026-11-14T06:30:00.000Z', rows, 30 * 60 * 1000), null);
  assert.equal(call('closestManualCandidate_', 'not-a-date', rows, 30 * 60 * 1000), null);
});

test('parseFuelAdjustmentPage_ extracts the current month and the yearly table', () => {
  const page = `
燃料調整費
2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
2026年11月1日起，燃料調整費為每度電47.4港仙。
`;
  const parsed = call('parseFuelAdjustmentPage_', page);
  assert.deepEqual(plain(parsed.current), { month: '2026-11', fuelAdjustment: 47.4 });
  assert.equal(parsed.rows.length, 11);
  assert.deepEqual(plain(parsed.rows[10]), { month: '2026-11', fuelAdjustment: 47.4 });
  assert.deepEqual(plain(call('parseFuelAdjustmentPage_', 'no rates here')), { current: null, rows: [] });
});

test('parseTariffPage_ extracts the basic charges and confirms the peak window', () => {
  const page = `
電動車住宅分時段用電價目
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
燃料調整費每月浮動。
`;
  assert.deepEqual(plain(call('parseTariffPage_', page)), {
    basicOffPeak: 94.5,
    basicPeak: 137.5,
    peakStart: '16:00',
    peakEnd: '23:00',
  });
  assert.equal(call('parseTariffPage_', 'no tariff here'), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `apps-script/Logic.gs` does not exist.

- [ ] **Step 3: Implement `apps-script/Logic.gs`**

```javascript
var HK_OFFSET_MS_ = 8 * 60 * 60 * 1000;
var DEFAULT_PEAK_START_ = '16:00';
var DEFAULT_PEAK_END_ = '23:00';

function pad2_(value) {
  return ('0' + value).slice(-2);
}

function round6_(value) {
  return Math.round(value * 1e6) / 1e6;
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === '') return null;
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function validIso_(value) {
  return typeof value === 'string' && !isNaN(Date.parse(value));
}

function validMonth_(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function validCarId_(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value);
}

function hkDateString_(iso) {
  var d = new Date(Date.parse(iso) + HK_OFFSET_MS_);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function hkTimeString_(iso) {
  var d = new Date(Date.parse(iso) + HK_OFFSET_MS_);
  return pad2_(d.getUTCHours()) + ':' + pad2_(d.getUTCMinutes());
}

function hkMonth_(iso) {
  return hkDateString_(iso).slice(0, 7);
}

function parseHm_(value) {
  var match = String(value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function overlapPeakSeconds_(startSec, endSec, peakStartSec, peakEndSec) {
  if (endSec <= startSec || peakStartSec === peakEndSec) return 0;
  if (peakStartSec < peakEndSec) {
    return Math.max(0, Math.min(endSec, peakEndSec) - Math.max(startSec, peakStartSec));
  }
  return Math.max(0, Math.min(endSec, 86400) - Math.max(startSec, peakStartSec))
    + Math.max(0, Math.min(endSec, peakEndSec) - Math.max(startSec, 0));
}

function splitPeakKwh_(startIso, durationSec, kwh, peakStart, peakEnd) {
  var duration = Math.max(0, Math.floor(Number(durationSec) || 0));
  var energy = Math.max(0, Number(kwh) || 0);
  if (!energy) return { peakKWh: 0, offPeakKWh: 0 };
  if (!duration || !validIso_(startIso)) {
    return { peakKWh: 0, offPeakKWh: round6_(energy) };
  }
  var startMinutes = parseHm_(peakStart);
  var endMinutes = parseHm_(peakEnd);
  var peakStartSec = (startMinutes == null ? parseHm_(DEFAULT_PEAK_START_) : startMinutes) * 60;
  var peakEndSec = (endMinutes == null ? parseHm_(DEFAULT_PEAK_END_) : endMinutes) * 60;
  var localStart = Date.parse(startIso) + HK_OFFSET_MS_;
  var localEnd = localStart + duration * 1000;
  var cursor = localStart;
  var peakSeconds = 0;
  while (cursor < localEnd) {
    var dayStart = Math.floor(cursor / 86400000) * 86400000;
    var dayEnd = dayStart + 86400000;
    var segmentEnd = Math.min(localEnd, dayEnd);
    var sodStart = (cursor - dayStart) / 1000;
    var sodEnd = (segmentEnd - dayStart) / 1000;
    peakSeconds += overlapPeakSeconds_(sodStart, sodEnd, peakStartSec, peakEndSec);
    cursor = segmentEnd;
  }
  var peakKWh = energy * (peakSeconds / duration);
  return { peakKWh: round6_(peakKWh), offPeakKWh: round6_(energy - peakKWh) };
}

function closestManualCandidate_(sessionStartIso, manualRows, windowMs) {
  var target = Date.parse(sessionStartIso);
  if (isNaN(target)) return null;
  var best = null;
  var bestDelta = Infinity;
  for (var i = 0; i < (manualRows || []).length; i++) {
    var row = manualRows[i];
    if (!row || row.source !== 'manual' || !row.car || row.car === 'unassigned') continue;
    if (row.kWh != null || row.teslaKey) continue;
    var start = Date.parse(row.startAt);
    if (isNaN(start)) continue;
    var delta = Math.abs(start - target);
    if (delta > windowMs) continue;
    if (delta < bestDelta || (delta === bestDelta && best && String(row.id) < String(best.id))) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}

function parseFuelAdjustmentPage_(text) {
  var source = String(text || '');
  var current = source.match(/(\d{4})年(\d{1,2})月1日起，燃料調整費為每度電([\d.]+)港仙/);
  if (!current) return { current: null, rows: [] };
  var year = Number(current[1]);
  var month = Number(current[2]);
  var cents = Number(current[3]);
  var sectionMatch = source.match(/每月燃料調整費[\s\S]*?(?=本月調整計算|$)/);
  var section = sectionMatch ? sectionMatch[0] : '';
  var months = [];
  var monthMatches = section.matchAll(/(\d{1,2})月/g);
  for (var m = monthMatches.next(); !m.done; m = monthMatches.next()) {
    months.push(Number(m.value[1]));
  }
  var values = [];
  var valueMatches = section.matchAll(/(?:^|\n)\s*(\d{2}\.\d)\*?\s*(?=\n|$)/g);
  for (var v = valueMatches.next(); !v.done; v = valueMatches.next()) {
    values.push(Number(v.value[1]));
  }
  var rows = [];
  var count = Math.min(months.length, values.length);
  for (var i = 0; i < count; i++) {
    rows.push({ month: year + '-' + pad2_(months[i]), fuelAdjustment: values[i] });
  }
  var key = year + '-' + pad2_(month);
  var found = false;
  for (var j = 0; j < rows.length; j++) {
    if (rows[j].month === key) found = true;
  }
  if (!found) rows.push({ month: key, fuelAdjustment: cents });
  return { current: { month: key, fuelAdjustment: cents }, rows: rows };
}

function parseTariffPage_(text) {
  var source = String(text || '');
  var off = source.match(/(?:^|\n)\s*非高峰用電時間[\s\S]{0,300}?(\d{2,3}\.\d)/);
  var peak = source.match(/(?:^|\n)\s*高峰用電時間[\s\S]{0,300}?(\d{2,3}\.\d)/);
  if (!off || !peak) return null;
  return {
    basicOffPeak: Number(off[1]),
    basicPeak: Number(peak[1]),
    peakStart: DEFAULT_PEAK_START_,
    peakEnd: DEFAULT_PEAK_END_,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: all green, including the existing frontend and probe tests.

- [ ] **Step 5: Syntax-check the Apps Script file**

Run:

```bash
cp apps-script/Logic.gs /tmp/ev-logic.js
node --check /tmp/ev-logic.js
```

Expected: exit 0. The VM tests already execute every function.

- [ ] **Step 6: Commit**

```bash
git add apps-script/Logic.gs test/apps-script-logic.test.mjs
git commit -m "feat: add Apps Script billing logic and CLP parsers"
```

---

### Task 7: Sheet repository and header migration

**Files:**
- Create: `apps-script/SheetRepo.gs`
- Create: `test/apps-script-sheet.test.mjs`

**Interfaces:**
- Consumes: `Logic.gs` helpers, `SpreadsheetApp`, the global `SHEET_ID`.
- Produces:
  - `LOG_COLUMNS`, `CARS_COLUMNS`, `RATES_COLUMNS`, `IGNORED_COLUMNS`
  - `readLog_()`, `appendLog_(record)`, `updateLog_(id, patch)`, `deleteLog_(id)`
  - `readCars_()`, `readRates_()`, `upsertRates_(rates)`
  - `readIgnored_()`, `addIgnored_(teslaKey, reason)`

- [ ] **Step 1: Write the failing fake-Sheets tests**

Create `test/apps-script-sheet.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const logicSource = readFileSync(new URL('../apps-script/Logic.gs', import.meta.url), 'utf8');
const repoSource = readFileSync(new URL('../apps-script/SheetRepo.gs', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeSheet(initial) {
  const data = (initial || []).map((row) => [...row]);
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({ getValues: () => data.map((row) => [...row]) }),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r += 1) {
            const line = [];
            for (let c = 0; c < numCols; c += 1) {
              const source = data[row - 1 + r] || [];
              line.push(source[col - 1 + c] ?? '');
            }
            out.push(line);
          }
          return out;
        },
        setValues(next) {
          for (let r = 0; r < numRows; r += 1) {
            const target = row - 1 + r;
            while (data.length <= target) data.push([]);
            const line = data[target];
            for (let c = 0; c < numCols; c += 1) line[col - 1 + c] = next[r][c];
          }
        },
      };
    },
    appendRow(next) {
      data.push([...next]);
    },
    deleteRow(row) {
      data.splice(row - 1, 1);
    },
    setFrozenRows() {},
  };
}

function createEnv({ sheets = {}, props = {}, fetch: fetchHandler } = {}) {
  const sheetMap = new Map();
  for (const [name, values] of Object.entries(sheets)) {
    sheetMap.set(name, makeSheet(values));
  }
  const spreadsheet = {
    getSheetByName: (name) => sheetMap.get(name) || null,
    insertSheet: (name) => {
      const sheet = makeSheet([]);
      sheetMap.set(name, sheet);
      return sheet;
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null),
        setProperty: (key, value) => { props[key] = String(value); },
        deleteProperty: (key) => { delete props[key]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: {
      fetch: fetchHandler || (() => { throw new Error('Unexpected UrlFetchApp.fetch'); }),
    },
    ContentService: {
      createTextOutput: (text) => ({
        text,
        mimeType: '',
        setMimeType(type) { this.mimeType = type; return this; },
        getContent() { return this.text; },
      }),
    },
    MimeType: { JSON: 'application/json' },
    console: { log() {}, error() {} },
    SHEET_ID: 'fake-sheet',
  });
  vm.runInContext(logicSource, context);
  vm.runInContext(repoSource, context);
  return {
    context,
    props,
    spreadsheet,
    call: (name, ...args) => context[name](...args),
    values: (name) => {
      const sheet = sheetMap.get(name);
      return sheet ? sheet.getDataRange().getValues() : [];
    },
  };
}

const record = {
  id: 'rec-1',
  car: 'model3',
  startAt: '2026-11-14T05:00:00.000Z',
  date: '2026-11-14',
  time: '13:00',
  kWh: 20,
  durationSec: 7200,
  teslaStartAt: '2026-11-14T05:00:00.000Z',
  teslaEndAt: '2026-11-14T07:00:00.000Z',
  peakKWh: 10,
  offPeakKWh: 10,
  teslaKey: 'din:1786968749',
  source: 'tesla+manual',
};

test('readLog_ migrates the old header in place and marks old rows legacy', () => {
  const env = createEnv({
    sheets: {
      Log: [
        ['id', 'startAt', '日期', '時間'],
        ['old-1', '2026-11-01T00:00:00.000Z', '2026-11-01', '08:00'],
      ],
    },
  });
  const rows = plain(env.call('readLog_'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'legacy');
  assert.equal(rows[0].car, '');
  assert.equal(rows[0].date, '2026-11-01');
  assert.deepEqual(
    env.values('Log')[0].slice(4),
    ['car', 'kWh', 'durationSec', 'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source'],
  );
  assert.equal(env.values('Log')[1][0], 'old-1');
});

test('appendLog_ writes the logical fields into the mapped columns', () => {
  const env = createEnv({});
  env.call('appendLog_', record);
  const rows = plain(env.call('readLog_'));
  assert.deepEqual(rows, [record]);
  const sheetRows = env.values('Log');
  assert.deepEqual(sheetRows[0], [
    'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec', 'teslaStartAt',
    'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
  ]);
  assert.equal(sheetRows[1][2], '2026-11-14');
  assert.equal(sheetRows[1][3], '13:00');
  assert.equal(sheetRows[1][4], 'model3');
});

test('updateLog_ patches fields without losing date and time, and deleteLog_ removes the row', () => {
  const env = createEnv({});
  env.call('appendLog_', record);
  const updated = plain(env.call('updateLog_', 'rec-1', {
    kWh: 21,
    peakKWh: 11,
    source: 'tesla',
  }));
  assert.equal(updated.kWh, 21);
  assert.equal(updated.peakKWh, 11);
  assert.equal(updated.date, '2026-11-14');
  assert.equal(updated.time, '13:00');
  assert.equal(env.call('deleteLog_', 'rec-1'), true);
  assert.equal(env.call('deleteLog_', 'rec-1'), false);
  assert.deepEqual(plain(env.call('readLog_')), []);
});

test('readCars_ filters invalid ids, reserved unassigned, and active flags', () => {
  const env = createEnv({
    sheets: {
      Cars: [
        ['id', 'name', 'active', 'createdAt'],
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'FALSE', 'x'],
        ['Bad Car', 'Bad', 'TRUE', 'x'],
        ['unassigned', 'Unassigned', 'TRUE', 'x'],
      ],
    },
  });
  assert.deepEqual(plain(env.call('readCars_')), [
    { id: 'model3', name: 'Model 3', active: true },
    { id: 'leaf', name: 'Leaf', active: false },
  ]);
});

test('readRates_ normalizes rows and readIgnored_ returns unique keys', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-11', '94.5', '137.5', '47.4', '0', '16:00', '23:00', 'u', 'f', 'FALSE'],
      ],
      Ignored: [
        ['teslaKey', 'ignoredAt', 'reason'],
        ['din:a', 'x', 'deleted'],
      ],
    },
  });
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 1);
  assert.equal(rates[0].month, '2026-11');
  assert.equal(rates[0].manualOverride, false);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:a']);
});

test('upsertRates_ updates automatic rows, appends missing months, and skips manual overrides', () => {
  const env = createEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-10', '90', '130', '40', '0', '16:00', '23:00', 'u', 'f', 'TRUE'],
      ],
    },
  });
  const updated = env.call('upsertRates_', [
    {
      month: '2026-10', basicOffPeak: 1, basicPeak: 2, fuelAdjustment: 3, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'x', fetchedAt: 'x', manualOverride: false,
    },
    {
      month: '2026-11', basicOffPeak: 94.5, basicPeak: 137.5, fuelAdjustment: 47.4, rebate: 0,
      peakStart: '16:00', peakEnd: '23:00', sourceUrl: 'x', fetchedAt: 'x', manualOverride: false,
    },
  ]);
  assert.equal(updated, 1);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.find((row) => row.month === '2026-10').basicOffPeak, 90);
  assert.equal(rates.find((row) => row.month === '2026-11').basicOffPeak, 94.5);
});

test('addIgnored_ deduplicates and readIgnored_ returns the key', () => {
  const env = createEnv({});
  env.call('addIgnored_', 'din:x', 'deleted');
  env.call('addIgnored_', 'din:x', 'again');
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:x']);
  assert.equal(env.values('Ignored').length, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `apps-script/SheetRepo.gs` does not exist.

- [ ] **Step 3: Implement `apps-script/SheetRepo.gs`**

```javascript
var LOG_COLUMNS = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
var CARS_COLUMNS = ['id', 'name', 'active', 'createdAt'];
var RATES_COLUMNS = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];
var IGNORED_COLUMNS = ['teslaKey', 'ignoredAt', 'reason'];

function openSpreadsheet_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function ensureHeader_(sheet, columns) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    sheet.setFrozenRows(1);
    return;
  }
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (value) { return String(value || '').trim(); });
  var missing = columns.filter(function (column) { return header.indexOf(column) === -1; });
  if (!missing.length) return;
  sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
}

function sheetNamed_(spreadsheet, name, columns) {
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  ensureHeader_(sheet, columns);
  return sheet;
}

function readObjects_(sheet, columns) {
  ensureHeader_(sheet, columns);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var objects = [];
  for (var i = 1; i < values.length; i += 1) {
    var row = values[i];
    var empty = true;
    for (var j = 0; j < row.length; j += 1) {
      if (String(row[j] === undefined || row[j] === null ? '' : row[j]).trim() !== '') {
        empty = false;
        break;
      }
    }
    if (empty) continue;
    var object = {};
    for (var k = 0; k < header.length; k += 1) object[header[k]] = row[k];
    objects.push(object);
  }
  return objects;
}

function logValue_(record, column) {
  if (column === '日期') return record.date;
  if (column === '時間') return record.time;
  return record[column];
}

function normalizeLogRow_(row) {
  var car = row.car ? String(row.car).trim() : '';
  var source = row.source ? String(row.source).trim() : (car ? 'manual' : 'legacy');
  var startAt = String(row.startAt || '').trim();
  return {
    id: String(row.id || '').trim(),
    car: car,
    startAt: startAt,
    date: String(row['日期'] || '').trim() || (validIso_(startAt) ? hkDateString_(startAt) : ''),
    time: String(row['時間'] || '').trim() || (validIso_(startAt) ? hkTimeString_(startAt) : ''),
    kWh: numberOrNull_(row.kWh),
    durationSec: numberOrNull_(row.durationSec),
    teslaStartAt: validIso_(row.teslaStartAt) ? String(row.teslaStartAt) : null,
    teslaEndAt: validIso_(row.teslaEndAt) ? String(row.teslaEndAt) : null,
    peakKWh: numberOrNull_(row.peakKWh),
    offPeakKWh: numberOrNull_(row.offPeakKWh),
    teslaKey: row.teslaKey ? String(row.teslaKey) : null,
    source: source,
  };
}

function readLog_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var rows = readObjects_(sheet, LOG_COLUMNS);
  var records = [];
  for (var i = 0; i < rows.length; i += 1) {
    var record = normalizeLogRow_(rows[i]);
    if (!record.id || !validIso_(record.startAt)) continue;
    records.push(record);
  }
  return records;
}

function appendLog_(record) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var row = LOG_COLUMNS.map(function (column) {
    var value = logValue_(record, column);
    return value === undefined || value === null ? '' : value;
  });
  sheet.appendRow(row);
}

function updateLog_(id, patch) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return null;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  if (idCol === -1) return null;
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idCol] || '') !== String(id)) continue;
    var current = {};
    for (var j = 0; j < header.length; j += 1) current[header[j]] = values[i][j];
    if (!current.date && current['日期']) current.date = current['日期'];
    if (!current.time && current['時間']) current.time = current['時間'];
    for (var key in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
    }
    if (!current.date && validIso_(current.startAt)) current.date = hkDateString_(current.startAt);
    if (!current.time && validIso_(current.startAt)) current.time = hkTimeString_(current.startAt);
    var row = LOG_COLUMNS.map(function (column) {
      var value = logValue_(current, column);
      return value === undefined || value === null ? '' : value;
    });
    sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
    return normalizeLogRow_(current);
  }
  return null;
}

function deleteLog_(id) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Log', LOG_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return false;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  if (idCol === -1) return false;
  for (var i = 1; i < values.length; i += 1) {
    if (String(values[i][idCol] || '') === String(id)) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

function normalizeCarRow_(row) {
  var id = String(row.id || '').trim();
  var name = String(row.name || '').trim();
  if (!validCarId_(id) || !name || id === 'unassigned') return null;
  return {
    id: id,
    name: name,
    active: String(row.active).toUpperCase() !== 'FALSE' && row.active !== false,
  };
}

function readCars_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Cars', CARS_COLUMNS);
  var rows = readObjects_(sheet, CARS_COLUMNS);
  var cars = [];
  for (var i = 0; i < rows.length; i += 1) {
    var car = normalizeCarRow_(rows[i]);
    if (car) cars.push(car);
  }
  return cars;
}

function normalizeRateRow_(row) {
  var month = String(row.month || '').trim();
  if (!validMonth_(month)) return null;
  var basicOffPeak = numberOrNull_(row.basicOffPeak);
  var basicPeak = numberOrNull_(row.basicPeak);
  var fuelAdjustment = numberOrNull_(row.fuelAdjustment);
  if (basicOffPeak === null || basicPeak === null || fuelAdjustment === null) return null;
  var peakStart = String(row.peakStart || DEFAULT_PEAK_START_).trim();
  var peakEnd = String(row.peakEnd || DEFAULT_PEAK_END_).trim();
  if (parseHm_(peakStart) === null) peakStart = DEFAULT_PEAK_START_;
  if (parseHm_(peakEnd) === null) peakEnd = DEFAULT_PEAK_END_;
  return {
    month: month,
    basicOffPeak: basicOffPeak,
    basicPeak: basicPeak,
    fuelAdjustment: fuelAdjustment,
    rebate: numberOrNull_(row.rebate) || 0,
    peakStart: peakStart,
    peakEnd: peakEnd,
    sourceUrl: String(row.sourceUrl || ''),
    fetchedAt: String(row.fetchedAt || ''),
    manualOverride: String(row.manualOverride || '').toUpperCase() === 'TRUE',
  };
}

function readRates_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Rates', RATES_COLUMNS);
  var rows = readObjects_(sheet, RATES_COLUMNS);
  var rates = [];
  for (var i = 0; i < rows.length; i += 1) {
    var rate = normalizeRateRow_(rows[i]);
    if (rate) rates.push(rate);
  }
  return rates;
}

function upsertRates_(rates) {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Rates', RATES_COLUMNS);
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var monthCol = header.indexOf('month');
  var manualCol = header.indexOf('manualOverride');
  var updated = 0;
  for (var r = 0; r < rates.length; r += 1) {
    var rate = rates[r];
    if (!rate || !validMonth_(rate.month)) continue;
    var found = -1;
    var manual = false;
    for (var i = 1; i < values.length; i += 1) {
      if (String(values[i][monthCol] || '') === rate.month) {
        found = i;
        manual = String(values[i][manualCol] || '').toUpperCase() === 'TRUE';
        break;
      }
    }
    if (manual) continue;
    var row = RATES_COLUMNS.map(function (column) {
      var value = column === 'manualOverride'
        ? (rate.manualOverride ? 'TRUE' : 'FALSE')
        : rate[column];
      return value === undefined || value === null ? '' : value;
    });
    if (found >= 0) {
      sheet.getRange(found + 1, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
      values = sheet.getDataRange().getValues();
    }
    updated += 1;
  }
  return updated;
}

function readIgnored_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Ignored', IGNORED_COLUMNS);
  var rows = readObjects_(sheet, IGNORED_COLUMNS);
  var keys = [];
  for (var i = 0; i < rows.length; i += 1) {
    var key = String(rows[i].teslaKey || '').trim();
    if (key) keys.push(key);
  }
  return keys;
}

function addIgnored_(teslaKey, reason) {
  if (!teslaKey) return;
  var sheet = sheetNamed_(openSpreadsheet_(), 'Ignored', IGNORED_COLUMNS);
  var rows = readObjects_(sheet, IGNORED_COLUMNS);
  for (var i = 0; i < rows.length; i += 1) {
    if (String(rows[i].teslaKey || '').trim() === teslaKey) return;
  }
  sheet.appendRow([teslaKey, new Date().toISOString(), reason || '']);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: all green, including the new header migration and repository tests.

- [ ] **Step 5: Syntax-check both Apps Script files**

```bash
cp apps-script/Logic.gs /tmp/ev-logic.js
cp apps-script/SheetRepo.gs /tmp/ev-sheet.js
node --check /tmp/ev-logic.js
node --check /tmp/ev-sheet.js
```

Expected: exit 0 for both.

- [ ] **Step 6: Commit**

```bash
git add apps-script/SheetRepo.gs test/apps-script-sheet.test.mjs
git commit -m "feat: add Sheet repository and header migration"
```

---

### Task 8: Tesla and CLP rate clients

**Files:**
- Create: `apps-script/Tesla.gs`
- Create: `apps-script/Rates.gs`
- Create: `test/fake-apps-script.mjs`
- Create: `test/apps-script-clients.test.mjs`

**Interfaces:**
- Consumes: `Logic.gs`, `SheetRepo.gs`, `PropertiesService`, `UrlFetchApp`.
- Produces:
  - `refreshAccessToken_()` → access token; caches it in `TESLA_ACCESS_TOKEN` / `TESLA_TOKEN_EXPIRY`; rotates `TESLA_REFRESH_TOKEN`.
  - `teslaGet_(path, params)` → JSON.
  - `discoverSiteId_()` → energy site ID; caches `TESLA_SITE_ID`.
  - `fetchSessions_(siteId, startIso, endIso)` → array of `{ teslaKey, startAt, endAt, durationSec, kWh, targetId, din }`.
  - `selectRateRow_(month, rates)` → exact or latest earlier rate row.
  - `syncTesla_()` → `{ matched, unassigned, fetched, skipped }`.
  - `refreshRates_()` → `{ updated, reader, month, fuelAdjustment }`.

- [ ] **Step 1: Create the shared fake Apps Script environment**

Create `test/fake-apps-script.mjs`:

```js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sources = ['Logic.gs', 'SheetRepo.gs', 'Tesla.gs', 'Rates.gs'].map((name) => (
  readFileSync(new URL(`../apps-script/${name}`, import.meta.url), 'utf8')
));

function makeSheet(initial) {
  const data = (initial || []).map((row) => [...row]);
  return {
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((max, row) => Math.max(max, row.length), 0),
    getDataRange: () => ({ getValues: () => data.map((row) => [...row]) }),
    getRange(row, col, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r += 1) {
            const line = [];
            for (let c = 0; c < numCols; c += 1) {
              const source = data[row - 1 + r] || [];
              line.push(source[col - 1 + c] ?? '');
            }
            out.push(line);
          }
          return out;
        },
        setValues(next) {
          for (let r = 0; r < numRows; r += 1) {
            const target = row - 1 + r;
            while (data.length <= target) data.push([]);
            const line = data[target];
            for (let c = 0; c < numCols; c += 1) line[col - 1 + c] = next[r][c];
          }
        },
      };
    },
    appendRow(next) { data.push([...next]); },
    deleteRow(row) { data.splice(row - 1, 1); },
    setFrozenRows() {},
  };
}

export function createAppsScriptEnv({ sheets = {}, props = {}, fetch: fetchHandler } = {}) {
  const sheetMap = new Map();
  for (const [name, values] of Object.entries(sheets)) {
    sheetMap.set(name, makeSheet(values));
  }
  const spreadsheet = {
    getSheetByName: (name) => sheetMap.get(name) || null,
    insertSheet: (name) => {
      const sheet = makeSheet([]);
      sheetMap.set(name, sheet);
      return sheet;
    },
  };
  const context = vm.createContext({
    SpreadsheetApp: { openById: () => spreadsheet },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null),
        setProperty: (key, value) => { props[key] = String(value); },
        deleteProperty: (key) => { delete props[key]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    UrlFetchApp: {
      fetch: fetchHandler || (() => { throw new Error('Unexpected UrlFetchApp.fetch'); }),
    },
    ContentService: {
      createTextOutput: (text) => ({
        text,
        mimeType: '',
        setMimeType(type) { this.mimeType = type; return this; },
        getContent() { return this.text; },
      }),
    },
    MimeType: { JSON: 'application/json' },
    console: { log() {}, error() {} },
    SHEET_ID: 'fake-sheet',
  });
  for (const source of sources) vm.runInContext(source, context);
  return {
    context,
    props,
    spreadsheet,
    call: (name, ...args) => context[name](...args),
    values: (name) => {
      const sheet = sheetMap.get(name);
      return sheet ? sheet.getDataRange().getValues() : [];
    },
    run(source) {
      vm.runInContext(source, context);
      context.SHEET_ID = 'fake-sheet';
    },
  };
}
```

- [ ] **Step 2: Write the failing client tests**

Create `test/apps-script-clients.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';
const READER = 'https://r.jina.ai/';

const fuelPage = `
燃料調整費
2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
2026年11月1日起，燃料調整費為每度電47.4港仙。
`;
const tariffPage = `
電動車住宅分時段用電價目
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
燃料調整費每月浮動。
`;

test('refreshAccessToken_ posts the refresh grant, caches the access token, and rotates the refresh token', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'client-id',
      TESLA_CLIENT_SECRET: 'client-secret',
      TESLA_REFRESH_TOKEN: 'refresh-1',
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      return response(200, JSON.stringify({
        access_token: 'access-1',
        expires_in: 3600,
        refresh_token: 'refresh-2',
      }));
    },
  });
  assert.equal(env.call('refreshAccessToken_'), 'access-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(calls[0].options.method, 'post');
  assert.deepEqual(plain(calls[0].options.payload), {
    grant_type: 'refresh_token',
    client_id: 'client-id',
    client_secret: 'client-secret',
    refresh_token: 'refresh-1',
  });
  assert.equal(env.props.TESLA_ACCESS_TOKEN, 'access-1');
  assert.equal(env.props.TESLA_REFRESH_TOKEN, 'refresh-2');
  assert.ok(Number(env.props.TESLA_TOKEN_EXPIRY) > Date.now());
});

test('refreshAccessToken_ reuses a cached token that is not near expiry', () => {
  const env = createAppsScriptEnv({
    props: {
      TESLA_ACCESS_TOKEN: 'cached-token',
      TESLA_TOKEN_EXPIRY: String(Date.now() + 3600000),
    },
    fetch: () => { throw new Error('should not fetch'); },
  });
  assert.equal(env.call('refreshAccessToken_'), 'cached-token');
});

test('refreshAccessToken_ reports token endpoint failures without leaking the body', () => {
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
    },
    fetch: () => response(400, JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token expired' })),
  });
  assert.throws(() => env.call('refreshAccessToken_'), /Tesla token refresh failed \(400\)/);
  assert.throws(() => env.call('refreshAccessToken_'), (error) => !error.message.includes('refresh token expired'));
});

test('fetchSessions_ calls telemetry_history with Hong Kong time and maps the session', () => {
  const calls = [];
  const env = createAppsScriptEnv({
    props: {
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
      TESLA_SITE_ID: 'site-1',
    },
    fetch: (url, options) => {
      calls.push({ url, options });
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' }));
      }
      if (url.startsWith('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              start_date_time: '2026-11-14T05:00:00.000Z',
              duration: 7200,
              charge_energy_added: 20,
              target_id: 'target-1',
              din: 'din-1',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const sessions = plain(env.call(
    'fetchSessions_',
    'site-1',
    '2026-11-01T00:00:00.000Z',
    '2026-11-14T12:00:00.000Z',
  ));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(sessions[0].endAt, '2026-11-14T07:00:00.000Z');
  assert.equal(sessions[0].durationSec, 7200);
  assert.equal(sessions[0].kWh, 20);
  assert.equal(sessions[0].teslaKey, `din-1:${Math.floor(Date.parse('2026-11-14T05:00:00.000Z') / 1000)}`);
  const telemetryCall = calls.find((call) => call.url.includes('/telemetry_history'));
  assert.match(telemetryCall.url, /kind=charge/);
  assert.match(telemetryCall.url, /time_zone=Asia%2FHong_Kong/);
  assert.equal(telemetryCall.options.headers.Authorization, 'Bearer access-1');
});

test('refreshRates_ falls back to the reader on 403 or parse failure and writes the yearly table', () => {
  const env = createAppsScriptEnv({
    fetch: (url) => {
      if (url === FUEL_URL) return response(403, '');
      if (url === READER + FUEL_URL) return response(200, fuelPage);
      if (url === TARIFF_URL) return response(200, 'not the tariff page');
      if (url === READER + TARIFF_URL) return response(200, tariffPage);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = plain(env.call('refreshRates_'));
  assert.equal(result.updated, 11);
  assert.equal(result.reader, true);
  assert.equal(result.month, '2026-11');
  assert.equal(result.fuelAdjustment, 47.4);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates.length, 11);
  const november = rates.find((rate) => rate.month === '2026-11');
  assert.equal(november.basicOffPeak, 94.5);
  assert.equal(november.basicPeak, 137.5);
  assert.equal(november.fuelAdjustment, 47.4);
  assert.equal(november.rebate, 0);
  assert.equal(november.manualOverride, false);
  assert.equal(november.sourceUrl, `${FUEL_URL},${TARIFF_URL}`);
});

test('refreshRates_ leaves existing rows untouched when both sources fail to parse', () => {
  const env = createAppsScriptEnv({
    sheets: {
      Rates: [
        ['month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate', 'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride'],
        ['2026-11', '1', '2', '3', '0', '16:00', '23:00', 'old', 'old', 'FALSE'],
      ],
    },
    fetch: () => response(200, 'still not a rate page'),
  });
  assert.throws(() => env.call('refreshRates_'), /CLP page parse failed/);
  const rates = plain(env.call('readRates_'));
  assert.equal(rates[0].basicOffPeak, 1);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `apps-script/Tesla.gs` and `apps-script/Rates.gs` do not exist.

- [ ] **Step 4: Implement `apps-script/Tesla.gs`**

```javascript
var TESLA_TOKEN_URL_ = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
var DEFAULT_TESLA_BASE_URL_ = 'https://fleet-api.prd.na.vn.cloud.tesla.com';
var TESLA_MAX_LOOKBACK_DAYS_ = 90;

function scriptProperty_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function refreshAccessToken_() {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('TESLA_ACCESS_TOKEN');
  var expiry = Number(props.getProperty('TESLA_TOKEN_EXPIRY') || 0);
  if (cached && expiry > Date.now() + 5 * 60 * 1000) return cached;
  var response = UrlFetchApp.fetch(TESLA_TOKEN_URL_, {
    method: 'post',
    payload: {
      grant_type: 'refresh_token',
      client_id: props.getProperty('TESLA_CLIENT_ID'),
      client_secret: props.getProperty('TESLA_CLIENT_SECRET'),
      refresh_token: props.getProperty('TESLA_REFRESH_TOKEN'),
    },
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    var error = '';
    try { error = JSON.parse(body).error || ''; } catch (ignored) { error = ''; }
    throw new Error('Tesla token refresh failed (' + status + ')' + (error ? ': ' + error : ''));
  }
  var data = JSON.parse(body);
  if (!data.access_token) throw new Error('Tesla token refresh returned no access_token');
  props.setProperty('TESLA_ACCESS_TOKEN', data.access_token);
  props.setProperty('TESLA_TOKEN_EXPIRY', String(Date.now() + (Number(data.expires_in) || 3600) * 1000));
  if (data.refresh_token) props.setProperty('TESLA_REFRESH_TOKEN', data.refresh_token);
  return data.access_token;
}

function teslaGet_(path, params) {
  var base = scriptProperty_('TESLA_BASE_URL') || DEFAULT_TESLA_BASE_URL_;
  var url = base.replace(/\/$/, '') + path;
  var query = [];
  for (var key in params || {}) {
    if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null) {
      query.push(encodeURIComponent(key) + '=' + encodeURIComponent(params[key]));
    }
  }
  if (query.length) url += '?' + query.join('&');
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + refreshAccessToken_() },
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Tesla API ' + status + ' for ' + path);
  }
  return JSON.parse(response.getContentText());
}

function discoverSiteId_() {
  var props = PropertiesService.getScriptProperties();
  var configured = props.getProperty('TESLA_SITE_ID');
  if (configured) return configured;
  var payload = teslaGet_('/api/1/products', {});
  var products = payload.response || [];
  for (var i = 0; i < products.length; i += 1) {
    var product = products[i];
    if (product.energy_site_id) {
      props.setProperty('TESLA_SITE_ID', String(product.energy_site_id));
      return String(product.energy_site_id);
    }
  }
  throw new Error('No Tesla Wall Connector energy site found');
}

function fetchSessions_(siteId, startIso, endIso) {
  var payload = teslaGet_(
    '/api/1/energy_sites/' + encodeURIComponent(siteId) + '/telemetry_history',
    {
      kind: 'charge',
      start_date: startIso,
      end_date: endIso,
      time_zone: 'Asia/Hong_Kong',
    },
  );
  var data = payload.response || {};
  var rows = data.telemetry_history || data.data || [];
  var sessions = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var start = row.start_date_time || row.start_date || row.start_time;
    if (!validIso_(start)) continue;
    var startAt = new Date(start).toISOString();
    var duration = Number(row.duration != null ? row.duration : row.duration_s);
    if (!isFinite(duration) || duration <= 0) continue;
    var energy = Number(row.charge_energy_added != null ? row.charge_energy_added : row.energy_added);
    if (!isFinite(energy)) continue;
    var targetId = String(row.target_id || '');
    var din = String(row.din || '');
    var endAt = validIso_(row.end_date_time)
      ? new Date(row.end_date_time).toISOString()
      : new Date(Date.parse(startAt) + duration * 1000).toISOString();
    sessions.push({
      teslaKey: (din || targetId) + ':' + Math.floor(Date.parse(startAt) / 1000),
      startAt: startAt,
      endAt: endAt,
      durationSec: duration,
      kWh: energy,
      targetId: targetId,
      din: din,
    });
  }
  return sessions;
}

function selectRateRow_(month, rates) {
  var best = null;
  for (var i = 0; i < rates.length; i += 1) {
    var rate = rates[i];
    if (rate.month === month) return rate;
    if (rate.month < month && (!best || rate.month > best.month)) best = rate;
  }
  return best;
}

function syncTesla_() {
  var props = PropertiesService.getScriptProperties();
  var records = readLog_();
  var ignored = new Set(readIgnored_());
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.kWh === null && !record.teslaKey;
  });
  var cursor = props.getProperty('SYNC_CURSOR');
  var syncFrom = props.getProperty('SYNC_FROM');
  var now = new Date();
  var lookback = new Date(now.getTime() - TESLA_MAX_LOOKBACK_DAYS_ * 86400000);
  var windowMs = Number(props.getProperty('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;

  // A driver can record a start after an earlier sync already imported the
  // Tesla session as unassigned. Reconcile those rows without another fetch.
  var reconciled = 0;
  var unassignedRows = records.filter(function (record) {
    return record.car === 'unassigned' && record.teslaKey && record.kWh != null;
  });
  for (var u = 0; u < unassignedRows.length; u += 1) {
    var candidate = closestManualCandidate_(
      unassignedRows[u].teslaStartAt || unassignedRows[u].startAt,
      manualRows,
      windowMs,
    );
    if (!candidate) continue;
    updateLog_(unassignedRows[u].id, {
      car: candidate.car,
      startAt: candidate.startAt,
      date: candidate.date,
      time: candidate.time,
      source: 'tesla+manual',
    });
    deleteLog_(candidate.id);
    var candidateIndex = manualRows.indexOf(candidate);
    if (candidateIndex >= 0) manualRows.splice(candidateIndex, 1);
    reconciled += 1;
  }

  var lower;
  if (cursor && validIso_(cursor)) {
    lower = new Date(Math.max(Date.parse(cursor) - 2 * 86400000, lookback.getTime()));
  } else if (syncFrom && validIso_(syncFrom)) {
    lower = new Date(Math.max(Date.parse(syncFrom), lookback.getTime()));
  } else if (manualRows.length) {
    var earliest = manualRows.reduce(function (min, row) {
      return Math.min(min, Date.parse(row.startAt));
    }, Infinity);
    lower = new Date(Math.max(earliest - 2 * 86400000, lookback.getTime()));
  } else {
    return { matched: reconciled, unassigned: 0, fetched: 0, skipped: true };
  }

  var siteId = discoverSiteId_();
  var sessions = fetchSessions_(siteId, lower.toISOString(), now.toISOString());
  var rates = readRates_();
  var matched = reconciled;
  var unassigned = 0;
  var highest = cursor && validIso_(cursor) ? Date.parse(cursor) : 0;

  for (var i = 0; i < sessions.length; i += 1) {
    var session = sessions[i];
    highest = Math.max(highest, Date.parse(session.startAt));
    if (ignored.has(session.teslaKey)) continue;
    var duplicate = false;
    for (var d = 0; d < records.length; d += 1) {
      if (records[d].teslaKey === session.teslaKey) { duplicate = true; break; }
    }
    if (duplicate) continue;
    var rate = selectRateRow_(hkMonth_(session.startAt), rates);
    var peakStart = rate ? rate.peakStart : DEFAULT_PEAK_START_;
    var peakEnd = rate ? rate.peakEnd : DEFAULT_PEAK_END_;
    var split = splitPeakKwh_(session.startAt, session.durationSec, session.kWh, peakStart, peakEnd);
    var manual = closestManualCandidate_(session.startAt, manualRows, windowMs);
    if (manual) {
      updateLog_(manual.id, {
        car: manual.car,
        startAt: manual.startAt,
        date: manual.date,
        time: manual.time,
        kWh: session.kWh,
        durationSec: session.durationSec,
        teslaStartAt: session.startAt,
        teslaEndAt: session.endAt,
        peakKWh: split.peakKWh,
        offPeakKWh: split.offPeakKWh,
        teslaKey: session.teslaKey,
        source: 'tesla+manual',
      });
      var index = manualRows.indexOf(manual);
      if (index >= 0) manualRows.splice(index, 1);
      matched += 1;
    } else {
      appendLog_({
        id: 'tesla-' + Math.floor(Date.parse(session.startAt) / 1000),
        car: 'unassigned',
        startAt: session.startAt,
        date: hkDateString_(session.startAt),
        time: hkTimeString_(session.startAt),
        kWh: session.kWh,
        durationSec: session.durationSec,
        teslaStartAt: session.startAt,
        teslaEndAt: session.endAt,
        peakKWh: split.peakKWh,
        offPeakKWh: split.offPeakKWh,
        teslaKey: session.teslaKey,
        source: 'tesla',
      });
      unassigned += 1;
    }
  }

  props.setProperty(
    'SYNC_CURSOR',
    new Date(Math.max(highest, lookback.getTime())).toISOString(),
  );
  return { matched: matched, unassigned: unassigned, fetched: sessions.length, skipped: false };
}
```

- [ ] **Step 5: Implement `apps-script/Rates.gs`**

```javascript
var CLP_FUEL_URL_ = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
var CLP_TARIFF_URL_ = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';

function fetchText_(url) {
  var response = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) return '';
  var text = response.getContentText();
  return text && text.trim() ? text : '';
}

function fetchWithReader_(url, parser) {
  var direct = fetchText_(url);
  if (direct) {
    var directParsed = parser(direct);
    if (directParsed) return { parsed: directParsed, reader: false };
  }
  var reader = fetchText_('https://r.jina.ai/' + url);
  if (reader) {
    var readerParsed = parser(reader);
    if (readerParsed) return { parsed: readerParsed, reader: true };
  }
  throw new Error('CLP page parse failed');
}

function refreshRates_() {
  var fuel = fetchWithReader_(CLP_FUEL_URL_, function (text) {
    var parsed = parseFuelAdjustmentPage_(text);
    return parsed.current ? parsed : null;
  });
  var tariff = fetchWithReader_(CLP_TARIFF_URL_, parseTariffPage_);
  var fetchedAt = new Date().toISOString();
  var rows = [];
  for (var i = 0; i < fuel.parsed.rows.length; i += 1) {
    var item = fuel.parsed.rows[i];
    rows.push({
      month: item.month,
      basicOffPeak: tariff.parsed.basicOffPeak,
      basicPeak: tariff.parsed.basicPeak,
      fuelAdjustment: item.fuelAdjustment,
      rebate: 0,
      peakStart: tariff.parsed.peakStart,
      peakEnd: tariff.parsed.peakEnd,
      sourceUrl: CLP_FUEL_URL_ + ',' + CLP_TARIFF_URL_,
      fetchedAt: fetchedAt,
      manualOverride: false,
    });
  }
  var updated = upsertRates_(rows);
  return {
    updated: updated,
    reader: fuel.reader || tariff.reader,
    month: fuel.parsed.current.month,
    fuelAdjustment: fuel.parsed.current.fuelAdjustment,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`

Expected: all green. If the `syncTesla_`/`refreshRates_` behavior is wrong, fix the code until these tests pass.

- [ ] **Step 7: Syntax-check the Apps Script files**

```bash
cp apps-script/Tesla.gs /tmp/ev-tesla.js
cp apps-script/Rates.gs /tmp/ev-rates.js
node --check /tmp/ev-tesla.js
node --check /tmp/ev-rates.js
```

Expected: exit 0 for both.

- [ ] **Step 8: Commit**

```bash
git add apps-script/Tesla.gs apps-script/Rates.gs test/fake-apps-script.mjs test/apps-script-clients.test.mjs
git commit -m "feat: add Tesla sync and CLP rate clients"
```

---

### Task 9: Apps Script API and integration tests

**Files:**
- Replace: `apps-script/Code.gs`
- Create: `test/apps-script-api.test.mjs`

**Interfaces:**
- Consumes: `Logic.gs`, `SheetRepo.gs`, `Tesla.gs`, `Rates.gs`.
- Produces:
  - `doGet(e)` with `?car=<id>` and `?owner=<key>`
  - `doPost(e)` with actions `append`, `delete`, `sync`, `assign`, `ignore`, `refreshRates`
  - JSON envelope `{ ok: true, ... }` or `{ ok: false, error }`

- [ ] **Step 1: Write the failing API tests**

Create `test/apps-script-api.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

const codeSource = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ getResponseCode: () => status, getContentText: () => body });
const TOKEN_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';
const FUEL_URL = 'https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment';
const TARIFF_URL = 'https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff';

const LOG_HEADER = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
];
const CARS_HEADER = ['id', 'name', 'active', 'createdAt'];
const RATES_HEADER = [
  'month', 'basicOffPeak', 'basicPeak', 'fuelAdjustment', 'rebate',
  'peakStart', 'peakEnd', 'sourceUrl', 'fetchedAt', 'manualOverride',
];
const RATE_ROW = ['2026-11', 94.5, 137.5, 47.4, 0, '16:00', '23:00', 'clp', '2026-11-14T00:00:00.000Z', 'FALSE'];
const row = (overrides = {}) => [
  'rec-1', '2026-11-14T05:00:00.000Z', '2026-11-14', '13:00', 'model3',
  20, 7200, '2026-11-14T05:00:00.000Z', '2026-11-14T07:00:00.000Z',
  10, 10, 'din:rec-1', 'tesla+manual',
].map((value, index) => (overrides[index] !== undefined ? overrides[index] : value));

function setup({ sheets = {}, props = {}, fetch } = {}) {
  const env = createAppsScriptEnv({
    sheets,
    props: {
      OWNER_KEY: 'owner-secret',
      MATCH_WINDOW_MINUTES: '30',
      TESLA_SITE_ID: 'site-1',
      TESLA_CLIENT_ID: 'id',
      TESLA_CLIENT_SECRET: 'secret',
      TESLA_REFRESH_TOKEN: 'refresh',
      ...props,
    },
    fetch,
  });
  env.context.ContentService.MimeType = { JSON: 'application/json' };
  env.run(codeSource);
  return env;
}

const send = (env, body) => JSON.parse(env.call('doPost', {
  postData: { contents: JSON.stringify(body) },
}).getContent());
const receive = (env, parameter) => JSON.parse(env.call('doGet', { parameter }).getContent());

test('doGet returns only the requested car records and the owner returns all records', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row(),
        row({ 0: 'leaf-1', 4: 'leaf', 11: 'din:leaf-1' }),
        ['old-1', '2026-11-01T00:00:00.000Z', '2026-11-01', '08:00', '', '', '', '', '', '', '', '', 'legacy'],
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  const family = receive(env, { car: 'model3' });
  assert.equal(family.ok, true);
  assert.equal(family.car.name, 'Model 3');
  assert.equal(family.records.length, 1);
  assert.equal(family.records[0].id, 'rec-1');
  assert.equal(family.rates.length, 1);
  assert.ok(family.serverTime);

  const owner = receive(env, { owner: 'owner-secret' });
  assert.equal(owner.ok, true);
  assert.equal(owner.cars.length, 2);
  assert.equal(owner.records.length, 3);
  assert.equal(receive(env, { car: 'missing' }).ok, false);
  assert.equal(receive(env, { owner: 'wrong' }).ok, false);
});

test('append is idempotent and rejects a Hong Kong date/time mismatch', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  const body = {
    id: 'new-1',
    car: 'model3',
    startAt: '2026-11-14T05:00:00.000Z',
    date: '2026-11-14',
    time: '13:00',
  };
  const first = send(env, body);
  assert.equal(first.ok, true);
  assert.equal(first.record.id, 'new-1');
  const second = send(env, body);
  assert.equal(second.ok, true);
  assert.equal(plain(env.call('readLog_')).filter((record) => record.id === 'new-1').length, 1);
  const mismatch = send(env, { ...body, id: 'new-2', time: '00:00' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /Date\/time mismatch/);
});

test('family delete is scoped to its car and records the Tesla key as ignored', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row(),
        row({ 0: 'leaf-1', 4: 'leaf', 11: 'din:leaf-1' }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const wrong = send(env, { action: 'delete', id: 'leaf-1', car: 'model3' });
  assert.equal(wrong.ok, false);
  const result = send(env, { action: 'delete', id: 'rec-1', car: 'model3' });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, true);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:rec-1']);
  assert.equal(plain(env.call('readLog_')).some((record) => record.id === 'rec-1'), false);
});

test('owner assign merges a nearby pending manual row', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'unassigned-1', 4: 'unassigned', 11: 'din:a',
          7: '2026-11-14T05:05:00.000Z', 8: '2026-11-14T07:05:00.000Z',
        }),
        row({
          0: 'manual-1', 4: 'leaf', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [
        CARS_HEADER,
        ['model3', 'Model 3', 'TRUE', 'x'],
        ['leaf', 'Leaf', 'TRUE', 'x'],
      ],
    },
  });
  const result = send(env, {
    action: 'assign',
    ownerKey: 'owner-secret',
    id: 'unassigned-1',
    car: 'leaf',
  });
  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'unassigned-1');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(records.some((record) => record.id === 'manual-1'), false);
});

test('owner ignore requires a Tesla key and removes the record', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:a' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
    },
  });
  const result = send(env, { action: 'ignore', ownerKey: 'owner-secret', id: 'unassigned-1' });
  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
  assert.deepEqual(plain(env.call('readIgnored_')), ['din:a']);
  assert.equal(plain(env.call('readLog_')).length, 0);
});

test('sync matches a manual row and updates the cursor', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'manual-1', 4: 'model3', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
    fetch: (url) => {
      if (url === TOKEN_URL) {
        return response(200, JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' }));
      }
      if (url.includes('/api/1/energy_sites/site-1/telemetry_history')) {
        return response(200, JSON.stringify({
          response: {
            telemetry_history: [{
              start_date_time: '2026-11-14T05:05:00.000Z',
              duration: 7200,
              charge_energy_added: 20,
              target_id: 'target-1',
              din: 'din:sync',
            }],
          },
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const result = send(env, { action: 'sync', ownerKey: 'owner-secret' });
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(result.unassigned, 0);
  assert.equal(result.skipped, false);
  const target = plain(env.call('readLog_')).find((record) => record.id === 'manual-1');
  assert.equal(target.kWh, 20);
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.teslaKey, `din:sync:${Math.floor(Date.parse('2026-11-14T05:05:00.000Z') / 1000)}`);
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(target.teslaStartAt, '2026-11-14T05:05:00.000Z');
  assert.ok(env.props.SYNC_CURSOR);
});

test('sync reconciles an existing unassigned session with a new manual start without fetching', () => {
  const env = setup({
    sheets: {
      Log: [
        LOG_HEADER,
        row({
          0: 'unassigned-old', 4: 'unassigned', 11: 'din:old', 12: 'tesla',
          7: '2026-11-14T05:05:00.000Z', 8: '2026-11-14T07:05:00.000Z',
        }),
        row({
          0: 'manual-new', 4: 'leaf', 5: '', 6: '', 7: '', 8: '',
          9: '', 10: '', 11: '', 12: 'manual',
        }),
      ],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x'], ['leaf', 'Leaf', 'TRUE', 'x']],
    },
  });
  const result = send(env, { action: 'sync', ownerKey: 'owner-secret' });
  assert.equal(result.ok, true);
  assert.equal(result.matched, 1);
  assert.equal(result.fetched, 0);
  assert.equal(result.skipped, true);
  const records = plain(env.call('readLog_'));
  const target = records.find((record) => record.id === 'unassigned-old');
  assert.equal(target.car, 'leaf');
  assert.equal(target.source, 'tesla+manual');
  assert.equal(target.startAt, '2026-11-14T05:00:00.000Z');
  assert.equal(records.some((record) => record.id === 'manual-new'), false);
});

test('owner refreshRates updates the Rates tab and is owner-only', () => {
  const fuelPage = `
2026年每月燃料調整費
2026年
1月
2月
3月
4月
5月
6月
7月
8月
9月
10月
11月
燃料調整費
(每度電港仙)
39.4
39.4
39.2
39.8
40.4
42.6
43.5
45.0*
45.1*
46.2*
47.4
2026年11月1日起，燃料調整費為每度電47.4港仙。
`;
  const tariffPage = `
非高峰用電時間
（每日晚上十一時至翌日下午四時）
94.5
高峰用電時間
（每日下午四時至晚上十一時）
137.5
`;
  const env = setup({
    sheets: { Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']] },
    fetch: (url) => {
      if (url === FUEL_URL) return response(200, fuelPage);
      if (url === TARIFF_URL) return response(200, tariffPage);
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  assert.equal(send(env, { action: 'refreshRates', ownerKey: 'wrong' }).ok, false);
  const result = send(env, { action: 'refreshRates', ownerKey: 'owner-secret' });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 11);
  assert.equal(plain(env.call('readRates_')).length, 11);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`

Expected: FAIL because `Code.gs` still contains the legacy API.

- [ ] **Step 3: Replace `apps-script/Code.gs`**

```javascript
var SHEET_ID = 'PASTE_SHEET_ID_HERE';
var MAX_BODY_BYTES_ = 16384;

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.owner) return json_(ownerPayload_(params.owner));
    if (params.car) return json_(familyPayload_(params.car));
    throw new Error('Missing car or owner parameter');
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function doPost(e) {
  try {
    var raw = e && e.postData ? e.postData.contents : '';
    if (!raw || raw.length > MAX_BODY_BYTES_) throw new Error('Request body too large');
    var data = JSON.parse(raw);
    var action = String(data.action || 'append');
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var result;
      if (action === 'append') result = appendAction_(data);
      else if (action === 'delete') result = deleteAction_(data);
      else if (action === 'sync') result = syncAction_(data);
      else if (action === 'assign') result = assignAction_(data);
      else if (action === 'ignore') result = ignoreAction_(data);
      else if (action === 'refreshRates') result = ratesAction_(data);
      else throw new Error('Unknown action');
      return json_(merge_({ ok: true }, result));
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return json_({ ok: false, error: String(error.message || error) });
  }
}

function merge_(base, extra) {
  var out = {};
  for (var key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
  for (var other in extra) if (Object.prototype.hasOwnProperty.call(extra, other)) out[other] = extra[other];
  return out;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function assertOwner_(ownerKey) {
  var expected = scriptProperty_('OWNER_KEY');
  if (!expected) throw new Error('Owner key is not configured');
  if (!ownerKey || String(ownerKey) !== String(expected)) throw new Error('Invalid owner key');
}

function findCar_(carId) {
  if (!validCarId_(carId)) return null;
  var cars = readCars_();
  for (var i = 0; i < cars.length; i += 1) if (cars[i].id === carId) return cars[i];
  return null;
}

function familyPayload_(carId) {
  var car = findCar_(carId);
  if (!car) throw new Error('Unknown car');
  if (!car.active) throw new Error('Car is inactive');
  return {
    ok: true,
    car: car,
    records: readLog_().filter(function (record) { return record.car === car.id; }),
    rates: readRates_(),
    serverTime: new Date().toISOString(),
  };
}

function ownerPayload_(ownerKey) {
  assertOwner_(ownerKey);
  return {
    ok: true,
    cars: readCars_(),
    records: readLog_(),
    rates: readRates_(),
    serverTime: new Date().toISOString(),
  };
}

function appendAction_(data) {
  if (!validCarId_(data.car)) throw new Error('Invalid car');
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car');
  if (!data.id || !/^[A-Za-z0-9-]{1,64}$/.test(String(data.id))) throw new Error('Invalid id');
  if (!validIso_(data.startAt)) throw new Error('Invalid startAt');
  if (data.date !== hkDateString_(data.startAt) || data.time !== hkTimeString_(data.startAt)) {
    throw new Error('Date/time mismatch');
  }
  var records = readLog_();
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) return { record: records[i] };
  }
  var record = {
    id: String(data.id),
    car: car.id,
    startAt: new Date(data.startAt).toISOString(),
    date: hkDateString_(data.startAt),
    time: hkTimeString_(data.startAt),
    kWh: null,
    durationSec: null,
    teslaStartAt: null,
    teslaEndAt: null,
    peakKWh: null,
    offPeakKWh: null,
    teslaKey: null,
    source: 'manual',
  };
  appendLog_(record);
  return { record: record };
}

function deleteAction_(data) {
  if (!data.id) throw new Error('Invalid id');
  if (data.ownerKey) {
    assertOwner_(data.ownerKey);
  } else if (data.car) {
    var car = findCar_(data.car);
    if (!car) throw new Error('Unknown car');
  } else {
    throw new Error('Missing authorization');
  }
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) return { deleted: false };
  if (!data.ownerKey && target.car !== data.car) throw new Error('Record does not belong to this car');
  if (target.teslaKey) addIgnored_(target.teslaKey, 'deleted');
  deleteLog_(target.id);
  return { deleted: true };
}

function syncAction_(data) {
  if (data.ownerKey) {
    assertOwner_(data.ownerKey);
  } else if (data.car) {
    var car = findCar_(data.car);
    if (!car) throw new Error('Unknown car');
  } else {
    throw new Error('Missing authorization');
  }
  return syncTesla_();
}

function assignAction_(data) {
  assertOwner_(data.ownerKey);
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) throw new Error('Unknown record');
  if (target.car !== 'unassigned') throw new Error('Only unassigned sessions can be assigned');
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car');
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  var windowMs = Number(scriptProperty_('MATCH_WINDOW_MINUTES') || 30) * 60 * 1000;
  var manualRows = records.filter(function (record) {
    return record.source === 'manual' && record.car === car.id && record.kWh === null && !record.teslaKey;
  });
  var manual = closestManualCandidate_(target.teslaStartAt || target.startAt, manualRows, windowMs);
  if (manual) {
    updateLog_(target.id, {
      car: car.id,
      startAt: manual.startAt,
      date: manual.date,
      time: manual.time,
      source: 'tesla+manual',
    });
    deleteLog_(manual.id);
    return { assigned: true, merged: true };
  }
  updateLog_(target.id, { car: car.id, source: 'tesla' });
  return { assigned: true, merged: false };
}

function ignoreAction_(data) {
  assertOwner_(data.ownerKey);
  var records = readLog_();
  var target = null;
  for (var i = 0; i < records.length; i += 1) {
    if (records[i].id === String(data.id)) target = records[i];
  }
  if (!target) throw new Error('Unknown record');
  if (!target.teslaKey) throw new Error('Record has no Tesla key');
  addIgnored_(target.teslaKey, 'owner ignored');
  deleteLog_(target.id);
  return { ignored: true };
}

function ratesAction_(data) {
  assertOwner_(data.ownerKey);
  return refreshRates_();
}
```

- [ ] **Step 4: Run the API tests**

Run: `npm test`

Expected: all green. If a failure exposes a mismatch, fix the implementation rather than weakening an assertion.

- [ ] **Step 5: Syntax-check the new Code.gs**

```bash
cp apps-script/Code.gs /tmp/ev-code.js
node --check /tmp/ev-code.js
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps-script/Code.gs test/apps-script-api.test.mjs
git commit -m "feat: add Tesla billing API and owner actions"
```

---

### Task 10: README and setup documentation

**Files:**
- Replace: `README.md`
- Verify: `docs/screenshot-family.png`, `docs/screenshot-owner.png`

**Interfaces:**
- Consumes: the completed frontend, backend, and screenshots.
- Produces: a single setup document that a new owner can follow without reading the spec.

- [ ] **Step 1: Replace `README.md`**

```markdown
# EV Charge Log

Per-car EV charging log with on-demand Tesla Wall Connector sync and CLP peak/off-peak cost estimates. A static app on GitHub Pages; a Google Apps Script Web App owns the Sheet, Tesla OAuth, and CLP rate fetch.

Live app: https://<your-user>.github.io/ev-charge-log/

![Family view](docs/screenshot-family.png)

![Owner view](docs/screenshot-owner.png)

## How it works

- Each car has its own family URL: `https://<your-user>.github.io/ev-charge-log/?car=<car-id>`.
- A family member taps one button when charging starts. The start time is stored in the shared Google Sheet.
- The owner opens the owner URL (`?owner=<owner-key>`), presses `更新 Tesla`, and the Apps Script matches Tesla Wall Connector sessions to the manual start times.
- The owner assigns unmatched sessions to a car or ignores them. Each car gets an estimated cost from the CLP EV residential time-of-use tariff.
- The family view never receives Tesla credentials or the owner key. The owner view receives the owner key from its URL and keeps it in memory.

## Features

- One-tap start recording with a per-car URL; no login and no car picker.
- On-demand Tesla sync; no cron and no polling.
- Manual starts are matched to Tesla sessions within `MATCH_WINDOW_MINUTES` (default 30 minutes).
- Unmatched Tesla sessions appear as `unassigned` for the owner to assign or ignore.
- Peak/off-peak split is estimated by session duration; Tesla does not expose a per-minute power curve.
- Monthly kWh and estimated cost per car; peak/off-peak split; CLP rate month and fallback warning.
- Recent records with kWh, estimated cost, and real delete.
- Owner month totals, unassigned and pending lists, rate cards, and copyable family links.
- CSV export for family and owner, with UTF-8 BOM, CRLF, and RFC 4180 escaping.
- Offline-friendly family queue; pending starts retry automatically.
- Mobile-first layout for a 390x844 viewport.

## Data model

The Google Sheet has four tabs. The script creates missing tabs and appends missing `Log` columns to the right; existing rows are never moved or deleted.

### `Log`

`id`, `startAt`, `日期`, `時間`, `car`, `kWh`, `durationSec`, `teslaStartAt`, `teslaEndAt`, `peakKWh`, `offPeakKWh`, `teslaKey`, `source`.

- `source`: `manual`, `tesla`, `tesla+manual`, or `legacy`.
- Old rows without `car` are `legacy`; they are preserved and excluded from billing CSV.
- Tesla session keys are `<din>:<start-seconds>`.

### `Cars`

`id`, `name`, `active`, `createdAt`.

- `id` matches `[a-z0-9-]{1,32}`.
- `unassigned` is reserved.
- Family URLs use this `id`.

### `Rates`

`month`, `basicOffPeak`, `basicPeak`, `fuelAdjustment`, `rebate`, `peakStart`, `peakEnd`, `sourceUrl`, `fetchedAt`, `manualOverride`.

- Values are HK cents per kWh.
- `manualOverride=TRUE` rows are never overwritten by the rate refresh.
- `sourceUrl` is a comma-separated list of the CLP pages used.

### `Ignored`

`teslaKey`, `ignoredAt`, `reason`.

- Deleting or ignoring a Tesla-linked record adds its key here so it is not imported again.

## Billing

The app uses the CLP EV residential time-of-use tariff. In 2026 the peak window is 16:00–23:00 and non-peak is 23:00–16:00.

```text
offPeakRate = basicOffPeak + fuelAdjustment - rebate
peakRate    = basicPeak    + fuelAdjustment - rebate
cost        = offPeakKWh * offPeakRate / 100 + peakKWh * peakRate / 100
```

- Rates and times are HK cents/kWh and Asia/Hong_Kong.
- The split is proportional to session duration; it is an estimate.
- The 8-cent/kWh 2026 special fuel rebate is not inferred. Enter an eligible rebate in the `Rates` tab if it applies.
- The actual CLP bill remains authoritative. Per-bill reconciliation is a future enhancement.

## One-time setup

### 1. Google Sheet and Apps Script

1. Open the existing Google Sheet. Keep it private; the family view never links to it.
2. Open Extensions -> Apps Script.
3. Replace `Code.gs` and create `Logic.gs`, `SheetRepo.gs`, `Tesla.gs`, and `Rates.gs` from [`apps-script/`](apps-script/).
4. Set `SHEET_ID` at the top of `Code.gs` to the ID from the Sheet URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`).
5. Save the project.
6. Deploy -> Manage deployments -> Edit -> Version: New version. Execute as: Me. Who has access: Anyone. The existing deployment URL stays the same.

If your account or Workspace policy does not offer "Anyone" access, stop: this zero-login design requires it.

### 2. Script Properties

In Apps Script, Project Settings -> Script Properties:

| Property | Value |
| --- | --- |
| `TESLA_CLIENT_ID` | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla developer app client secret |
| `TESLA_REFRESH_TOKEN` | Refresh token from the local OAuth helper |
| `TESLA_BASE_URL` | `https://fleet-api.prd.na.vn.cloud.tesla.com` (optional; this is the default) |
| `TESLA_SITE_ID` | Observed Wall Connector energy site ID; optional, discovered automatically when omitted |
| `OWNER_KEY` | 48 lowercase hex characters; generate with `openssl rand -hex 24` |
| `MATCH_WINDOW_MINUTES` | `30` |
| `SYNC_FROM` | Leave unset; only set for an intentional backfill |
| `SYNC_CURSOR` | Internal; do not set manually |

Never put these values in `config.js`, the Sheet, git, or a family link.

### 3. Tesla OAuth

Tesla API access is read-only for energy data. The app uses the official Fleet API with scopes `openid offline_access energy_device_data`.

1. The Tesla developer app must have Allowed Origin exactly `https://<your-user>.github.io`. The local probe uses `http://localhost:8788/callback`.
2. On a machine with the repository and `tools/.env.tesla.local` (mode 600), run:

```bash
npm run auth:tesla
```

3. Authorize the app in the browser. The token is saved to `tools/.tesla-refresh-token.local` with mode 600.
4. Copy the token value into the `TESLA_REFRESH_TOKEN` Script Property. Do not print it, paste it into chat, or commit it.
5. Run one owner `更新 Tesla` and confirm the site is discovered.

Rotate the Tesla client secret after development and deployment are complete. Update `TESLA_CLIENT_SECRET` in Script Properties, then verify one sync.

### 4. Cars, rates, and the owner URL

1. Add one row per car to `Cars`: `id`, `name`, `active`, `createdAt`. Use `TRUE` for active.
2. Open the owner URL: `https://<your-user>.github.io/ev-charge-log/?owner=<OWNER_KEY>`.
3. Press `更新費率`; confirm the current month appears and the peak window is 16:00–23:00. If CLP changes the page format, enter or correct the row in `Rates` and set `manualOverride=TRUE`.
4. Copy each family link from the owner view and send it to that car's driver.
5. Keep the owner URL private. It is a capability, not a login.

### 5. Frontend

`config.js` contains only public values:

```js
window.APP_CONFIG = {
  API_URL: '<Apps Script Web app URL>',
  SHEET_URL: '<private Google Sheet URL>',
};
```

Deploy the static files to GitHub Pages. The owner key is never in `config.js`.

## Local development

```bash
npm test
PORT=8787 node test/dev-server.mjs
```

Open:

- Family: `http://127.0.0.1:8787/?car=model3`
- Owner: `http://127.0.0.1:8787/?owner=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

The mock server seeds one matched session, one unassigned session, and one pending manual session.

Node 24+ is required for the built-in test runner. There are no npm dependencies and no build step.

## API

`GET`:

- `?car=<id>` returns `{ ok, car, records, rates, serverTime }` for that car.
- `?owner=<key>` returns `{ ok, cars, records, rates, serverTime }` for the owner.

`POST` with a `text/plain` JSON body:

- `{ action: 'append', id, car, startAt, date, time }`
- `{ action: 'delete', id, car }` or `{ action: 'delete', id, ownerKey }`
- `{ action: 'sync', car }` or `{ action: 'sync', ownerKey }`
- `{ action: 'assign', ownerKey, id, car }`
- `{ action: 'ignore', ownerKey, id }`
- `{ action: 'refreshRates', ownerKey }`

The response envelope is `{ ok: true, ... }` or `{ ok: false, error }`. Apps Script returns HTTP 200 for API errors; the client checks `ok`.

## Security

- No accounts and no secrets in the frontend. The Apps Script URL and owner key are capability URLs.
- Tesla credentials live only in Script Properties.
- The Sheet stays private. The family view does not link to it.
- Owner actions require `OWNER_KEY`; family actions require a valid car ID.
- The owner key is kept in memory from the URL; it is not written to localStorage, logs, CSV, or family links.
- `index.html` uses `<meta name="referrer" content="no-referrer">`; owner external links use `rel="noreferrer"`.
- A leaked owner key allows owner actions. Rotate `OWNER_KEY` and resend the new owner URL; family URLs keep working.
- A leaked Tesla secret or refresh token must be rotated. Rotate the client secret in the Tesla developer portal and replace `TESLA_CLIENT_SECRET`; revoke the app grant if a refresh token leaked.

## Known limits

- Tesla cannot identify which car used the Wall Connector. Attribution is the per-car URL plus manual start.
- If a driver forgets to press start, the session becomes `unassigned`; the owner assigns it.
- Peak/off-peak is duration-proportional, not measured per minute.
- The vehicle may report DC-side energy; the AC meter can differ.
- CLP page scraping is fragile. Manual `Rates` rows are the fallback.
- There is no cron, auto-sync, outside-charger support, CCTV integration, or bill reconciliation yet.
- CSV is a snapshot; refresh it after new records.

## Tests

```bash
npm test
```

The suite covers frontend logic, API payloads, Apps Script logic, Sheet migration, Tesla token/session mapping, CLP parsers, owner actions, and the API envelope. Browser smoke tests are documented in the implementation plan.

## License

Personal project; no license file.
```

- [ ] **Step 2: Verify the screenshots and the docs**

Run:

```bash
ls -l docs/screenshot-family.png docs/screenshot-owner.png
grep -n "TESLA_CLIENT_SECRET\|TESLA_REFRESH_TOKEN\|OWNER_KEY" README.md
npm test
```

Expected: both screenshots exist; the README contains property names but no secret values; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/screenshot-family.png docs/screenshot-owner.png
git commit -m "docs: document Tesla billing setup"
```

---

### Task 11: Live Apps Script and Sheet setup

**This task changes shared external state. Do not start it until the user explicitly authorizes live Sheet, Apps Script, GitHub Pages, and Tesla property changes.** Ask once, list exactly what will change, and wait for the answer.

**Files:** none. This is a deployment task.

- [ ] **Step 1: Confirm authorization and backups**

Ask the user to confirm:

- The live Google Sheet may get new tabs and columns; existing rows are preserved.
- The live Apps Script project may be replaced and redeployed.
- The frontend may be pushed to GitHub Pages.
- The Tesla client secret will be rotated after live verification.

Before editing, copy the existing Sheet to a private backup (File -> Make a copy) and download the current Apps Script project if desired. Do not delete the existing deployment.

- [ ] **Step 2: Update Apps Script**

1. Open the existing Apps Script project.
2. Replace `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs); set `SHEET_ID` to the real Sheet ID.
3. Create `Logic.gs`, `SheetRepo.gs`, `Tesla.gs`, and `Rates.gs` from the repository files.
4. Save. Run `readLog_` once from the editor to confirm the header migration and permissions.
5. Deploy -> Manage deployments -> Edit -> Version: New version. Execute as: Me. Who has access: Anyone.

- [ ] **Step 3: Set Script Properties**

Set the properties from the README table. For the owner key:

```bash
openssl rand -hex 24
```

Save the output privately; set it as `OWNER_KEY`; build the owner URL. Do not echo the key into shell history in a shared terminal.

- [ ] **Step 4: Refresh the Tesla refresh token**

1. Run `npm run auth:tesla` locally; authorize.
2. Copy the value from `tools/.tesla-refresh-token.local` into `TESLA_REFRESH_TOKEN`.
3. Do not print it; do not commit it.
4. Run one owner `更新 Tesla`; confirm a successful response and a plausible count.
5. Verify the Apps Script Executions log shows no token or secret values.

- [ ] **Step 5: Add cars and rates**

1. In the live Sheet, add `Cars` rows for the Model 3 and each family car. Use the exact IDs that will appear in the family URLs.
2. Open the owner URL, press `更新費率`, and confirm the current month and FCA.
3. Confirm the `Rates` row shows source `CLP 官方`; if the reader fallback was used, the same row is valid.
4. Confirm the old `Log` rows are present and normalized as `legacy` in the owner view.

- [ ] **Step 6: Update the frontend and deploy**

1. Confirm `config.js` has the live `API_URL` and `SHEET_URL`.
2. Run `npm test`.
3. Push the feature branch, open a PR, wait for green CI, and ask the user to merge. The user performs the merge; do not merge it yourself.
4. After merge, confirm GitHub Pages serves the new `index.html`, `app.js`, `family.js`, `owner.js`, `logic.js`, `api.js`, and `ui.js`.
5. Open the owner URL and the Model 3 family URL in a private browser window.

- [ ] **Step 7: Verify the live API without writing test rows**

Use the owner GET once:

```bash
curl -sS 'https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?owner=<OWNER_KEY>' | head -c 500
```

Expected: `{"ok":true,...}` with cars, records, and rates. Do not paste the owner key or the response into a public channel. Do not append fake rows to the live Sheet.

- [ ] **Step 8: Record checkpoint**

Report the deployment version, the owner URL (privately), the family URLs, and the test result. Stop before live E2E; Task 12 is the user-driven drill.

---

### Task 12: Live end-to-end verification and secret rotation

**This task uses real charging and real shared data. Do not claim success from unit tests alone.** The owner performs any physical charging; the agent can verify the UI, Sheet, and API.

- [ ] **Step 1: Family flow on a phone**

On an Android phone, open the Model 3 family URL, add it to the home screen, start a charging session, and press `開始充電`. Confirm:

- The record appears immediately with `待配對 · —`.
- The Sheet row has the correct car, start time, and HK date/time.
- A second phone or a reload shows the same record.
- The owner view shows the row in `待配對` before Tesla sync.

- [ ] **Step 2: Tesla sync and matching**

After the Wall Connector session has ended, press `更新 Tesla` in the owner view. Confirm:

- The manual row gains kWh, duration, split, cost, and `tesla+manual`.
- No duplicate unassigned row appears for that session.
- A session without a manual start appears as `unassigned`, and assigning it to a car updates the monthly total.
- Ignoring an unassigned session removes it and adds its key to `Ignored`.
- Deleting a Tesla-linked family record warns about ignoring the Tesla session; the row is gone from the Sheet and does not return after sync.

- [ ] **Step 3: Rates and billing**

1. Press `更新費率`; confirm the current month and the source.
2. Compare the family and owner monthly kWh/cost with the Sheet rows and the formula.
3. Download the family CSV and the owner CSV; open both in Excel/Numbers; confirm BOM, Chinese headers, chronological rows, two-decimal values, and no legacy/unassigned rows in the billing CSV.
4. Confirm the app states that the estimate is not the CLP bill.

- [ ] **Step 4: Failure and offline behavior**

1. Turn off the phone network, press `開始充電`, and confirm the record is queued locally with a status/toast.
2. Restore the network and reload; confirm the pending row is retried and appears in the Sheet exactly once.
3. Press sync or rate refresh while offline; confirm an actionable error and no silent failure.
4. Confirm the owner key is absent from family links, localStorage values, CSV, and the page's visible text.

- [ ] **Step 5: Rotate the exposed Tesla client secret**

The client secret was exposed during development. After all live verification passes:

1. In the Tesla developer portal, rotate the client secret.
2. Update `TESLA_CLIENT_SECRET` in Apps Script Script Properties.
3. Run one owner `更新 Tesla`; confirm success.
4. Revoke the old secret/app grant if the portal offers it.
5. If the owner key was shared accidentally, rotate `OWNER_KEY`, update the owner URL, and resend it; family URLs are unaffected.

- [ ] **Step 6: Final report**

Report:

- The final commit/PR and green CI result.
- The deployment version and the tests run.
- What was verified live, with timestamps.
- Known limits: duration-proportional split, forgotten starts become unassigned, CLP parser fragility, no bill reconciliation.
- Any residual item that requires the user (merge, physical charging, secret rotation confirmation).

Do not merge the PR, rotate the secret, or change the shared Sheet without the user's explicit action/authorization.

---

## Self-review

**Spec coverage**

- Purpose/goals/non-goals: Tasks 1-12; no outside charging, no cron, no CCTV, no backfill by default.
- Architecture/file structure: Tasks 2-9; frontend modules and Apps Script splits match the spec's file table.
- Data model: Task 7 (`Log` migration, `Cars`, `Rates`, `Ignored`); Task 2 normalization.
- URLs/identity: Task 5 app router; owner key validation; Task 9 authorization.
- Tesla integration: Task 8 token cache/rotation, site discovery, session mapping, sync cursor, matching, ignored keys; Task 9 API.
- Rates/billing: Task 6 parsers/split; Task 8 refresh/manual override/reader; Task 2 cost; Task 3 API; Task 4/5 UI; Task 10 formula.
- API: Task 9 all six actions and both GETs; Task 3 client.
- UI family/owner: Tasks 4-5; Task 10 screenshots.
- CSV: Task 2 `toCsv`; Task 4 family; Task 5 owner; Task 12 live check.
- Security: no secrets in frontend; Task 1 token file ignored; Task 9 owner checks; Task 12 rotation.
- Testing: Tasks 2-9 unit/VM/API; Tasks 4-5 browser smoke; Task 12 live E2E.
- Setup/rollout: Tasks 10-11; secret rotation Task 12.
- Risks: documented in README and Task 12 report.

**Placeholder scan**

- The plan uses exact files, signatures, code, commands, and test data. No TBD/TODO steps.
- "Use the browser tool" is an execution instruction, not a placeholder; the checks are concrete.
- The live tasks intentionally require user authorization and physical charging; those are environment actions, not code placeholders.

**Type consistency**

- `startAt`, `date`, `time`, `kWh`, `durationSec`, `teslaStartAt`, `teslaEndAt`, `peakKWh`, `offPeakKWh`, `teslaKey`, `source` are used consistently across frontend, Sheet, Apps Script, and tests.
- `fetchFamilyData(apiUrl, car, fetchImpl)` and `postRecord(apiUrl, record, car, fetchImpl)` take the car ID; the views pass `carId`.
- `ownerKey` is always a separate argument/body field; it never appears in family payloads or family CSV.
- `matchWindowMs`/`MATCH_WINDOW_MINUTES` are converted consistently (minutes × 60 × 1000).
- The rate rows use `basicOffPeak`, `basicPeak`, `fuelAdjustment`, `rebate`, `peakStart`, `peakEnd`, `sourceUrl`, `fetchedAt`, `manualOverride` everywhere.
- `SYNC_CURSOR` is ISO, internal, and only written by `syncTesla_`.

**Known residual choices**

- Owner export is in the owner toolbar; the spec lists the CSV section separately, not the owner action list. This is intentional because the spec defines owner CSV filenames and contents.
- The mock's seeded pending session runs 14:00–16:00, so the post-sync cost is all off-peak; this makes the browser smoke deterministic.
- The CLP parser uses the current official page's monthly FCA table and the current basic charges for the whole current-year table; historical basic-charge changes require a manual `Rates` row.
