# EV Charge Log — Tesla Billing Extension Design

Date: 2026-11-14
Status: design approved in chat; pending spec review

This spec extends the original design in
`docs/superpowers/specs/2026-11-14-ev-charge-log-design.md`. It supersedes the
original non-goals for kWh, price, and cost for this feature only. The family
app still has no login and no credential input in the browser.

No implementation starts until this spec is reviewed and the implementation
plan is approved.

## 1. Purpose

The app is used by one household with one Tesla Wall Connector and several
EVs. All cars charge at home; some are not Teslas. The owner wants to recover
each car's share of the home electricity bill. Tesla's app shows the owner's
own charging, but it does not provide per-person billing.

The extension adds:

- A car identity to each URL.
- Per-session kWh and charging duration from the Tesla Fleet API.
- Peak and off-peak cost estimates using the CLP EV residential time-of-use
  tariff and the current fuel adjustment charge.
- A monthly per-car summary, CSV export, and an owner view for unassigned
  sessions and rate management.

## 2. Goals

- Attribute home charging to a car without selecting a name on every charge.
- Keep the family flow to one tap: open the car's URL, tap start.
- Fill kWh from the Wall Connector's official charge history on demand.
- Never duplicate a charging session across syncs.
- Show an estimated cost per session and per month, using the official CLP
  tariff and fuel adjustment charge.
- Keep Tesla credentials server-side. The owner view is an unkeyed mode, not a
  login.
- Preserve existing Sheet rows; never delete or rewrite legacy records.
- Keep the app a static GitHub Pages site with no build step.

## 3. Non-goals

- Outside charging. Only the home Wall Connector is in scope.
- CCTV or automatic vehicle recognition. The URL is the attribution mechanism
  for this version.
- Monthly reconciliation against the actual CLP bill. This is the future C
  option.
- Real-time charging status.
- Multiple Wall Connectors, load sharing, or more than one Tesla energy site.
- User accounts, passwords, or real authentication.
- Manual kWh entry in the app. A session either receives Tesla kWh or remains
  unmatched.
- Excel `.xlsx` generation; CSV opens in Excel.
- Backfilling more than 90 days.

## 4. Approved decisions

| Decision | Choice |
|---|---|
| Attribution | Per-car URL, `?car=<id>` |
| Data store | One shared Sheet with a `car` column |
| Tesla sync | On demand, no cron |
| Charging location | Home Wall Connector only |
| Peak/off-peak split | Proportional to session duration (B) |
| Bill reconciliation | Future enhancement (C) |
| Rate source | Official CLP pages, reader fallback, manual override |
| Owner access | Owner-mode URL (`?owner`), no key or login |
| Old records | Preserved as legacy; excluded from new billing |

## 5. Verified facts

Verified on 2026-11-14:

- The Tesla Fleet API returns the Wall Connector as one `energy_site` with
  `resource_type=wall_connector`.
- The last 90 days contained 93 charge sessions.
- Session fields: `charge_start_time.seconds`, `charge_duration.seconds`,
  `energy_added_wh`, `target_id.text`, `din`.
- All 93 sessions had one `target_id` and one `din`. These identify the Wall
  Connector, not the car or driver. The API cannot attribute a session to a
  car.
- `telemetry_history?kind=charge` returns session history. It does not return
  a per-minute power curve. Peak/off-peak energy must be estimated.
- The Tesla token endpoint accepts HTTP/1.1, so Apps Script can perform token
  refresh.
- CLP's EV residential time-of-use page states, for 2026:
  - Non-peak: 23:00–16:00, 94.5 HK cents/kWh basic charge.
  - Peak: 16:00–23:00, 137.5 HK cents/kWh basic charge.
- CLP's fuel adjustment page states 47.4 HK cents/kWh from 2026-11-01.
  - 2026-11 totals: non-peak 141.9 HK cents/kWh (HK$1.419); peak 184.9 HK
    cents/kWh (HK$1.849).
- The official `FCA.csv` ends at 2025-12 as observed on 2026-11-14 and is not
  used as a live source.
- Direct server-side fetches of the CLP pages return HTTP 403. A reader
  fallback succeeds and returns the current page values.

## 6. Architecture

```
Family URL ?car=<id> ─┐
                      ├─> GitHub Pages static app
Owner URL ?owner      ┘         │
                                │ GET/POST (text/plain)
                                ▼
                      Google Apps Script Web App
                         │          │          │
                         ▼          ▼          ▼
                    Google Sheet  Tesla     CLP pages
                    Log/Cars/     Fleet     (direct, then
                    Rates API     API       reader fallback)
```

Components:

