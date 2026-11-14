# EV Charge Log — Design Spec

Date: 2026-11-14
Status: revised architecture approved in chat; pending spec review

## 1. Overview

A static, no-login web app hosted on GitHub Pages for recording the start time of EV charging sessions. Records sync across devices through a Google Sheet, accessed via a Google Apps Script Web App. The Sheet doubles as the user's spreadsheet for calculating electricity cost.

### Goals

- One-tap recording of the current time on a phone.
- Delete a recent record with confirmation, synced to the Sheet.
- Cross-device consistency with zero login and zero tokens.
- Quick view of recent activity and monthly counts.
- CSV export for a chosen month (or all), Excel-compatible.
- Zero build step; free static hosting.

### Non-goals

- Accounts, OAuth, PATs, or any credential input in the app.
- Manual backfill or in-app editing (deletion is supported for the latest five records).
- kWh, price, cost, location, or note columns.
- Import/restore, PWA/service worker, theme switcher, i18n switcher.
- Preventing third parties who obtain the public endpoint URL from reading, appending, or deleting data.

## 2. Architecture

```
GitHub Pages (static app)  --fetch-->  Apps Script Web App  --->  Google Sheet
        |                                   (JSON API)              (storage, view)
        +-- localStorage cache + pending queue
```

| File | Purpose |
| --- | --- |
| `index.html` | Markup, meta tags, links to CSS/JS |
| `style.css` | Dark EV-themed responsive styles |
| `app.js` | ES module: pure logic (exported) + DOM wiring + sync |
| `config.js` | `API_URL` and `SHEET_URL` constants (public, no secrets) |
| `icon.svg` | Favicon / apple-touch-icon |
| `apps-script/Code.gs` | Apps Script backend source, copied into the user's script project |
| `test/logic.test.mjs` | Node built-in test runner tests |
| `README.md` | Setup, deployment, and usage notes |

### Record model

```ts
type Record = { id: string; startAt: string } // startAt = ISO 8601 UTC (toISOString())
```

- `id` from `crypto.randomUUID()` (secure context on GitHub Pages).
- Local keys: `ev-charge-log.cache.v1` (last known server records) and `ev-charge-log.pending.v1` (unsynced records).
- Display order: newest first. CSV order: oldest first (chronological).

### Google Sheet layout

- One sheet named `Log`; header row created by the script if missing.
- Columns: `id`, `startAt` (ISO UTC), `日期` (`YYYY-MM-DD` local), `時間` (`HH:mm` local).
- `日期` and `時間` are computed by the client from the device-local time and stored as text so the user can read and calculate in the Sheet directly.
- Older rows can be edited or deleted directly in the Sheet; the app picks changes up on the next load.

### Apps Script API

- Deployment: Web app, execute as the owner, access "Anyone".
- `GET` → `{ ok: true, records: [{ id, startAt }] }`.
- `POST` body `{ id, startAt, date, time }` → appends one row, returns `{ ok: true }`.
- `POST` body `{ action: 'delete', id }` → deletes the matching row, returns `{ ok: true, deleted: boolean }`; missing ids are idempotent.
- Validation: `id` matches `[A-Za-z0-9-]{1,64}`, `startAt` parses as a date, `date` matches `YYYY-MM-DD`, `time` matches `HH:mm`; invalid → `{ ok: false, error }`.
- Idempotency: `doPost` checks for an existing `id` under `LockService` before appending, so retries cannot duplicate rows; delete is also idempotent under the same lock.
- `SHEET_ID` and sheet name are constants at the top of `Code.gs`.
- CORS: primary approach is `fetch` with `Content-Type: text/plain;charset=utf-8` (simple request, no preflight). If the live deployment blocks CORS, fall back to JSONP for GET and a hidden-form POST for writes; the API shape stays the same.

## 3. UI

Single screen, mobile-first, dark theme with one electric-green accent, zh-HK copy, 24-hour time. Layout is a single column with no horizontal scroll; the primary button is full-width and thumb-reachable; `env(safe-area-inset-*)` padding for notched devices; designed and verified at 390x844.

Elements:

- Header: "EV 充電紀錄", sync status chip (`已連接` / `未同步` / `離線` / `未設定` / `連線中`), small "打開 Google Sheet" link.
- Primary button "⚡ 開始充電": records now, writes the row, shows a toast with the recorded time. While the POST is in flight it is disabled and shows a spinner with "同步中…", restoring on success or failure. Clicks within 2 seconds of the previous record are ignored to prevent accidental double taps.
- Quick view: 本月次數 / 總次數 / 最近一次 date-time, plus the latest 5 records (date, weekday, time, delete button). Deleting asks for confirmation, shows a spinner in that row's button while the delete API runs, and removes the row on success.
- Export row: month selector built from available months plus "全部月份" (default: current month if it has records, otherwise the newest month with records, otherwise 全部月份), and the "匯出 CSV" button (disabled when the selection has no records).
- Empty state message when there are no records.
- No settings, no manual add; deletion is available on each of the latest five rows.
- Loading indicators: chip spinner and `連線中` during the initial/full sync, start-button spinner during save, per-row spinner during delete. Controls re-enable on completion and on failure.
- Touch targets >= 44px, visible focus styles, WCAG AA contrast.

