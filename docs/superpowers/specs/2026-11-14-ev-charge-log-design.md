# EV Charge Log — Design Spec

Date: 2026-11-14
Status: design approved in chat; pending spec review

## 1. Overview

A static, no-login web app hosted on GitHub Pages for recording the start time of EV charging sessions. Records live only in the user's browser (`localStorage`). The user exports CSV and adds kWh/price columns in Excel to calculate electricity cost.

### Goals

- One-tap recording of the current time on a phone.
- Manual backfill for sessions where the button was missed.
- Excel-compatible CSV export (no xlsx library).
- Zero build step, zero runtime dependencies, free static hosting.

### Non-goals

- Accounts, login, cloud sync, or any backend.
- kWh, price, cost, location, or note fields.
- Editing timestamps or importing/restoring data.
- PWA/service worker, theme switcher, i18n switcher.

## 2. Architecture

Single-page static site, ES module JavaScript, no build step.

| File | Purpose |
| --- | --- |
| `index.html` | Markup, meta tags, links to CSS/JS |
| `style.css` | Dark EV-themed responsive styles |
| `app.js` | ES module: pure logic (exported) + DOM wiring |
| `icon.svg` | Favicon / apple-touch-icon |
| `test/logic.test.mjs` | Node built-in test runner tests |
| `README.md` | Usage and deployment notes |

### Data model

```ts
type Record = { id: string; startAt: string } // startAt = ISO 8601 UTC (toISOString())
```

- Storage key: `ev-charge-log.v1`
- Stored value: JSON array of records.
- Display order: newest first. CSV order: oldest first (chronological).
- `id` from `crypto.randomUUID()` (secure context on GitHub Pages).

### Storage behavior

- Read at startup; invalid JSON → error banner, app runs in read-only mode (add/delete disabled) and never overwrites the corrupt payload.
- Error banner offers a confirmed "重設本機資料" action that clears the key and starts fresh.
- `localStorage` unavailable (e.g. some private modes) → banner explaining records cannot be saved; add actions disabled.
- No automatic migration; key is versioned (`v1`).

## 3. UI

Single screen, mobile-first, dark theme with one electric-green accent. System font stack. Chinese (Traditional, zh-HK) copy. 24-hour time.

Elements:

- Header: "EV 充電紀錄" plus a short local-only note.
- Primary button "⚡ 開始充電": records now, then a polite `aria-live` toast shows the recorded date/time. No double-tap debounce; mistakes are removable.
- Manual backfill row: `datetime-local` input (defaults to now, max = now) + "補錄" button. Invalid or future timestamps are rejected with inline error text.
- Record list: date, weekday, time, and a delete button per row with a confirmation dialog.
- Footer: total count and "匯出 CSV" button (disabled when empty).
- Empty state message when there are no records.
- Touch targets >= 44px, visible focus styles, WCAG AA contrast.

## 4. CSV export

- Filename: `ev-charge-log-YYYYMMDD.csv` (export date, local).
- Encoding: UTF-8 with BOM (`EF BB BF`); line endings CRLF.
- Header row: `日期,時間`.
- One row per record, chronological ascending, local timezone:
  - date `YYYY-MM-DD`, time `HH:mm`.
- Values are RFC 4180 escaped (quote only when needed) even though current values never require it.
- Export is generated client-side via `Blob` + object URL; no network.
- Same file opens directly in Excel and Numbers.

## 5. Logic functions (pure, exported from `app.js`)

- `parseRecords(raw: string | null): Record[]` — tolerate `null`/empty; filter malformed entries.
- `addRecord(records, date: Date, id?)` → new array sorted newest first.
- `removeRecord(records, id)`.
- `sortForDisplay(records)` / `sortChronological(records)`.
- `formatLocalDate(date)` / `formatLocalTime(date)` (24h, local timezone).
- `toCsv(records)` → BOM + CRLF CSV string.
- `isValidManualDate(value, now)` — rejects empty, unparsable, and future timestamps.

DOM wiring and storage access stay outside the pure functions so tests run under Node without a DOM.

## 6. Testing

Unit tests with `node --test`:

- CSV: BOM present, CRLF, header, chronological order, quoting/escaping.
- Sorting: newest-first display, oldest-first export.
- Add/remove behavior and immutability.
- `parseRecords`: null, empty, malformed JSON, mixed valid/invalid entries.
- Manual date validation: empty, invalid, future, valid past.

Browser smoke (local static server, mobile viewport ~390x844):

- Tap "開始充電" → toast + row appears; reload → row persists.
- Manual backfill works; future date is rejected.
- Delete with confirm removes the row and persists.
- Export downloads a CSV whose content matches the list order/format.
- Empty state, corrupt-storage banner, and read-only behavior (simulated via `localStorage`).
- Screenshots for visual check in both empty and populated states.

Acceptance: exported CSV opens in Excel/Numbers with correct local dates/times.

## 7. Deployment

- New public GitHub repo `ev-charge-log` (Pages on free plan requires public).
- GitHub Pages served from `main` branch, repository root.
- Local preview: `python3 -m http.server`.
- Repo creation, push, and Pages enablement happen only after explicit user authorization.
- Final URL: `https://<username>.github.io/ev-charge-log/`.
- Post-deploy smoke test on the live URL.

## 8. Risks and limitations

- Clearing browser storage or switching devices loses records; CSV export is the backup.
- No sync between phone and desktop.
- The public repo contains code only; charging data never leaves the browser.
- Clock/timezone comes from the device; a wrong device clock records a wrong time.