| Component | Responsibility |
|---|---|
| `index.html` | Shared shell for family and owner views |
| `app.js` | URL routing, shared state, event wiring |
| `api.js` | Apps Script GET/POST calls |
| `logic.js` | Pure functions: normalization, matching helpers, split, cost, CSV |
| `family.js` | Family view rendering and actions |
| `owner.js` | Owner view rendering and actions |
| `rate-view.js` | Shared owner/family rate cards and latest-month collapse |
| `live.js` | Wall Connector live poll and 1-second estimated counter |
| `vendor/qrcode-generator.js` | MIT QR encoder for per-car auto-start codes |
| `style.css` | Existing dark theme plus owner/family additions |
| `config.js` | Public `API_URL` only |
| `apps-script/Code.gs` | Web app routing, validation, locking |
| `apps-script/SheetRepo.gs` | Sheet tabs, header migration, row operations |
| `apps-script/Tesla.gs` | Tesla token refresh, site discovery, session fetch |
| `apps-script/Rates.gs` | CLP fetch, parsing, rate upsert |
| `apps-script/Logic.gs` | Pure matching, split, and parser helpers |
| `test/` | Node tests and browser smoke tests |

Splitting the frontend and Apps Script files is required because the owner
view and sync logic would otherwise make the current single-file modules too
large to review and test. Existing user-visible behavior is preserved.

## 7. Data model

### 7.1 Record

```ts
type Source = 'manual' | 'tesla' | 'tesla+manual' | 'legacy';

type SessionRecord = {
  id: string;                 // UUID, or tesla-<startSeconds>-<hash>
  car: string;                // Cars.id, 'unassigned', or '' for legacy
  startAt: string;            // ISO 8601 UTC; manual press time
  date: string;               // YYYY-MM-DD in Asia/Hong_Kong
  time: string;               // HH:mm in Asia/Hong_Kong
  kWh: number | null;
  durationSec: number | null;
  teslaStartAt: string | null; // ISO 8601 UTC
  teslaEndAt: string | null;   // ISO 8601 UTC
  peakKWh: number | null;
  offPeakKWh: number | null;
  teslaKey: string | null;     // <din>:<startSeconds>
  source: Source;
};
```

Rules:

- A manual start creates a record with `source='manual'`, `car` from the URL,
  and every Tesla/billing field null.
- A matched record keeps its manual `id`, `startAt`, and `car`, and gains
  Tesla fields, `peakKWh`, `offPeakKWh`, and `source='tesla+manual'`.
- An unmatched Tesla session becomes `car='unassigned'`, `source='tesla'`,
  `id='tesla-<startSeconds>-<hash>'`, and `startAt` equal to the Tesla start.
  The deterministic hash suffix keeps same-second sessions distinct.
- Legacy rows have `source='legacy'` and blank new fields. They are not
  billed and are never shown to family URLs.
- `kWh` and the split are stored as numbers. Cost is not stored; it is
  computed from the rate table.
- Google Sheets may return date-formatted cells for `startAt` or Tesla
  timestamps; normalize them to ISO. Derive `date` and `time` from `startAt` in
  Asia/Hong_Kong.

### 7.2 Car

`Cars` tab columns:

| Column | Meaning |
|---|---|
| `id` | URL slug, `[a-z0-9-]{1,32}`, reserved value `unassigned` forbidden |
| `name` | Display name, e.g. `Model 3` |
| `active` | `TRUE` or `FALSE`; inactive cars are rejected by the API |
| `createdAt` | ISO timestamp |

The owner edits this tab directly. The app does not provide a car editor.

### 7.3 Rate

`Rates` tab columns:

| Column | Meaning |
|---|---|
| `month` | `YYYY-MM` in Asia/Hong_Kong; primary key |
| `basicOffPeak` | HK cents/kWh |
| `basicPeak` | HK cents/kWh |
| `fuelAdjustment` | HK cents/kWh |
| `rebate` | HK cents/kWh; 0 when not applicable |
| `peakStart` | `HH:mm`, default `16:00` |
| `peakEnd` | `HH:mm`, default `23:00` |
| `sourceUrl` | Official CLP page(s) used, comma-separated; the owner view links each URL |
| `fetchedAt` | ISO timestamp of the last successful fetch |
| `manualOverride` | `TRUE` means the automatic fetch must not overwrite this row |

`rebate` is subtracted from both peak and non-peak rates. The owner sets it
when eligible. The fetch must not infer eligibility.

Google Sheets may store `month` as a date cell and `peakStart`/`peakEnd` as
time cells. The reader normalizes the month to `YYYY-MM` and formats time-only
cells in `Asia/Hong_Kong`; a fixed `+08:00` shift is wrong because the 1899
time-cell epoch uses Hong Kong's historical offset. It dedupes duplicate month
rows, preferring a manual override and then the latest `fetchedAt`. The refresh
also keeps one row per month: it prefers a manual override row, does not
overwrite it, and deletes duplicate rows for the refreshed month.

### 7.4 Legacy Ignored tab

Older deployments may have an `Ignored` tab. It is not created, read, or
written. Tesla sessions are never ignored: deleting a record releases it to
`unassigned`.

### 7.5 Google Sheet layout

The existing `Log` tab keeps its current columns in place and appends new
columns to the right. No existing row is moved or deleted.

Current columns: `id`, `startAt`, `日期`, `時間`.

Appended columns: `car`, `kWh`, `durationSec`, `teslaStartAt`, `teslaEndAt`,
`peakKWh`, `offPeakKWh`, `teslaKey`, `source`.

