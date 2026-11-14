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
- Keep Tesla credentials and the owner key server-side.
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
| Owner access | Owner-key URL, not a real login |
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
Owner URL ?owner=<key>┘         │
                                │ GET/POST (text/plain)
                                ▼
                      Google Apps Script Web App
                         │          │          │
                         ▼          ▼          ▼
                    Google Sheet  Tesla     CLP pages
                    Log/Cars/     Fleet     (direct, then
                    Rates/Ignored API       reader fallback)
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
| `style.css` | Existing dark theme plus owner/family additions |
| `config.js` | Public `API_URL` and `SHEET_URL` only |
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
  id: string;                 // UUID, or tesla-<startSeconds>
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
  `id='tesla-<startSeconds>'`, and `startAt` equal to the Tesla start.
- Legacy rows have `source='legacy'` and blank new fields. They are not
  billed and are never shown to family URLs.
- `kWh` and the split are stored as numbers. Cost is not stored; it is
  computed from the rate table.

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
| `sourceUrl` | Official CLP page(s) used, comma-separated |
| `fetchedAt` | ISO timestamp of the last successful fetch |
| `manualOverride` | `TRUE` means the automatic fetch must not overwrite this row |

`rebate` is subtracted from both peak and non-peak rates. The owner sets it
when eligible. The fetch must not infer eligibility.

### 7.4 Ignored session

`Ignored` tab columns:

| Column | Meaning |
|---|---|
| `teslaKey` | The ignored session key |
| `ignoredAt` | ISO timestamp |
| `reason` | Optional text |

A key in this tab is skipped by every future sync. Removing the row allows the
session to be imported again on the next sync.

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

Tabs `Cars`, `Rates`, and `Ignored` are created with their headers when
missing. The script does not seed car or rate values; the owner populates them
or runs the rate refresh.

### 7.6 Timezone

All billing dates, months, peak periods, and CSV dates use
`Asia/Hong_Kong`. Device timezone is not used for billing. The existing
device-local display helpers are replaced by Hong Kong helpers so that month
boundaries and rate selection are deterministic.

## 8. URLs and identity

- Family: `https://<site>/ev-charge-log/?car=<id>`.
- Owner: `https://<site>/ev-charge-log/?owner=<key>`.
- No parameter or an invalid parameter: a setup message explaining how to get
  the correct link; no records are loaded.
- If both parameters are present, the owner view wins and the car parameter is
  ignored.
- The family URL is the car's capability. Anyone with it can add and delete
  that car's records. The owner shares each URL only with the relevant family
  member.
- The owner key is 48 hex characters generated by the owner with
  `openssl rand -hex 24`. It is stored in Apps Script Script Properties and
  never in `config.js`, the repo, the Sheet, or the family URL.
- The owner view builds and displays each family URL for copying. It must not
  include the owner key in those copied URLs.

## 9. Tesla integration

### 9.1 Server-side configuration

Apps Script Script Properties:

| Property | Purpose |
|---|---|
| `TESLA_CLIENT_ID` | Tesla app client ID |
| `TESLA_CLIENT_SECRET` | Tesla app client secret |
| `TESLA_REFRESH_TOKEN` | OAuth refresh token |
| `TESLA_BASE_URL` | Default `https://fleet-api.prd.na.vn.cloud.tesla.com` |
| `TESLA_SITE_ID` | Optional; otherwise auto-discovered |
| `OWNER_KEY` | Owner capability key |
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
- Otherwise: the earliest manual record's `startAt` minus 2 days. If no manual
  record exists, return without fetching. This prevents a first sync from
  importing the entire 90-day history as unassigned sessions.

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
- `windowMs = MATCH_WINDOW_MINUTES * 60 * 1000`.
- A manual candidate is a row with `source='manual'`, a non-empty `car` other
  than `unassigned`, `kWh` empty, and `teslaKey` empty.

Sync order, inside one script lock:

1. Read `Log`, `Cars`, and `Ignored`.
2. Determine the fetch lower bound from `SYNC_CURSOR`, `SYNC_FROM`, or the
   earliest manual record, as described in 9.5. If no bound exists, return
   with zero counts without fetching or updating `SYNC_CURSOR`.
3. Fetch and normalize all eligible Tesla sessions in the range.
4. Reconcile existing unassigned rows with newly created manual rows:
   for every `source='tesla'` row with `car='unassigned'`, find the nearest
   manual candidate for any car whose `startAt` is within the window. If one
   exists, copy kWh, duration, Tesla timestamps, split, and `teslaKey` into the
   manual row, change its source to `tesla+manual`, and delete the unassigned
   row. This handles a family member pressing start after an earlier sync.
