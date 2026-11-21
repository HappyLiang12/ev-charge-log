# CCTV Evidence, Matching, Feedback, and Remote Config Design

**Date:** 2026-11-21
**Status:** Draft for review
**Related:** `docs/superpowers/plans/2026-11-15-ev-charge-log-cctv-identification.md`, PR #27 (Pi relay), PR #28 (snapshot ingest + evidence)

## 1. Goal

Give every unassigned charging session a camera snapshot, a car suggestion with confidence, and a one-tap way to confirm or correct it. The system learns from those corrections without ever assigning a car automatically. The Tapo stays a wide-angle CCTV camera; the Pi crops a fixed charging-slot ROI for analysis. All tuning is remote: configuration lives in the Apps Script-backed Sheet, and the Pi applies changes on its next cycle without SSH or same-network access.

The household cars are:

| id | description (editable in Cars) | plate (user supplies later) |
| --- | --- | --- |
| `model3` | blue Tesla Model 3 sedan | to be entered in `Plates` |
| `vigo` | silver pickup | to be entered in `Plates` |
| `ix3` | champagne gold SUV | to be entered in `Plates` |

Guest cars (for example the white Mazda seen during the trial) are expected and must resolve to `unknown`/guest, never to a household car.

## 2. Non-goals

- No automatic car assignment. Every assignment is a human action.
- No local model training in this phase. Feedback is collected as labelled data for a future offline model.
- No full-frame snapshot storage. The Tapo keeps its own CCTV recording; only the cropped charging-slot image is uploaded.
- No family access to evidence images (family payloads keep omitting `evidenceUrl`).
- No camera PTZ, recording, or Tapo account changes from this system.
- No VPN or multi-network remote access.

## 3. Current State

- Pi relay is live: RTSP `stream1` (2560x1440), one JPEG every 5 minutes, HMAC upload, local queue, systemd, Cockpit admin.
- Apps Script v25 is live: signed snapshot ingest, Drive folder, `Snapshots` rows, `evidenceUrl` attached to new unassigned sessions.
- `Relay` uploads are verified; the Drive scope is authorized.
- The test camera currently points at a gym rack; production placement is pending.
- Plates and car descriptions are not filled yet.
- A partial draft exists on branch `feat/cctv-evidence-config` (uncommitted): feedback table, cleanup, owner/family evidence UI, Pi cleanup. It is input to this design, not an approved implementation. The time-based prior suggestion in that draft is removed by this design.

## 4. Architecture

```
Tapo C520WS (wide CCTV, own recording)
        │ RTSP stream1
        ▼
Pi 3B relay (no AI)
  ├─ every cycle: POST relayConfig (HMAC) → validate → apply next capture
  ├─ capture → crop ROI → scale → JPEG → HMAC snapshot upload
  ├─ failed uploads stay in local queue (bounded)
  └─ hourly: POST cleanup (HMAC, batched)
        │
        ▼
Apps Script Web App
  ├─ Config tab (key/value)        ← edited from Google Sheets / owner link
  ├─ Snapshot ingest → Drive (crop only) + Snapshots row
  ├─ Identify: plate OCR → optional VLM → unknown
  ├─ Feedback ledger + policy calibration
  ├─ Retention cleanup
  └─ owner/family payloads
        │
        ▼
Web app (owner + family)
  Owner: crop thumbnail + suggestion (engine, confidence) + adopt / manual / ignore / reassign
  Family: suggestion hint only (no image)
```

External providers:

- **Cloud Vision** for plate OCR (free 1,000 units/month; API key in Script Properties).
- **DeepSeek vision** for the optional VLM (a user-supplied API key in Script Properties; model id in the Config tab, `deepseek-flash`). Model availability in Hong Kong and image behavior must be verified with real crops before enabling.

## 5. Data Model

### Log (append columns)

- `suggestionEngine`: `plate`, `vlm`, or empty (manual/unknown).
- `suggestionSnapshotId`: the snapshot used for the suggestion, or empty.
- Existing suggestion fields remain: `evidenceUrl`, `suggestedCar`, `suggestionConfidence`, `suggestionPlate`, `suggestionStatus`, `identifiedAt`.

### Snapshots (append column)

- `crop`: the configured `relay.crop` value at ingest: an `x:y:w:h` ROI, empty, or `full` during a testing capture. `relay.crop=full` must be removed for production.

### Feedback (new tab)