All reads and writes use a header-to-index map, never fixed column positions.
If a new column is missing, the script appends it to the header row. Old rows
receive blank values for the new columns and are normalized to
`source='legacy'` when read.

Tabs `Cars` and `Rates` are created with their headers when missing, and `Log`
is created by the read path. The script does not seed car or rate values; the
owner populates them or runs the rate refresh.

### 7.6 Timezone

All billing dates, months, peak periods, and CSV dates use
`Asia/Hong_Kong`. Device timezone is not used for billing. The existing
device-local display helpers are replaced by Hong Kong helpers so that month
boundaries and rate selection are deterministic.

## 8. URLs and identity

- Family: `https://<site>/ev-charge-log/?car=<id>`.
- Owner: `https://<site>/ev-charge-log/?owner=1` (any `owner` parameter opens
  the owner view; the value is ignored).
- No parameter: a setup message explaining how to get the correct link; no
  records are loaded.
- If both parameters are present, the owner view wins and the car parameter is
  ignored.
- The family URL is the car's capability. Anyone with it can add and delete
  that car's records. The owner shares each URL only with the relevant family
  member.
- The owner view has no key or login. `?owner` is a mode flag. Anyone who knows
  the app URL can open the owner view and manage the log. The owner keeps that
  URL private; this is an accepted trade-off for a family-only app.
- The owner view builds and displays each family URL for copying. Those URLs
  contain only `?car=<id>`.

## 9. Tesla integration

### 9.1 Server-side configuration

Apps Script Script Properties:

| Property | Purpose |
|---|---|
| `SHEET_ID` | Target spreadsheet ID from the Sheet URL |
| `TESLA_CLIENT_ID` | Tesla app client ID |
| `TESLA_CLIENT_SECRET` | Tesla app client secret |
| `TESLA_REFRESH_TOKEN` | OAuth refresh token |
| `TESLA_BASE_URL` | Default `https://fleet-api.prd.na.vn.cloud.tesla.com` |
| `TESLA_SITE_ID` | Optional; otherwise auto-discovered |
| `MATCH_WINDOW_MINUTES` | Matching window; default `30` |
| `SYNC_FROM` | Optional ISO date for an intentional backfill |
| `SYNC_CURSOR` | Internal lower bound updated after each successful sync |

The client secret and refresh token never reach the browser.

### 9.2 One-time refresh-token setup

The local probe is extended with a setup mode that performs the existing
authorization-code flow and writes the refresh token to
`tools/.tesla-refresh-token.local` with mode `0600`. The tool never prints the
token. The owner copies the value into Script Properties. The file is
gitignored. The client ID and secret come from the existing
`tools/.env.tesla.local`, which is also gitignored and never committed.

The public key site and NA partner registration already exist from the probe
work and are unchanged.

### 9.3 Token refresh

`refreshAccessToken_()` posts form data to
`https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token` with
`grant_type=refresh_token`, the client id and secret, the refresh token,
`audience=<TESLA_BASE_URL>`, and scope
`openid offline_access energy_device_data`. It caches the access token and its
expiry in Script Properties and refreshes it five minutes before expiry. If
the response contains a new refresh token, it replaces
`TESLA_REFRESH_TOKEN`.

A 401 or 403 is returned to the app as
`Tesla authorization expired; re-run the local setup tool`.

### 9.4 Site discovery

The script calls `/api/1/products` with the access token. It uses
`TESLA_SITE_ID` when set. Otherwise it finds the single product with
`resource_type=wall_connector`. Zero or more than one match is an error asking
the owner to set `TESLA_SITE_ID`.

### 9.5 Session fetch

```
GET /api/1/energy_sites/{siteId}/telemetry_history
  ?kind=charge
  &start_date=<ISO datetime>
  &end_date=<ISO datetime>
  &time_zone=Asia%2FHong_Kong
```

The fetch lower bound is:

- If `SYNC_CURSOR` exists: `max(SYNC_CURSOR - 2 days, now - 90 days)`.
- Otherwise, if `SYNC_FROM` is set: `max(SYNC_FROM, now - 90 days)`.
- Otherwise, if manual records exist: the earliest manual record's `startAt`
  minus 2 days.
- Otherwise, for an owner sync (`更新充電樁` with no `car`): `now - 30 days`.
  This is the initial load and may create unassigned sessions.
- Otherwise, for a family-scoped sync: return without fetching. Family page
  load must not import 30 days of history before anyone presses start.

After a successful sync, `SYNC_CURSOR` is set to the fetch end time. The
owner can set `SYNC_FROM` to an earlier ISO date to intentionally backfill up
to 90 days; `SYNC_CURSOR` takes precedence, so the owner must clear it first if
a new backfill bound is required. Date-only values are not used because they
were rejected by the live API. The response is parsed with the same recursive
session-array discovery used by the probe.

A session is eligible when:

- `charge_start_time.seconds` is a finite number.
- `charge_duration.seconds` is greater than zero.
- `energy_added_wh` is greater than zero.

Ineligible sessions are ignored and retried on a later sync.