5. For every Tesla session whose `teslaKey` is in `Ignored`, skip it.
6. For every Tesla session whose `teslaKey` already exists in `Log`, skip it.
7. For the remaining sessions, choose the nearest manual candidate within the
   window. If one exists, fill it and keep its id, car, and manual startAt.
8. If no candidate exists, append an unassigned row.
9. After the sync completes without throwing, set `SYNC_CURSOR` to the fetch
   end time.
10. Return counts: `matched`, `unassigned`, `skippedExisting`,
    `skippedIgnored`, `reconciled`, and `pendingManual`.
11. `pendingManual` counts manual rows that still have no kWh.

No partial writes occur if the Tesla fetch fails. Parsing and validation finish
before the first Sheet write. Every write is under `LockService` with a 30
second wait.

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
3. Parse the current fuel adjustment sentence:
   `(\d{4})年(\d{1,2})月1日起，燃料調整費為每度電([\d.]+)港仙`.
4. Parse the current year's monthly fuel adjustment table, stripping `*`
   markers. Do not infer or apply any special rebate.
5. Parse the tariff page's current non-peak and peak basic charges (94.5 and
   137.5 at the time of writing) next to their Chinese labels. Parse the time
   windows when possible; otherwise keep the existing defaults.
6. Upsert one `Rates` row per month. Skip rows whose `manualOverride` is
   `TRUE`.