`id`, `recordId`, `startAt`, `engine`, `suggestedCar`, `chosenCar`, `confidence`, `plate`, `snapshotId`, `lighting`, `actor`, `createdAt`.

- `engine`: `plate`, `vlm`, `manual` (no suggestion), or empty.
- `chosenCar`: an active car id or `guest` (ignored).
- `lighting`: `day` (07:00–19:00 HK) or `night`; an approximation from the session start, not a camera-mode signal.
- `actor`: `owner` or `family`.
- Feedback is append-only and retained beyond snapshot retention.

### Config (new tab)

`key`, `value`, `updatedAt`, `notes`. Non-secret tunables only. `setup()` seeds missing defaults.

### Ignored

`teslaKey`, `createdAt`, `actor`. Written when the owner ignores an unassigned session (chosen car `guest`). The Tesla key is retained after the Log row is deleted so the next sync does not re-import the ignored session.

### Cars (append column)

- `description`: a short visual description used in VLM prompts; falls back to `name` when empty.

### Plates

Unchanged (`plate`, `car`, `active`, `createdAt`). The user fills the three household plates; plate text is never committed to the repo.

## 6. Remote Config

### Source and editing

- The `Config` tab is the single source of tunables. It is editable from Google Sheets anywhere; the owner page already links to the Sheet. A dedicated owner settings panel can be added later and will write the same tab through an owner action.
- Secrets never go in the Config tab. `CLOUD_VISION_API_KEY` and `DEEPSEEK_API_KEY` live in Apps Script Project Settings → Script Properties.

### Keys

| key | applies to | type | default | range / allowed | effect |
| --- | --- | --- | --- | --- | --- |
| `relay.enabled` | Pi | bool | `true` | true/false | Pause captures/uploads; config polling and cleanup continue |
| `relay.intervalSeconds` | Pi | int | `300` | 60–3600 | Capture cadence |
| `relay.imageWidth` | Pi | int | `1920` | 640–2560 | Output width after crop |
| `relay.jpegQuality` | Pi | int | `3` | 2–10 | ffmpeg `-q:v` |
| `relay.crop` | Pi | string | empty | `x:y:w:h` in source pixels, or `full` | Charging-slot ROI; empty/invalid disables upload (fail closed); `full` is an explicit testing mode |
| `relay.captureTimeoutSeconds` | Pi | int | `30` | 10–120 | ffmpeg capture timeout |
| `relay.maxQueue` | Pi | int | `1000` | 100–5000 | Offline queue cap |
| `relay.cleanupIntervalSeconds` | Pi | int | `3600` | 600–86400 | Cleanup trigger cadence |
| `relay.cleanupBatch` | Pi | int | `500` | 10–1000 | Snapshots deleted per cleanup call |
| `snapshot.retentionDays` | Apps Script | int | `30` | 1–365 | Drive + Snapshots rows older than this are deleted |
| `snapshot.windowMinutes` | Apps Script | int | `10` | 1–60 | Snapshot search window around a session |
| `snapshot.candidateCount` | Apps Script | int | `3` | 1–5 | Max snapshots inspected per identification |
| `vision.engine` | Apps Script | enum | `plate` | `off`, `plate`, `plate+vlm` | Identification pipeline |
| `vision.minConfidence` | Apps Script | number | `0.8` | 0.5–0.99 | Minimum VLM confidence for a suggestion |
| `vision.maxPerSync` | Apps Script | int | `5` | 0–20 | Max sessions identified per owner sync |
| `vision.vlmModel` | Apps Script | string | empty | provider model id | Empty keeps the VLM disabled |
| `policy.minSamples` | Apps Script | int | `5` | 1–50 | Feedback samples before a precision gate applies |
| `policy.minPrecision` | Apps Script | number | `0.9` | 0.5–0.99 | VLM suggestions below this are suppressed |

`vision.engine=plate` is the default. Before switching to `plate+vlm`, fill `Plates` and `Cars.description` and set `CLOUD_VISION_API_KEY` (and the `DEEPSEEK_API_KEY` Script Property plus `vision.vlmModel=deepseek-flash` when the VLM is used); otherwise the added stage cannot resolve a car. With `vision.engine=plate+vlm` and an empty `vision.vlmModel` (or missing DeepSeek properties), the provider is unconfigured: when plate OCR cannot decide, the session is written with `suggestionStatus=error`, so the owner sees a provider failure rather than a silent suggestion.

### relayConfig endpoint