### 9.6 Matching and reconciliation

Definitions:

- `teslaKey = <din>:<startSeconds>`.
- `earlyMs = MATCH_EARLY_MINUTES * 60 * 1000` (default 120 minutes).
- `lateMs = MATCH_LATE_MINUTES * 60 * 1000` (default 30 minutes).
- `fallbackWindowMs = MATCH_WINDOW_MINUTES * 60 * 1000` (default 30 minutes,
  used only when a session has no end time).
- A manual candidate is a row with `source='manual'`, a non-empty `car` other
  than `unassigned`, `kWh` empty, and `teslaKey` empty.

Sync order, in two lock phases:

1. Under the script lock, read `Log`, then determine the fetch lower bound from
   `SYNC_CURSOR`, `SYNC_FROM`, or the earliest manual record, as described in
   9.5. If no bound exists, return with zero counts without fetching or
   updating `SYNC_CURSOR`. Release the lock.
2. Fetch and normalize all eligible Tesla sessions in the range without
   holding the lock.
3. Reacquire the lock, re-read `Log`, and reconcile existing
   unassigned rows with manual candidates:
   for every `source='tesla'` row with `car='unassigned'`, find manual
   candidates for any car whose `startAt` is inside the session interval
   `[startAt, endAt]`, or up to `earlyMs` before it, or up to `lateMs` after
   it. If exactly one car has candidates, choose the closest candidate for that
   car. Copy kWh, duration, Tesla timestamps, split, and `teslaKey` into the
   manual row, change its source to `tesla+manual`, and delete the unassigned
   row. If candidates span more than one car, leave the unassigned row for
   manual resolution. This handles a family member pressing start late (inside
   a long session) or early.
4. For every Tesla session whose `teslaKey` already exists in `Log`, skip it.
5. For the remaining sessions, apply the same interval match. If one car has
   candidates, fill the closest manual row and keep its id, car, and manual
   startAt. If no candidate exists, or candidates span multiple cars, append an
   unassigned row.
6. Owner/family assign and claim use the same interval matcher, but filter
   manual candidates to the explicitly selected car, so the selected car
   resolves any cross-car ambiguity.
7. After applying without throwing, set `SYNC_CURSOR` to the fetch end time,
   never moving it backwards when concurrent syncs finish out of order. Release
   the lock.
8. Return counts: `matched`, `unassigned`, `skippedExisting`,
   `reconciled`, and `pendingManual`.
9. `pendingManual` counts manual rows that still have no kWh.

Re-reading under the apply lock makes concurrent syncs idempotent: a session
written by the first sync is skipped by the second. No partial writes occur if
the Tesla fetch fails. Parsing and validation finish before the first Sheet
write. Sheet reads and writes use `LockService` with a 30 second wait; the
Tesla fetch and the `?status=1` route do not.

### 9.7 Peak/off-peak split

The split is computed at sync time and stored in `peakKWh` and `offPeakKWh`.

Inputs: `teslaStartAt`, `durationSec`, total `kWh`, and the peak window for
the session's Hong Kong month. Use that month's rate row when present;
otherwise use the latest earlier rate row; otherwise use `16:00`–`23:00`.
Changing a rate row's peak window does not rewrite existing split values;
the split is a policy input captured at sync time.

Algorithm:

1. If duration is zero or missing, classify the entire session by its start
   time.
2. Otherwise, walk the session in one-minute buckets in `Asia/Hong_Kong`.
   The final partial minute is apportioned by its seconds.
3. A bucket is peak when its local time is in `[peakStart, peakEnd)`.
4. `peakKWh = kWh * peakSeconds / durationSec`.
5. `offPeakKWh = kWh - peakKWh`.
6. Round both to 6 decimal places for storage; they must sum to `kWh` within
   `1e-6`.

This is an estimate. The UI labels cost as estimated. Future C replaces the
estimate with the actual CLP bill registers.

## 10. Rates and billing

### 10.1 Official source

Current pages:

- Tariff:
  `https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff`
- Fuel adjustment:
  `https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment`

The official `FCA.csv` is not used. It ended at 2025-12 when checked.

### 10.2 Refresh flow

`refreshRates` is owner-only. It runs on demand; there is no cron.

1. Fetch each official page with a browser-like user agent.
2. If the response is not HTTP 200 or lacks expected markers, fetch
   `https://r.jina.ai/<official URL>` and parse the reader output.
3. Normalize the fetched text before parsing: strip HTML tags, Markdown bold
   (`**`), non-breaking/ideographic spaces, and collapse spacing while keeping
   line breaks.
4. Parse the current fuel adjustment sentence with flexible spacing and
   markup between the date, label, value, and unit.
5. Parse the current year's monthly fuel adjustment table, stripping `*`
   markers and bounding it at `備註` or the next section. Require the month and
   value counts to match. Do not infer or apply any special rebate.
6. Parse the tariff page's current non-peak and peak basic charges (94.5 and
   137.5 at the time of writing) next to their Chinese labels. Parse the time
   windows when possible; otherwise keep the existing defaults.
