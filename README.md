# EV Charge Log

Per-car EV charging log with on-demand Tesla Wall Connector sync and CLP peak/off-peak cost estimates. A static app on GitHub Pages; a Google Apps Script Web App owns the Sheet, Tesla OAuth, and CLP rate fetch.

This repository is the application code. The deployed instance is for private family use; there is no public demo deployment. Replace `<your-user>` below with your own GitHub Pages account.

Deployment target (not live until the deployment step): `https://<your-user>.github.io/ev-charge-log/`

Deployment order: cut over the Apps Script backend before publishing the static frontend. Deploy the backend first, then merge/publish the frontend.

![Family view](docs/screenshot-family.png)

![Owner view](docs/screenshot-owner.png)

Both screenshots are real WKWebView captures of the family and owner views at a 390x844 viewport (2x), showing the live charging card. The family start button is disabled while a manual start is pending.

## How it works

- Each car has its own family URL: `https://<your-user>.github.io/ev-charge-log/?car=<car-id>`.
- A family member taps one button when charging starts. The start time is stored in the shared Google Sheet. A pending start disables the button until it is matched or deleted.
- The owner opens the owner URL (`?owner`), presses `更新充電樁`, and the Apps Script matches Tesla Wall Connector sessions to the manual start times.
- If a driver forgot to press start, the family view lists unassigned Tesla sessions and lets that driver claim the matching one. The owner can also assign unassigned sessions. Each car gets an estimated cost from the CLP EV residential time-of-use tariff.
- The family view never receives Tesla credentials. The owner view has no key or login; its URL is a mode flag.

## Features

- One-tap start recording with a per-car URL; no login and no car picker. While a manual start is pending, the start button is disabled and a QR auto-start does not create a second record. It re-enables after the session is matched or the pending record is deleted.
- On-demand Tesla sync; no scheduled background sync. The family page syncs once when it loads.
- Manual starts are matched to completed Tesla sessions when the start falls inside the session, up to `MATCH_EARLY_MINUTES` (default 120) before it, or up to `MATCH_LATE_MINUTES` (default 30) after it. If eligible manual starts belong to different cars, the session stays unassigned for manual resolution.
- Unmatched Tesla sessions appear as `unassigned` for the family or owner to assign.
- The family view shows unassigned Tesla sessions with a `認領` button, so a forgotten start can be recovered without entering a time. The latest 24 hours stay open; older sessions are grouped by month, then by day, and collapsed.
- Peak/off-peak split is estimated by session duration; Tesla does not expose a per-minute power curve.
- Monthly kWh and estimated cost per car; peak/off-peak split; CLP rate month and fallback warning.
- Recent records with start and end times, kWh, estimated cost, and real delete. Deleting a Tesla-linked record releases it back to `unassigned` for another car to claim. The end date is included when a session crosses midnight.
- Owner month totals, one `待配對` list that combines manual starts and unassigned charger sessions, rate cards (latest month first; older months collapsed), and copyable family links. Unassigned sessions keep the latest 24 hours open and collapse older months and days.
- UI times use 12-hour AM/PM; unassigned rows show both start and end times. CSV keeps 24-hour times.
- Month and day groups remember their open state after a claim or assign, so several sessions can be handled without reopening the groups.
- The family view shows the monthly summary first, then unassigned sessions, recent records, the same rate cards as the owner view, and export.
- Owner QR code per car: scanning it opens `?car=<id>&start=1` and records the start automatically, so no start button press is needed. The owner can download the QR and stick it next to the charger or car.
- Live charging card while a manual start is pending: Wall Connector state/power from Tesla, with an estimated kWh/cost counter that updates every second from the last 5-minute power sample. The final Tesla session replaces the estimate.
- CSV export for family and owner, with UTF-8 BOM, CRLF, and RFC 4180 escaping.
- Offline-friendly family queue; pending starts retry automatically.
- Mobile-first layout for a 390x844 viewport.

## Data model

The Google Sheet has three tabs. The script creates missing tabs and appends missing `Log` columns to the right; existing rows are never moved or deleted. An older deployment may still have an unused `Ignored` tab; it is no longer created, read, or written.

### `Log`