- `POST { action: 'relayConfig', at: <ISO>, signature: HMAC-SHA256(secret, "relayConfig\n" + at) }`.
- Reject a timestamp outside ±10 minutes, a bad signature, or a missing secret.
- Return only the `relay.*` values, parsed, clamped, plus an `updatedAt` (the newest Config row timestamp). No secrets, no Sheet IDs.
- The action runs under the script lock because header migration can write.

### Pi behavior

- At the start of every cycle, request the config. On success: validate locally, persist to `/var/lib/ev-relay/config.json` atomically, and apply from the next capture.
- On failure: use the persisted config, then the env bootstrap values. Capture/upload continues; the failure is logged once per change of error.
- `relay.enabled=false` skips capture/upload but keeps config polling and cleanup.
- Invalid values fall back to the last good value (or the default) and log a warning. A missing, empty, or invalid crop disables capture/upload and logs "crop required"; it never falls back to a full frame. `relay.crop=full` is the only explicit full-frame mode (testing).
- No restart or SSH is needed for any tunable; the next cycle applies it.
- The env file keeps bootstrap values: `RTSP_URL`, `API_URL`, `RELAY_HMAC_SECRET`, `QUEUE_DIR`. The Config tab overrides the tunables.

## 7. Crop Pipeline

- The Tapo remains wide for CCTV. The Pi captures `stream1`, applies `crop=w:h:x:y`, then `scale='min(imageWidth,iw)':-2`, then JPEG quality.
- Only the crop is uploaded and stored. Full frames remain in the Tapo's own recording.
- The ROI is fixed around the charging slot. Guest cars outside the ROI are excluded from analysis and storage.
- Production requires a configured ROI. If `relay.crop` is empty or invalid, the relay skips capture/upload and logs "crop required"; it does not fall back to a full frame. `relay.crop=full` is an explicit testing-only mode and must be changed before production.
- The ROI is configured after installation via `relay.crop`; verify with a test snapshot in the owner view/Drive; adjust the numbers if needed.
- The plate may still be outside the crop (for example a side-on Model 3). The visual engine and manual fallback cover that case.
- The crop string is stored on each Snapshots row for audit and future model training; the Feedback row also carries the snapshot id. The stored value is the configured `relay.crop` at ingest (an ROI, empty, or `full` during testing); remove `full` before production.

## 8. Matching Engine

### Interface

`identifySession_(record)` returns:

```
{ engine: 'plate'|'vlm'|'', car: <id>|'', confidence: <0..1>, plate: <normalized>|'',
  status: 'matched'|'unknown'|'rate_limited'|'error', snapshotId: <id>|'', reason: <text> }
```

The result is written to the Log suggestion fields; it never changes `car`.

### Candidate snapshots

- Take up to `snapshot.candidateCount` snapshots within ±`snapshot.windowMinutes` of `teslaStartAt || startAt`, nearest first.
- Plate OCR runs on each candidate until a unique match is found.
- The VLM inspects the closest candidate, and the second one only if the first returns unknown (bounded calls).

### Stage 1: plate OCR

- Cloud Vision `TEXT_DETECTION` on the crop; normalize with `normalizePlate_`; match active plates.
- Exactly one active plate match → suggestion `{engine:'plate', confidence:1}`.
- Zero or multiple matches → no plate suggestion; continue to stage 2.
- Provider errors/timeouts → `status:'error'` (or `rate_limited` on quota errors); the session remains manual.

### Stage 2: VLM

- Runs only when `vision.engine=plate+vlm`, `vision.vlmModel` is set, and the credentials exist.
- Prompt: "Identify the car parked in the charging slot. Choose exactly one of the active car ids, `guest`, or `unknown`. Only the car in the charging slot counts; ignore other parked cars. Return JSON `{carId, confidence, reason}`."
- Car descriptions come from `Cars.description` (fallback `name`); `guest` covers cars outside the household list; `unknown` covers unclear images.
- Reject unknown car ids, inactive cars, and non-JSON responses. Require `confidence >= vision.minConfidence` and the policy gate. Otherwise `unknown`.
- Errors → `status:'error'`; no car suggestion.
- VLM suggestions are always shown with human confirmation; never auto-assign.

### Stage 3: manual

- The owner UI always provides the car select and an ignore action.
- If no suggestion exists (plate/VLM unknown, provider off, or policy-suppressed), the UI shows the crop and "未能辨識，請人手選擇".

### Policy gate