7. Validate before writing: month format, fuel adjustment 0-200 cents, basic
   charges 0-500 cents, peak greater than non-peak, 1-12 rows, and the current
   month present with the same value. On any failure, leave existing rows
   unchanged and return an error that prompts the owner to set
   `manualOverride=TRUE`.
8. Upsert one `Rates` row per month, matching date-formatted month cells.
   Remove duplicate month rows; prefer a `manualOverride` row and do not
   overwrite it.
9. Set `sourceUrl` and `fetchedAt` on rows written by the fetch.

Months outside the year table shown on the current page are not fetched; the
owner must add them manually. The owner may edit `Rates` directly. Setting
`manualOverride=TRUE` protects a row from automatic replacement.

### 10.3 Rate selection

- Use the Hong Kong month of `teslaStartAt`; if absent, use `startAt`.
- Use the exact `month` row when present.
- Otherwise use the latest earlier row and mark the result as a fallback.
- If no row exists, cost is unavailable: display `—` and
  `未設定費率`.
- A fallback rate must display
  `使用 <month> 費率估算；請確認本月費率`.

### 10.4 Cost formula

All values are HK cents per kWh; divide by 100 for HKD.

```
offPeakRate = basicOffPeak + fuelAdjustment - rebate
peakRate    = basicPeak    + fuelAdjustment - rebate

cost = offPeakKWh * offPeakRate / 100
     + peakKWh    * peakRate    / 100
```

For 2026-11:

- `offPeakRate = 94.5 + 47.4 - 0 = 141.9` cents (HK$1.419/kWh).
- `peakRate = 137.5 + 47.4 - 0 = 184.9` cents (HK$1.849/kWh).

Display and export cost to two decimal places. Keep full precision until the
final rounding.

### 10.5 Future C

A later enhancement will accept the CLP bill's actual peak kWh, off-peak kWh,
and total amount for the month, then reconcile the estimated per-car shares to
the bill. It is not part of this version.

## 11. Apps Script API

All POST requests use `Content-Type: text/plain;charset=utf-8` to avoid CORS
preflight, matching the current app.

### 11.1 GET

`GET ?car=<id>` returns:

```json
{
  "ok": true,
  "car": { "id": "model3", "name": "Model 3" },
  "records": [SessionRecord],
  "unassigned": [SessionRecord],
  "rates": [Rate],
  "serverTime": "2026-11-14T14:00:00.000Z"
}
```

Only records whose `car` equals the requested car are in `records`. Unassigned
Tesla rows are returned separately in `unassigned` so the family can claim a
forgotten start; legacy rows are not returned.

`GET ?owner` returns:

```json
{
  "ok": true,
  "cars": [Car],
  "records": [SessionRecord],
  "rates": [Rate],
  "sheetUrl": "https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit",
  "serverTime": "2026-11-14T14:00:00.000Z"
}
```

All records, including unassigned and legacy rows, are returned. Invalid or
missing parameters return
`{ "ok": false, "error": "..." }`.

`GET ?status=1` returns the live Wall Connector probe:

```json
{
  "ok": true,
  "charging": true,
  "powerW": 7200,
  "energyWh": null,
  "state": "1",
  "available": true,
  "sampledAt": "2026-11-15T07:20:00.000Z"
}
```

`energyWh` is null when the live endpoint does not expose session energy; the
UI then estimates from power. `GET ?status=1` does not read or write the Sheet.

### 11.2 POST actions

| Action | Body | Authorization | Result |
|---|---|---|---|
| `append` | `{ id, car, startAt, date, time }` | Valid active car | Idempotent by id |
| `delete` | `{ id, car }` | Car owns row | Releases a Tesla-linked row to `unassigned`; deletes a manual row |
| `sync` | `{}` (all cars) or `{ car }` | Owner mode, or valid car | Runs matching; returns counts |
| `assign` | `{ id, car }` | Owner mode | Assigns an unassigned row; merges a pending manual row when possible |
| `claim` | `{ car, id }` | Valid active car | Family-scoped assign to that car; same merge behavior as `assign` |
| `refreshRates` | `{}` | Owner mode | Fetches and upserts rates |

Validation:

- Record ids match `[A-Za-z0-9-]{1,64}`.
- Car ids match `[a-z0-9-]{1,32}` and exist with `active=TRUE`;
  `unassigned` is reserved.
- `startAt` parses as a date; `date` is `YYYY-MM-DD`; `time` is `HH:mm`.
- Owner-mode actions are unauthenticated by design; the API has no owner-key
  check.
- Unknown actions return `{ ok: false, error: "invalid action" }`.
- Missing rows and repeated deletes are idempotent.

`append` always sets `source='manual'` server-side; the client cannot set a
source. It recomputes `date` and `time` in Asia/Hong_Kong from `startAt` and
rejects supplied values that do not match. `delete` keeps the row when it has
`teslaKey`: it changes `car` to `unassigned`, `source` to `tesla`, sets
`startAt` to `teslaStartAt`, recomputes `date`/`time`, and returns
`released=true`. The session stays claimable by any car. A repeated delete for
the released row is idempotent.