`id`, `startAt`, `日期`, `時間`, `car`, `kWh`, `durationSec`, `teslaStartAt`, `teslaEndAt`, `peakKWh`, `offPeakKWh`, `teslaKey`, `source`.

- `source`: `manual`, `tesla`, `tesla+manual`, or `legacy`.
- Old rows without `car` are `legacy`; they are preserved and excluded from billing CSV.
- Tesla session keys are `<din or target_id>:<start-seconds>`.
- Date-formatted `startAt`/Tesla cells are normalized to ISO; `日期` and `時間` are derived from `startAt` in Asia/Hong_Kong.

### `Cars`

`id`, `name`, `active`, `createdAt`.

- `id` matches `[a-z0-9-]{1,32}`.
- `unassigned` is reserved.
- Family URLs use this `id`.

### `Rates`

`month`, `basicOffPeak`, `basicPeak`, `fuelAdjustment`, `rebate`, `peakStart`, `peakEnd`, `sourceUrl`, `fetchedAt`, `manualOverride`.

- Values are HK cents per kWh.
- `manualOverride=TRUE` rows are never overwritten by the rate refresh.
- `sourceUrl` is a comma-separated list of the CLP pages used; the owner view renders each valid URL as a separate link.
- Google Sheets may store `month` as a date cell and `peakStart`/`peakEnd` as time cells; the API normalizes the month to `YYYY-MM` and formats times in `Asia/Hong_Kong` (not with a fixed offset, because the 1899 time-cell epoch predates modern HKT).
- The read path also dedupes duplicate month rows, preferring `manualOverride` then the latest `fetchedAt`.

## Billing

The app uses the CLP EV residential time-of-use tariff. In 2026 the peak window is 16:00–23:00 and non-peak is 23:00–16:00.

```text
offPeakRate = basicOffPeak + fuelAdjustment - rebate
peakRate    = basicPeak    + fuelAdjustment - rebate
cost        = offPeakKWh * offPeakRate / 100 + peakKWh * peakRate / 100
```

- Rates and times are HK cents/kWh and Asia/Hong_Kong.
- The split is proportional to session duration; it is an estimate.
- The 8-cent/kWh 2026 special fuel rebate is not inferred. Enter an eligible rebate in the `Rates` tab and set that row's `manualOverride` to `TRUE` so `更新費率` does not overwrite it.
- The actual CLP bill remains authoritative. Per-bill reconciliation is a future enhancement.

## One-time setup

### 1. Google Sheet and Apps Script

1. Open the existing Google Sheet. The Sheet is currently link-shared by the owner's choice; anyone with the link can read the log. Set General access to Restricted if you want it private. The family view never links to it.
2. Open Extensions -> Apps Script.
3. Replace `Code.gs` and create `Logic.gs`, `SheetRepo.gs`, `Tesla.gs`, and `Rates.gs` from [`apps-script/`](apps-script/).
4. Do not edit the code. The Sheet ID is a Script Property; add `SHEET_ID` in the next section.
5. Save the project.
6. Set the Script Properties in section 2, including `SHEET_ID`.
7. In the editor, select `setup` and Run once. It creates or verifies `Log`, `Cars`, and `Rates`, and checks `SHEET_ID`. Existing rows are preserved. `readLog_` alone only creates `Log`.
8. Deploy -> Manage deployments -> Edit -> Version: New version. Execute as: Me. Who has access: Anyone. The existing deployment URL stays the same.

`Code.gs` is the router: `doGet` serves status, family, and owner reads and `doPost` handles the actions. Status and Tesla telemetry fetches run outside the script lock; family/owner reads and every Sheet write hold it, because reads can migrate headers and writes are read-modify-write. Sync locks only the prepare and apply phases, not the Tesla request. This replaces the legacy fixed-position `Log` API; existing rows are migrated in place and never moved or deleted.

If your account or Workspace policy does not offer "Anyone" access, stop: this zero-login design requires it.

### 2. Script Properties

In Apps Script, Project Settings -> Script Properties:

| Property | Value |
| --- | --- |
| `SHEET_ID` | ID from the Sheet URL (`https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`) |
| `TESLA_CLIENT_ID` | Tesla developer app client ID |
| `TESLA_CLIENT_SECRET` | Tesla developer app client secret |
| `TESLA_REFRESH_TOKEN` | Refresh token from the local OAuth helper |
| `TESLA_BASE_URL` | `https://fleet-api.prd.na.vn.cloud.tesla.com` (optional; this is the default) |
| `TESLA_SITE_ID` | Observed Wall Connector energy site ID; optional, discovered automatically when omitted |
| `MATCH_EARLY_MINUTES` | `120` (manual start earlier than the Tesla session) |
| `MATCH_LATE_MINUTES` | `30` (manual start after the Tesla session ends) |
| `MATCH_WINDOW_MINUTES` | `30` (fallback when a session has no end time) |
| `SYNC_FROM` | Leave unset; only set for an intentional backfill |
| `SYNC_CURSOR` | Internal; do not set manually |

Never put these values in `config.js`, the Sheet, git, or a family link.

### 3. Tesla OAuth

Tesla API access is read-only for energy data. The app uses the official Fleet API with scopes `openid offline_access energy_device_data`.

1. The Tesla developer app needs both allowed origins: `https://<your-user>.github.io` for the deployed app and `http://localhost:8788` for the local probe. Its Allowed Redirect URI must include `http://localhost:8788/callback`.
2. The app also needs its EC public key hosted at the app origin's `.well-known/appspecific/com.tesla.3p.public-key.pem` path, and partner registration completed. The probe's setup text in `tools/tesla-probe.mjs` lists the exact commands.
3. On a machine with the repository and `tools/.env.tesla.local` (mode 600) containing `TESLA_CLIENT_ID` and `TESLA_CLIENT_SECRET`, run:

```bash
npm run auth:tesla
```

3. Authorize the app in the browser. The token is saved to `tools/.tesla-refresh-token.local` with mode 600.
4. Copy the token value into the `TESLA_REFRESH_TOKEN` Script Property. Do not print it, paste it into chat, or commit it.

The owner `更新充電樁` verification happens in the owner setup step, after the frontend is deployed.

Rotate the Tesla client secret after development and deployment are complete. Update `TESLA_CLIENT_SECRET` in Script Properties, then verify one sync.

### 4. Frontend

`config.js` contains only the Apps Script URL:

```js
window.APP_CONFIG = {
  API_URL: '<Apps Script Web app URL>',
};
```

Deploy the static files to GitHub Pages. The owner view gets its Sheet link from the owner API, which derives it from the `SHEET_ID` Script Property; the Sheet URL is not committed to the repository.

### 5. Cars, rates, and the owner URL

1. Add one row per car to `Cars`: `id`, `name`, `active`, `createdAt`. Use `TRUE` for active.
2. Open the owner URL on the deployed site: `https://<your-user>.github.io/ev-charge-log/?owner=1`.
3. Press `更新費率`; confirm the current month appears and the peak window is 16:00–23:00. If CLP changes the page format, enter or correct the row in `Rates` and set `manualOverride=TRUE`.
4. Run one owner `更新充電樁` and confirm the Wall Connector site is discovered.
5. Copy each family link from the owner view and send it to that car's driver.
6. Keep the owner URL private. The owner mode has no key or login; anyone with the URL can manage.

## Local development

```bash
npm test
PORT=8787 node test/dev-server.mjs
```

Open:

- Family: `http://127.0.0.1:8787/?car=model3`
- Owner: `http://127.0.0.1:8787/?owner=1`

The mock server seeds one matched session, one unassigned session, and one pending manual session, and reports a live 7.2 kW charging status.

Node 20+ is required for the built-in test runner (verified on v20.20.2). There are no runtime dependencies and no build step; `jsdom` is a test-only devDependency installed by `npm ci`.

## API

`GET`:

- `?car=<id>` returns `{ ok, car, records, unassigned, rates, serverTime }` for that car. `unassigned` is the list of unclaimed Tesla sessions.
- `?owner` returns `{ ok, cars, records, rates, serverTime }` for the owner.
- `?status=1` returns `{ ok, charging, powerW, energyWh, state, available, sampledAt }` from the Wall Connector live status. `energyWh` may be null.

`POST` with a `text/plain` JSON body:

- `{ action: 'append', id, car, startAt, date, time }`
- `{ action: 'delete', id, car }`
- `{ action: 'sync' }` (all cars) or `{ action: 'sync', car }`
- `{ action: 'assign', id, car }`
- `{ action: 'claim', car, id }` (family-scoped unassigned claim)
- `{ action: 'refreshRates' }`

The response envelope is `{ ok: true, ... }` or `{ ok: false, error }`. Apps Script returns HTTP 200 for API errors; the client checks `ok`.

## Security

- No accounts and no secrets in the frontend. The Apps Script URL and each family `?car=` URL are capabilities.
- Each family `?car=` URL is a capability: anyone who has it can append and delete that car's records and claim unassigned Tesla sessions to that car. Share it only with that car's driver.
- A car QR encodes the same family URL plus `start=1`; anyone who scans it can start a charge for that car. Treat the QR like the family link.
- The owner view is selected by `?owner` and has no key or login. Anyone who has the app URL and adds `?owner` can sync Tesla, refresh rates, assign sessions, and export. Keep the owner URL private; this is an accepted trade-off for a family-only app.
- Tesla credentials live only in Script Properties.
- The Sheet is link-shared as of the current owner choice; anyone with the link can read the log. The link is not in this repository: `SHEET_ID` is a Script Property and the owner API derives the link. Set General access to Restricted if you want it private.
- Family actions require a valid car ID; owner actions require only the Apps Script Web App URL.
- `index.html` uses `<meta name="referrer" content="no-referrer">`; owner external links use `rel="noreferrer"`.
- A leaked family URL allows that car's append/delete and claims. Remove the car from the `Cars` tab to stop the old link; existing records stay in the `Log`.
- A leaked Tesla secret or refresh token must be rotated. Rotate the client secret in the Tesla developer portal and replace `TESLA_CLIENT_SECRET`; revoke the app grant if a refresh token leaked.
- If the owner URL is exposed, create a new Apps Script deployment URL and update `config.js`; every family link keeps working after the frontend redeploy.

## Known limits

- Tesla cannot identify which car used the Wall Connector. Attribution is the per-car URL plus manual start.
- If a driver forgets to press start, the session becomes `unassigned`; the family can claim it or the owner can assign it.
- A manual start outside the session interval plus the early/late grace will not auto-match; use owner assign/claim or adjust `MATCH_EARLY_MINUTES` / `MATCH_LATE_MINUTES`.
- Peak/off-peak is duration-proportional, not measured per minute.
- The vehicle may report DC-side energy; the AC meter can differ.
- CLP page scraping is fragile. The parser normalizes markup and validates the values; if a fetch or parse fails, existing `Rates` stay unchanged and the owner is prompted to enter the row manually with `manualOverride=TRUE`.
- The live charging kWh/cost is an estimate from the last Wall Connector power sample; the completed Tesla session is authoritative. The card polls every 5 minutes while the page is visible (one Tesla call per poll) and interpolates every second.
- There is no cron, scheduled background sync, outside-charger support, CCTV integration, or bill reconciliation yet.
- `更新充電樁` on the owner view initializes the last 30 days as unassigned sessions when there is no cursor, `SYNC_FROM`, or manual start. Family page loads do not initialize that window. Each sync is one Tesla telemetry request, not one request per session.
- CSV is a snapshot; refresh it after new records.
- CSV content is unit-tested; the owner export button and toast were smoke-tested in WKWebView. File delivery in a normal browser is unverified until a live end-to-end run.

## Tests

```bash
npm test
```

The suite currently has 125 tests and covers frontend logic, API payloads, Apps Script logic, Sheet migration, Sheet date-cell coercion, Tesla token/session mapping, CLP parsers, rate validation, duplicate-rate handling, owner actions, family claims, early/late manual-start matching, QR auto-start URLs, duplicate-start refusal, delete-release behavior, lock scope, live charging estimates, 12-hour Hong Kong time, and the API envelope. Nine jsdom integration tests drive the real UI modules against the Apps Script VM with mocked Tesla, CLP, and Sheet data. Browser smoke tests are documented in the implementation plan.

CI: [`.github/workflows/test.yml`](.github/workflows/test.yml) runs `npm ci && npm test` on Node 20 for every push and pull request.

## License

Personal project; no license file.