- Compute precision per `(engine, car, lighting)` from Feedback, counting only suggestions that named a car (not guest/unknown).
- When samples ≥ `policy.minSamples` and precision < `policy.minPrecision`, suppress that combination's VLM suggestions (fall back to unknown/manual) until the data improves.
- Plate suggestions are deterministic and are not suppressed; owner plate corrections update the mapping (plate-map tuning is owner-only; a family claim records feedback only).
- This is the Phase A "self-tuning": policy calibration, not model-weight updates.

### Lighting

- `day` = 07:00–19:00 HK; `night` otherwise, derived from the session start. Stored in Feedback for policy buckets.
- The camera's actual IR/spotlight mode is not exposed; treat `lighting` as an approximation.

### Triggering

- Owner sync and the owner `identify` action run the pipeline for unassigned sessions, bounded by `vision.maxPerSync`.
- Family requests never call Vision/VLM and never receive evidence URLs.
- A second identify is skipped when the record already has a `matched` or `unknown` result unless the owner forces it.

## 9. Feedback and Self-Tuning

### Recording

Every human decision appends Feedback:

| action | chosenCar | notes |
| --- | --- | --- |
| owner assign | car id | Compare against the Log suggestion |
| family claim | car id | Actor=`family`; feedback only, never rewrites `Plates` |
| owner reassign | car id | Corrects an assigned record; actor=`owner` |
| owner ignore | `guest` | Requires an explicit confirmation; removes the Log row from billing; the Tesla key is persisted in `Ignored` so later syncs skip it; feedback retained |

When the record has no stored suggestion, the engine at decision time is `manual` (no prior guess is invented).

### Effects

- **Plate corrections:** if the suggestion had a plate and the chosen car differs, an owner action upserts `Plates[plate] = chosenCar` immediately. Plate-map tuning is owner-only: a family claim still appends its Feedback row with the suggested/chosen/plate data, but never writes `Plates` (a mistaken family claim must not change OCR for every car).
- **Dataset:** every row records engine, suggestion, actual, confidence, snapshot id, lighting, actor, crop. This is the labelled set for a future offline model.
- **Policy:** precision buckets drive the suppression policy above.
- **No weight updates** happen in Phase A.

### Reassign

- Owner-only action for assigned records. It updates the Log car, recomputes the peak/off-peak split with the new car's `peakFactor`, records Feedback comparing the original suggestion/engine to the chosen car, and updates the plate mapping when applicable.
- A family claim that was wrong is corrected the same way.

## 10. UI

### Owner

- Pending unassigned rows:
  - Crop thumbnail (Drive thumbnail URL derived from `evidenceUrl`) with an image link fallback.
  - Suggestion label with engine and confidence: `建議：Model 3（98%，車牌）` or `（84%，視覺）`, plus an adopt button.
  - Manual car select + assign.
  - `非家中車輛（忽略）` action (records `guest`); it asks for confirmation first because the Log row is deleted and cannot be restored from the UI.
  - No suggestion: `未能辨識，請人手選擇` (or `辨識失敗，請人手選擇` on provider error).
- Assigned records: a compact evidence link and a reassign control.
- Existing owner/family layout, accessibility labels, responsive styles are reused.

### Family

- Unassigned rows show `系統建議係你（NN%），請認領` when the suggestion matches the family car.
- No evidence image, no evidence URL, no engine details.

## 11. Retention

- `snapshot.retentionDays` (default 30) controls Drive files and Snapshots rows.
- The Pi triggers cleanup hourly with `relay.cleanupIntervalSeconds`; each call deletes up to `relay.cleanupBatch` expired snapshots, oldest first, then removes their Snapshots rows.
- The cleanup request is HMAC-signed (`cleanup\n<at>`); the server validates the timestamp and signature. No ScriptApp trigger is used, avoiding a new OAuth scope and the six-minute execution limit.
- Feedback and Log rows are retained. Snapshot rows disappear after retention, so old Log `evidenceUrl` values become stale links; this is accepted.
- Estimated storage: a 1920px crop at q3 is roughly 300–450 KB; 288 snapshots/day ≈ 90–130 MB/day; 30 days ≈ 3–4 GB. The account currently has about 62 GB free.
- Cleanup failures log and retry on the next hourly trigger; the operation is idempotent. A partial failure is not a config error: after a successful response the Pi logs `cleanup deleted: <n> failed: <m>` and, when `failed > 0`, one warning line, so a stalled retention is visible on the Pi rather than only in Apps Script.

## 12. Security and Privacy