`assign` behavior (also used by the family `claim`):

1. Validate the target car.
2. If the row is unassigned and a pending manual row for the target car exists
   within the matching window, copy the Tesla fields into the manual row,
   change its source to `tesla+manual`, and delete the unassigned row.
3. Otherwise set the unassigned row's `car` to the target car.

`ignore` is removed; there is no action that marks a real charge session as
never-import-again.
All Sheet reads and writes use `LockService`; sync locks only its prepare and
apply phases and waits up to 30 seconds. The Tesla fetch and `?status=1` do not
take the script lock.

## 12. UI

### 12.1 Family view

Shown for `?car=<id>`.

- Header: `EV 充電紀錄`, car name, status chip, and no Sheet link.
- Auto-start URL: `?car=<id>&start=1` records a start after the initial load
  without pressing the button, then removes the `start` parameter from history.
  It does not record a second start while a manual start is pending.
- Primary action: `⚡ 開始充電`, full width. It records the current time for
  this car and shows a toast. While a manual start is pending (kWh null), the
  button is disabled and reads `已記錄開始時間`; it re-enables when the record
  is matched or deleted.
- Secondary action: `更新充電樁`. It calls `sync`, shows a spinner, and
  reports `已配對 X 個 session`.
- After the initial record load, the family view runs one sync automatically
  when online. The button allows a manual retry. There is no polling. A page
  refresh after a charge ends syncs and replaces `待配對` with the matched
  session.
- Section order: monthly summary cards, unassigned list, recent list, rate
  and split, export.
- Summary cards: current-month session count, total kWh, estimated cost.
  A smaller line shows the peak/off-peak kWh split and the rate month. Values
  scale down to a 320px viewport without clipping.
- Recent list: date, weekday, start time and end time in 12-hour AM/PM, kWh,
  estimated cost, delete button. The end date is prefixed when the session
  crosses midnight. A record without kWh shows `待配對` and `—` for cost.
- Rate and split: the split line plus the same rate cards as the owner view;
  the latest month is open and older months are collapsed.
- Unassigned list: Tesla start and end time in 12-hour AM/PM, kWh, duration,
  and `認領`. Claiming a session assigns it to this car (or merges a nearby
  manual pending row) without entering a backdated time. This is the
  forgotten-start recovery path. The latest 24 hours stay open; older sessions
  are grouped by Hong Kong month, then by day, and both levels are collapsed.
  Open groups are preserved after claim/assign.
- Delete confirmation for a Tesla-linked record explains that the 充電樁紀錄
  will return to `未配對充電樁紀錄` for another car to claim. A manual pending
  record is removed.
- Live charging card while a manual start is pending: `充電中`/`未充電`,
  instantaneous kW, and an estimated kWh/cost counter. The counter seeds from
  the manual start and the first power sample, then interpolates every second
  between 5-minute live polls. The completed Tesla session is authoritative.
- Month selector and `匯出 CSV`; default month follows the existing behavior.
- Rate note: `按 CLP <month> 費率估算；實際電費以中電賬單為準`.
- If no rate exists at or before the month, show `未設定費率` and no cost. If
  an earlier rate is used, show the fallback warning.
- Loading states for initial load, start, sync, and delete.
- Offline behavior: cached records render; new starts queue in the per-car
  pending queue; sync and rate actions show an offline error.

### 12.2 Owner view

Shown for `?owner`.

- Header: `EV 充電紀錄 — 管理`.
- Actions: `更新充電樁`, `更新費率`, `打開 Google Sheet`.
- Live charging card while any manual start is pending: `充電中`/`未充電`,
  instantaneous kW, and the same estimated kWh/cost counter as the family view.
- Month selector for the per-car table; default current month.
- Per-car monthly table: car name, sessions, kWh, non-peak kWh, peak kWh,
  estimated cost. Legacy rows are counted separately and excluded from totals.
- Pending list: one `待配對` list for everything not fully matched:
  - a manual start waiting for a charger session;
  - a charger session without a car.
  The latest 24 hours stay open; older sessions are grouped by Hong Kong
  month, then by day, and both levels are collapsed. Open groups are preserved
  after assign. Unassigned rows have a car selector and `分配`; manual rows
  show the car and wait. There is no `忽略` action.
- Rates table: month, non-peak rate, peak rate, fuel adjustment, rebate,
  source, fetchedAt, manual override. The latest month is shown first; older
  months are collapsed. Read-only; edit in the Sheet.
- Family link per car with a copy button. Links contain only `?car=<id>`.
- QR button per car. It encodes `?car=<id>&start=1`, shows the QR inline, and
  offers a downloadable image for the charger/car.
- Empty states: no cars configured, no rates configured, no unassigned
  sessions.
- Loading and error states for sync, rate refresh, and assign.
- The owner view keeps no credential in memory or storage; `?owner` selects the
  view and is not sent as an API credential.
- `index.html` sets `<meta name="referrer" content="no-referrer">` and
  owner-view external links use `rel="noreferrer"` to limit URL leakage through
  the Referer header.