## 4. CSV export

- Filename: `ev-charge-YYYY-MM.csv` (selected month) or `ev-charge-all.csv`.
- Encoding: UTF-8 with BOM (`EF BB BF`); line endings CRLF.
- Header row: `日期,時間`.
- One row per record in the selected local month (or all), chronological ascending, device-local timezone:
  - date `YYYY-MM-DD`, time `HH:mm`.
- Values are RFC 4180 escaped.
- Generated client-side via `Blob` + object URL; no network. Works from cached data while offline.
- Same file opens directly in Excel, Numbers, and Google Sheets.

## 5. Logic and sync

Pure functions exported from `app.js`:

- `parseServerRecords(payload)` — validate and normalize the API response.
- `mergeRecords(serverRecords, pending)` — union by `id`, pending entries included, sorted newest first.
- `filterByMonth(records, 'YYYY-MM' | 'all')` — local-month filter used by quick view and export.
- `toCsv(records)` → BOM + CRLF CSV string.
- `formatLocalDate/Time`, `formatWeekday`, `monthKey` helpers.

Sync behavior:

- On load: render cache immediately with `連線中`, then `GET`; on success replace the cache, drop pending entries whose `id` now exists on the server, retry pending, and re-render; on failure keep cache and show `離線`.
- On record: append to pending + cache, render immediately, then `POST`; on success remove from pending; on failure keep pending and show `未同步`.
- Retries: on app load, `online` event, and before each new record. Pending entries are merged by `id`, so retries and repeated loads are idempotent on the client too.
- Delete: confirm, call `POST { action: 'delete', id }`, then remove the record from cache/pending and re-render; on failure keep the record and show `刪除失敗`.
- Sheet edits (including deleting older rows) appear after the next successful `GET`.

### Error handling

- `API_URL` empty → local-only mode with `未設定` chip and a hint in the empty state.
- HTTP/network/parse errors → keep working from cache; chip shows `離線`/`未同步`; toast describes the problem and points to `config.js`/the Apps Script deployment. Start and delete controls always re-enable in a `finally` block.
- Corrupt cache/pending JSON → discard only the corrupt key, show a one-time notice; server data reloads on the next sync.

## 6. Testing

Unit tests with `node --test`:

- CSV: BOM, CRLF, header, chronological order, RFC 4180 escaping.
- Sorting and merge: union by id, no duplicates, newest-first display.
- Month filter: boundaries across months and years, `all`.
- Response validation: missing fields, malformed JSON, extra fields.
- Delete client: request shape, HTTP/API error handling.
- Pending queue: retry idempotency, removal on success, retention on failure.

Browser smoke (local static server, mobile viewport ~390x844, API mocked by stubbing `fetch`):

- Tap start → toast + row appears; reload → cache shown before sync.
- Offline start → `未同步` then auto-retry on `online`.
- Month selector + export downloads a CSV matching the filter and format.
- Delete: cancel keeps the row; confirm removes it locally and on the mock API; API failure keeps the row and shows an actionable toast.
- Loading states with a delayed mock API: `連線中` chip spinner on load, start button disabled with `同步中…`, delete button disabled with a spinner, all restored afterwards.
- Empty state, `未設定` mode, API error chip.
- Screenshots for empty and populated states.

Live verification after the user deploys the Apps Script:

- Real `GET`/`POST` round trip, row appears in the Sheet with correct local date/time.
- Duplicate `POST` with the same id does not create a second row.
- Delete removes the Sheet row and the record disappears from a fresh browser.
- Fresh device/browser shows the same records.
- Export from the live site matches the Sheet.

## 7. Setup and deployment

User one-time setup:

1. Create a Google Sheet.
2. Extensions → Apps Script; paste `apps-script/Code.gs`; set `SHEET_ID`.
3. Deploy as Web app: execute as me, access Anyone; copy the deployment URL.
4. Provide the deployment URL (and Sheet URL) to the developer.

App deployment:

- New public GitHub repo `ev-charge-log`; GitHub Pages from `main`, repository root.
- `config.js` receives `API_URL` and `SHEET_URL` before the production push; both are public by design.
- Local preview: `python3 -m http.server`.
- Repo creation, push, and Pages enablement happen only after explicit user authorization.
- Final URL: `https://<username>.github.io/ev-charge-log/`.
- Post-deploy smoke test on the live URL.

## 8. Risks and limitations

- The Apps Script URL is a capability: anyone who reads the public source can read, append, or delete records. There is no authentication; worst case is data tampering or spam rows, corrected directly in the Sheet.
- Google Apps Script quotas and availability apply (consumer quota is ample for personal use); CORS behavior must be verified live.
- The Sheet is the durable store; clearing browser storage only loses the local cache/pending items not yet synced.
- Device clock/timezone determines recorded time; a wrong device clock records a wrong time.
- Monthly grouping in the app is based on each device's local timezone at view time.