- Only the crop is uploaded; the full CCTV stream/frame never leaves the LAN by default. `relay.crop=full` is an explicit testing-only exception.
- Drive stays private; no public links; family payloads omit `evidenceUrl`.
- Snapshot/cleanup/config requests use HMAC-SHA256 with a timestamp window; snapshot ingest also enforces body/image limits, JPEG magic, and idempotency.
- Vision credentials and the DeepSeek API key live in Script Properties, never in the Sheet or repo. The Config tab holds non-secret tunables only.
- VLM output is restricted to active car ids plus `guest`/`unknown`; low confidence becomes unknown.
- Human confirmation is mandatory; no auto-assign exists.

## 13. Testing

- Unit:
  - Config parsing/clamping and the `relayConfig` signature.
  - Crop filter construction and fallback.
  - Plate OCR normalization/matching and Vision error statuses.
  - VLM prompt/response validation, confidence, and policy suppression.
  - Feedback recording, plate upsert, precision buckets.
  - Reassign split recalculation.
  - Retention batch deletion.
  - Owner/family UI rendering (thumbnail, suggestion, adopt, manual, ignore; family hint, no evidence).
- Relay tests: config fetch payload/parse/persist, crop command, cleanup payload.
- Integration: a config change in the Config tab is visible in the next relay config response; owner/family payload behavior; retention.
- E2E (after deployment): the Pi applies a changed interval/crop without restart; snapshots upload; one session is identified via plate OCR or VLM; an owner correction updates the plate map/policy.
- Shadow evaluation: at least 20 real sessions covering day/night and a guest car. Record precision per engine. VLM stays suggestion-only; the 95% precision threshold remains a future auto-assign gate.

## 14. Rollout

1. **Phase 0 (physical, user):** install/aim the camera at the charging slot; capture day and night frames; fill the three plates; fill car descriptions; determine the ROI string; confirm the guest car stays outside the ROI.
2. **Phase A (code):** implement remote config, crop, UI, feedback, retention, plate OCR, VLM adapter (providers off), with tests. Open PR, merge, deploy Apps Script v26, update the Pi relay via `ev-relay-update`, seed the Config tab.
3. **Phase B (configuration):** fill `Plates` and `Cars.description` and set the Cloud Vision key first; set `relay.crop`; verify the next snapshot is cropped; run `identify` on a session; then enable `vision.engine=plate` (the default). Only after that, add the `DEEPSEEK_API_KEY` Script Property and `vision.vlmModel`, verify the model with a real crop, and enable `plate+vlm`. An empty `vision.vlmModel` with `plate+vlm` surfaces a provider error status on undecided sessions; it is not a silent fallback.
4. **Phase C (evaluation):** run at least 20 sessions; review precision and unknown rates; keep human confirmation; consider a local model only if the free VLM is insufficient.

## 15. Open Setup Items

- The user will enter the three plates in `Plates` and visual descriptions in `Cars.description`.
- Cloud Vision API key and billing account (free tier) in Script Properties.
- DeepSeek API key in Script Properties if the VLM is used; verify `deepseek-flash` availability and image behavior in Hong Kong with real crops.
- ROI coordinates after installation, entered in the Config tab.
- Confirm the guest/ignore semantics and the desired default retention period (30 days).

## 16. Risks

- Plates are often not visible (side-on cars); the VLM and manual paths are required, not optional.
- Night images may lose colour (IR); shape and plate readability vary.
- A free VLM may be unavailable, rate-limited, or too inaccurate in Hong Kong; the plate path and manual fallback must remain healthy.
- Guest cars in the slot (rare) and outside the ROI (expected) can still produce unknown/guest cases.
- Human feedback is assumed correct; a mistyped correction can suppress or alter mappings. The Feedback audit makes corrections traceable.
- An invalid crop/config can degrade captures; validation and fallbacks protect availability.
- Snapshot storage grows with the interval; retention and the crop size are the main controls.

## 17. Decisions Log

- Keep the Tapo wide-angle for CCTV; crop a fixed charging-slot ROI on the Pi for analysis and storage.
- Plate OCR first; a free VLM is the visual fallback; manual confirmation is mandatory.
- Do not rely on plate visibility; do not auto-assign.
- Remove the time-of-day prior suggestion from the earlier draft.
- Collect feedback labels; tune policy thresholds automatically; defer model training.
- Remote config via the Config tab and a signed `relayConfig` pull; no SSH or same-network requirement for tuning.
- Retention is 30 days by default, enforced by the Pi's hourly batched cleanup.
- The user supplies plates later; they are never committed to the repo.