### 12.3 CSV export

Family export contains only the current car. Owner export includes all cars for
the selected month. Legacy rows are excluded from both billing exports.

Filename:

- Family: `ev-charge-<car>-<YYYY-MM>.csv` or
  `ev-charge-<car>-all.csv`.
- Owner: `ev-charge-all-<YYYY-MM>.csv` or `ev-charge-all.csv`.

Format: UTF-8 BOM, CRLF, RFC 4180 escaping.

Header:

```
日期,時間,車,kWh,非高峰 kWh,高峰 kWh,估算電費 (HKD),來源
```

Rows are chronological ascending. kWh and cost use two decimal places; a
missing value is an empty cell. The `車` column uses the car display name;
unassigned and legacy rows are excluded from billing exports. The `來源`
column uses the record source (`manual`, `tesla`, or `tesla+manual`). Dates and
times are Asia/Hong_Kong.

## 13. Security and privacy

- The family app never receives Tesla credentials.
- The owner view has no key or login. Anyone who knows the app URL and adds
  `?owner` can read all records and run owner actions. This is an accepted
  trade-off for a family-only app; the owner keeps the URL private.
- Tesla credentials live only in Apps Script Script Properties.
- The Sheet is link-shared by the current owner choice; anyone with the link
  can read the log. The Sheet URL is not in the repository: `SHEET_ID` is a
  Script Property and the owner payload derives the link. Set General access to
  Restricted if privacy is required.
- A car QR encodes the family URL plus `start=1`. Anyone who scans it can start
  that car; the QR has the same authority as the family URL.
- The Apps Script URL and each family URL are capabilities. Anyone with a
  family URL can add/delete that car's records and claim unassigned Tesla
  sessions to that car. This matches the existing no-login model; the household
  trusts its members.
- If the owner URL is exposed, create a new Apps Script deployment URL and
  update `config.js`; family links keep working after the frontend redeploy.
- The Tesla OAuth app remains read-only for energy data; it has no vehicle
  command scopes.
- The refresh-token setup file and `.env.tesla.local` are gitignored and mode
  `0600`.
- The Tesla client secret pasted during development is treated as exposed. It
  is rotated after implementation, per the owner's instruction, and the new
  value is stored only in the local env file and Script Properties.
- No secrets are written to the Sheet, browser storage, CSV, or logs.

## 14. Testing

### 14.1 Unit tests

- Record normalization preserves car, kWh, split, Tesla fields, and legacy
  rows.
- Per-car storage keys and pending queues do not mix cars.
- Matching chooses the nearest manual record within the window, is
  deterministic on ties, and ignores rows outside the window.
- Sync is idempotent by `teslaKey`.
- Lock scope: `?status=1` takes no script lock; a sync does not hold the lock
  during the Tesla fetch, holds it for its two Sheet phases, and releases it
  when the fetch throws. A repeated sync skips the already-written session.
- Unassigned rows reconcile into later manual rows.
- Assign merges a pending manual row when appropriate; family claim follows the
  same merge contract and keeps the manual row's identity.
- Tesla 401/403 surfaces an actionable authorization-expired message; a 401
  clears the cached access token and retries once.
- Peak split: exact 16:00 and 23:00 boundaries, sessions entirely inside each
  period, sessions crossing one boundary, and sessions spanning multiple days.
- The split totals equal kWh within `1e-6`.
- Cost uses the correct month, applies rebate to both periods, falls back to
  the latest earlier rate, and returns unavailable when no rate exists.
- Rate parser fixtures cover the 2026-11 sentence, the monthly table with `*`
  markers, the tariff basic charges, and a reader output with extra navigation
  text.
- Rate refresh does not overwrite `manualOverride=TRUE`.
- CSV headers, BOM, CRLF, ordering, escaping, per-car filtering, and missing
  values.

### 14.2 Apps Script tests

- A Node harness runs pure `Logic.gs` functions against fixtures.
- Mock `SpreadsheetApp` tests cover header migration, append idempotency,
  delete-release behavior, assign merging, and sync counts.
- Mock Tesla responses cover success, no sessions, malformed session arrays,
  401, 412, 429, and network errors.
- Mock CLP responses cover direct 200, direct 403 followed by reader 200, parse
  failure, and a manual-override row.

### 14.3 UI integration

- jsdom tests import the real `app.js`, `family.js`, and `owner.js` modules and run them against the Apps Script VM served over HTTP, with fake Sheet data and mocked Tesla/CLP.
- Family coverage: load, start, auto-start from `start=1`, refusing a duplicate start while pending, re-enabling the button after match, sync a mocked Tesla session, delete, and claim an unassigned session.
- Owner UI: rate dedupe/refresh/source links, QR generation, latest-month-first rates with
  older months collapsed, one combined pending list, live charging card/estimate,
  assign, CSV export, 12-hour times, preserved open groups, and the
  initial 30-day Tesla import. Family-scoped sync without a manual start returns
  skipped.
- The tests use the production API/client modules; only browser APIs absent from jsdom are stubbed.