7. Set `sourceUrl` and `fetchedAt` on rows written by the fetch.
8. If any page or parse fails, leave existing rows unchanged and return an
   error. The app shows the error and the last successful `fetchedAt`.

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
  "rates": [Rate],
  "serverTime": "2026-11-14T14:00:00.000Z"
}
```

Only records whose `car` equals the requested car are returned. Unassigned and
legacy rows are not returned.

`GET ?owner=<key>` returns:

```json
{
  "ok": true,
  "cars": [Car],
  "records": [SessionRecord],
  "rates": [Rate],
  "serverTime": "2026-11-14T14:00:00.000Z"
}
```

All records, including unassigned and legacy rows, are returned. Invalid or
missing parameters return
`{ "ok": false, "error": "..." }`.

### 11.2 POST actions

| Action | Body | Authorization | Result |
|---|---|---|---|
| `append` | `{ id, car, startAt, date, time }` | Valid active car | Idempotent by id |
| `delete` | `{ id, car }` or `{ id, ownerKey }` | Car owns row, or owner | Deletes row; ignores its `teslaKey` first |
| `sync` | `{ car }` or `{ ownerKey }` | Valid car or owner | Runs matching; returns counts |
| `assign` | `{ ownerKey, id, car }` | Owner | Assigns an unassigned row; merges a pending manual row when possible |
| `ignore` | `{ ownerKey, id }` | Owner | Adds `teslaKey` to `Ignored` and deletes the row |
| `refreshRates` | `{ ownerKey }` | Owner | Fetches and upserts rates |

Validation:

- Record ids match `[A-Za-z0-9-]{1,64}`.
- Car ids match `[a-z0-9-]{1,32}` and exist with `active=TRUE`;
  `unassigned` is reserved.
- `startAt` parses as a date; `date` is `YYYY-MM-DD`; `time` is `HH:mm`.
- `ownerKey` must equal `OWNER_KEY`.
- Unknown actions return `{ ok: false, error: "invalid action" }`.
- Missing rows and repeated deletes are idempotent.

`append` always sets `source='manual'` server-side; the client cannot set a
source. It recomputes `date` and `time` in Asia/Hong_Kong from `startAt` and
rejects supplied values that do not match. `delete` adds the row's `teslaKey`
to `Ignored` before removing the row when the key is present. This prevents a
deleted Tesla session from returning on the next sync.

`assign` behavior:

1. Validate the target car.
2. If the row is unassigned and a pending manual row for the target car exists
   within the matching window, copy the Tesla fields into the manual row,
   change its source to `tesla+manual`, and delete the unassigned row.
3. Otherwise set the unassigned row's `car` to the target car.

`ignore` requires a non-empty `teslaKey`; use `delete` for a non-Tesla row.
All writes use `LockService`; sync waits up to 30 seconds for the lock.

## 12. UI

### 12.1 Family view

Shown for `?car=<id>`.

- Header: `EV 充電紀錄`, car name, status chip, and no Sheet link.
- Primary action: `⚡ 開始充電`, full width. It records the current time for
  this car and shows a toast.
- Secondary action: `更新 Tesla`. It calls `sync`, shows a spinner, and
  reports `已配對 X 個 session`.
- After the initial record load, the family view runs one sync automatically
  when online. The button allows a manual retry. There is no polling.
- Summary cards: current-month session count, total kWh, estimated cost.
  A smaller line shows the peak/off-peak kWh split and the rate month.
- Recent list: date, weekday, time, kWh, estimated cost, delete button.
  A record without kWh shows `待配對` and `—` for cost.
- Delete confirmation for a Tesla-linked record warns that the Tesla session
  will also be ignored.
- Month selector and `匯出 CSV`; default month follows the existing behavior.
- Rate note: `按 CLP <month> 費率估算；實際電費以中電賬單為準`.
- If no rate exists at or before the month, show `未設定費率` and no cost. If
  an earlier rate is used, show the fallback warning.
- Loading states for initial load, start, sync, and delete.
- Offline behavior: cached records render; new starts queue in the per-car
  pending queue; sync and rate actions show an offline error.

### 12.2 Owner view

Shown for `?owner=<key>`.

- Header: `EV 充電紀錄 — 管理`.
- Actions: `更新 Tesla`, `更新費率`, `打開 Google Sheet`.
- Month selector for the per-car table; default current month.
- Per-car monthly table: car name, sessions, kWh, non-peak kWh, peak kWh,
  estimated cost. Legacy rows are counted separately and excluded from totals.
- Unassigned list: Tesla start, kWh, duration, car selector, `分配`, `忽略`.
- Pending manual list: car, startAt, `等待 Tesla 配對`.
- Rates table: month, non-peak rate, peak rate, fuel adjustment, rebate,
  source, fetchedAt, manual override. Read-only; edit in the Sheet.
- Family link per car with a copy button. Links never contain the owner key.
- Empty states: no cars configured, no rates configured, no unassigned
  sessions.
- Loading and error states for sync, rate refresh, assign, and ignore.
- The owner key is kept in memory from the URL; it is not written to
  localStorage, logs, or copied family links.
- `index.html` sets `<meta name="referrer" content="no-referrer">` and
  owner-view external links use `rel="noreferrer"` so the key is not leaked
  through the Referer header.

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

- The family app never receives Tesla credentials or the owner key.
- Tesla credentials live only in Apps Script Script Properties.
- The Sheet is the owner's private store. The family view does not link to it.
  The owner must keep the Sheet's sharing restricted; the public family app
  must not expose the Sheet URL.
- The Apps Script URL and each family URL are capabilities. Anyone with a
  family URL can add or delete that car's records. This matches the existing
  no-login model; the household trusts its members.
- The owner key is a capability, not authentication. A leaked key exposes all
  records and owner actions. Rotate `OWNER_KEY` if it leaks.
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
- Ignored keys are skipped.
- Unassigned rows reconcile into later manual rows.
- Assign merges a pending manual row when appropriate.
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
  delete/ignore behavior, assign merging, and sync counts.
- Mock Tesla responses cover success, no sessions, malformed session arrays,
  401, 412, 429, and network errors.
- Mock CLP responses cover direct 200, direct 403 followed by reader 200, parse
  failure, and a manual-override row.

### 14.3 Browser smoke

- Family URL shows only its car and its records.
- Owner URL shows all cars, unassigned sessions, and rates.
- Start adds a manual record; sync fills it from a mocked session.
- A forgotten start becomes unassigned; assign moves it to a car.
- Delete ignores the Tesla key; a second sync does not recreate the row.
- Rate fallback and missing-rate warnings render.
- CSV download matches the selected car/month and includes the new columns.
- 390x844 layout has no horizontal scroll; owner table collapses to cards.

### 14.4 Live verification

- One real home session: start record, sync, matched kWh, split, and cost.
- One intentionally unassigned session: assign and ignore behavior.
- Rate refresh returns the current month's fuel adjustment and tariff values
  (2026-11: 47.4 and 94.5/137.5 at the time of writing).
- Family URL on a second device shows the same records.
- A fresh deployment preserves legacy rows and all Sheets tabs.

## 15. Setup and rollout

1. Update the Apps Script project with the new `.gs` files. Keep the existing
   deployment URL and publish a new version.
2. Add Script Properties: Tesla client id, client secret, refresh token,
   optional base URL/site id, owner key, optional match window, and optional
   `SYNC_FROM`. Leave `SYNC_FROM` empty unless you intentionally want to
   backfill pre-launch sessions. `SYNC_CURSOR` is managed by the script.
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
4. Owner view, assign/ignore, and family links.
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
- The CLP pages are bot-protected. The reader fallback is a third-party
  dependency and can fail or change. Manual override is mandatory for billing
  confidence.
- The official fuel CSV is stale and is not used.
- Apps Script quotas and Tesla API rate limits apply. The on-demand design
  avoids polling.
- Pre-launch sessions are not imported by default. The first sync starts two
  days before the earliest manual record. Setting `SYNC_FROM` to an earlier
  date can create a large unassigned queue.
- The Tesla refresh token can expire or be revoked. The owner must re-run the
  setup tool.
- The owner key and family URLs are capabilities, not authentication.
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