### 14.4 Browser smoke

- Family URL shows only its car and its records, plus unassigned Tesla
  sessions that it can claim.
- Owner URL shows all cars, unassigned sessions, and rates.
- Start adds a manual record; sync fills it from a mocked session.
- A forgotten start becomes unassigned; the family claims it, and the owner
  assign path still works.
- Delete releases a Tesla-linked session to `unassigned`; a second sync does
  not duplicate the row.
- Rate fallback and missing-rate warnings render.
- CSV download matches the selected car/month and includes the new columns.
- 390x844 layout has no horizontal scroll; owner table collapses to cards.

### 14.4 Live verification

- One real home session: start record, sync, matched kWh, split, and cost.
- One intentionally unassigned session: assign behavior.
- Rate refresh returns the current month's fuel adjustment and tariff values
  (2026-11: 47.4 and 94.5/137.5 at the time of writing).
- Family URL on a second device shows the same records.
- A fresh deployment preserves legacy rows and all Sheets tabs.

## 15. Setup and rollout

1. Update the Apps Script project with the new `.gs` files. Keep the existing
   deployment URL and publish a new version.
2. Add Script Properties: Sheet id, Tesla client id, client secret, refresh token,
   optional base URL/site id, optional match window, and optional
   `SYNC_FROM`. There is no owner key. Leave `SYNC_FROM` empty unless you
   intentionally want to backfill pre-launch sessions. `SYNC_CURSOR` is managed
   by the script.
3. Run the local refresh-token setup tool; copy the token into Script
   Properties without printing it.
4. Add at least one `Cars` row. Use URL-safe ids and display names.
5. Run `refreshRates` from the owner view. Confirm the current month's values
   (2026-11 at the time of writing). If the fetch fails, enter the current row
   manually and set `manualOverride=TRUE`.
6. Deploy the frontend update. The old no-parameter URL shows the setup
   message; distribute each family URL and the owner URL.
7. Verify one real session end to end before inviting the family to use it.
8. Rotate the exposed Tesla client secret after implementation is complete;
   update the local env file and Script Properties, then redeploy.

Rollout order:

1. Backend tabs, migration, and read APIs.
2. Tesla sync, matching, split, and tests.
3. Family view and CSV.
4. Owner view, assign, and family links.
5. Rate refresh and warnings.
6. Live verification.

No old Sheet rows are deleted at any step.

## 16. Risks and limitations

- Tesla cannot identify the car. Attribution depends on the family pressing
  start on the correct URL.
- A forgotten start becomes unassigned until the owner assigns it.
- The peak/off-peak split is an estimate because the API has no power curve.
  The owner's actual CLP bill may differ; future C reconciles it.
- `energy_added_wh` is the vehicle-side energy added. CLP's meter measures AC
  energy, so charging losses are not modeled in this version. The owner's bill
  remains the source of truth.
- Live charging kWh/cost is an estimate from the last 5-minute power sample; the
  completed Tesla session is authoritative. Live polling stops when no manual
  start is pending and is skipped while the page is hidden.
- The CLP pages are bot-protected. The reader fallback is a third-party
  dependency and can fail or change. Markup normalization and value validation
  handle the common shape changes, but a structural change still requires the
  owner to enter the `Rates` row manually with `manualOverride=TRUE`.
- The official fuel CSV is stale and is not used.
- Apps Script quotas and Tesla API rate limits apply. The on-demand design
  avoids polling.
- The initial owner sync imports the last 30 days as unassigned sessions.
  Family page loads do not initialize that window. Setting `SYNC_FROM` to an
  earlier date can create a larger unassigned queue; each sync is one Tesla
  telemetry request, not one request per session.
- The Tesla refresh token can expire or be revoked. The owner must re-run the
  setup tool.
- The owner mode and family URLs are unauthenticated; whoever holds the URL has
  its powers.
- The app is single-household and single-timezone. It assumes Hong Kong.
- Month grouping follows the session start; a session spanning a month
  boundary is billed to its start month. Future C can use the bill period.

## 17. References

- Original app design:
  `docs/superpowers/specs/2026-11-14-ev-charge-log-design.md`
- Tesla Fleet API energy endpoints:
  `https://developer.tesla.com/docs/fleet-api/endpoints/energy`
- CLP EV residential time-of-use tariff:
  `https://www.clp.com.hk/zh/emobility/bills-payment-tariffs-emobility/tariff-for-ev/ev-residential-tariff`
- CLP fuel adjustment charge:
  `https://www.clp.com.hk/zh/help-support/bills-payment-tariffs/fuel-cost-adjustment`
- CLP 2026 tariff table:
  `https://www.clp.com.hk/content/dam/clphk/documents/tariff-adjustment-2026/Tariff%20Table%20-%20Chinese_Update.pdf`
- CLP fuel adjustment CSV (stale; not used):
  `https://www.clp.com.hk/content/dam/clphk/images/1-17/1-17-3/1-17-3-5-fuel-cost-adjustment/FCA.csv`
- Local Tesla probe and diagnostic:
  `tools/tesla-probe.mjs`
