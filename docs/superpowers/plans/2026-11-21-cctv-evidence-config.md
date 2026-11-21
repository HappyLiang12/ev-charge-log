# CCTV Evidence, Feedback, and Remote Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI-assisted (plate OCR + free VLM) snapshot evidence for unassigned sessions, human-confirmed car matching, a feedback loop that calibrates suggestions, 30-day retention, and remotely tunable Pi capture settings — all without SSH or same-network access.

**Architecture:** The Pi uploads only a cropped charging-slot JPEG and pulls a signed `relayConfig` at the start of every cycle. Apps Script stores tunables in a `Config` tab, ingests snapshots, runs plate OCR then an optional Cloudflare VLM, records every human decision in `Feedback`, and uses feedback precision to suppress bad suggestions. The owner UI shows the crop, engine, confidence, adopt/manual/ignore/reassign controls; the family UI sees only a suggestion hint, never the image.

**Tech Stack:** Google Apps Script V8 (Code.gs, SheetRepo.gs, Logic.gs, Tesla.gs, Rates.gs, new Vision.gs), Google Sheets/Drive, Cloud Vision, Cloudflare Workers AI (optional), Python 3 standard library + ffmpeg on the Pi, static ES modules, Node 20 test runner, WKWebView/jsdom UI harness.

**Spec:** `docs/superpowers/specs/2026-11-21-cctv-evidence-feedback-design.md`

## Global Constraints

- **No auto-assign.** Every car assignment is a human action; suggestions are pre-selections only.
- **Fail-closed crop.** Only a configured crop is uploaded; `relay.crop` empty/invalid disables capture/upload. `relay.crop=full` is an explicit testing-only mode and must not be used in production.
- **Family payloads never contain `evidenceUrl`** or image data.
- **Remote tunables live in the `Config` tab** (non-secret only), default 30-day retention, and are applied by the Pi on its next cycle with no SSH/restart.
- **Secrets live only in Apps Script Script Properties** (`CLOUD_VISION_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) and in `/etc/ev-relay/relay.env` on the Pi (mode 600). Never commit or print them, and never put them in the Config tab.
- **HMAC everywhere:** `snapshot`, `cleanup`, and `relayConfig` requests use HMAC-SHA256 with a ±10-minute timestamp window.
- **Retention:** default 30 days (`snapshot.retentionDays`), enforced by the Pi's hourly batched cleanup; no ScriptApp daily trigger.
- **Plates and personal data** are supplied by the user in the Sheet and never committed to the repo.
- **Do not modify** the untracked file `docs/superpowers/plans/2026-11-15-ev-charge-log-cctv-identification.md`.
- **Workflow:** user merges PRs; do not push or merge without explicit approval. Keep `npm test` green and `npm run test:relay` green.
- **Config keys/ranges** are exactly the table in spec §6; defaults: interval 300, imageWidth 1920, jpegQuality 3, crop empty, timeout 30, maxQueue 1000, cleanupInterval 3600, cleanupBatch 500, retentionDays 30, windowMinutes 10, candidateCount 3, engine `plate`, minConfidence 0.8, maxPerSync 5, vlmModel empty, policy.minSamples 5, policy.minPrecision 0.9.

---

## File Structure

- `apps-script/SheetRepo.gs` — Config/Snapshots/Feedback/Plates/Cars repositories and schema.
- `apps-script/Code.gs` — `relayConfig`, `identify`, `reassign`, feedback recording, cleanup action, owner/family payloads.
- `apps-script/Vision.gs` (new) — plate OCR, VLM adapter, candidate selection, policy gate, `identifySession_`.
- `apps-script/Logic.gs` — pure helpers (`lightingFor_`, plate normalization, candidate selection).
- `owner.js`, `family.js`, `style.css` — owner evidence/suggestion/manual/ignore/reassign UI; family hint only.
- `tools/relay/tapo_relay.py` — config pull/cache/apply, crop capture, cleanup trigger, queue.
- `tools/relay/test_relay.py`, `test/apps-script-*.test.mjs`, `test/integration-ui.test.mjs` — tests.
- `tools/relay/relay.env.example`, `tools/relay/README.md`, `README.md` — setup and runbook.

---

### Task 0: Preserve the Draft and Start Clean

**Files:**
- No source changes.

**Interfaces:**
- Produces: `feat/cctv-evidence-config` at the spec commit; `wip/cctv-evidence-draft` holding the uncommitted draft for reference.

- [ ] **Step 1: Confirm the current branch and draft files**

Run:
```bash
git branch --show-current
git status --short
```
Expected: branch `feat/cctv-evidence-config`, spec commit present, modified draft files listed.

- [ ] **Step 2: Commit the draft to a local WIP branch**

Run:
```bash
git switch -c wip/cctv-evidence-draft
git add apps-script/Code.gs apps-script/SheetRepo.gs family.js owner.js style.css \
  test/apps-script-api.test.mjs test/fake-apps-script.mjs \
  tools/relay/tapo_relay.py tools/relay/test_relay.py
git commit -m "wip: cctv evidence and feedback draft"
git switch feat/cctv-evidence-config
```
Expected: the WIP branch holds the draft; `feat/cctv-evidence-config` has a clean working tree (the untracked plan doc remains untouched).

- [ ] **Step 3: Confirm the feature branch is clean**

Run: `git status --short`
Expected: only the pre-existing untracked 2026-11-15 plan doc.

---

### Task 1: Remote Config Storage and `relayConfig`

**Files:**
- Modify: `apps-script/SheetRepo.gs`
- Modify: `apps-script/Code.gs`
- Modify: `test/fake-apps-script.mjs`
- Modify: `test/apps-script-api.test.mjs`
- Modify: `tools/relay/tapo_relay.py`
- Modify: `tools/relay/test_relay.py`

**Interfaces:**
- Produces: `CONFIG_COLUMNS`, `CONFIG_DEFAULTS`, `readConfigMap_()`, `configValue_()`, `relayConfigAction_(data)`, `ensureConfigDefaults_()`.
- Produces: `POST {action:'relayConfig', at, signature}` → `{ok:true, config:{...}, updatedAt}`.
- Produces (Python): `build_relay_config_payload(at, secret)`, `validate_relay_config(raw, fallback)`, `load_cached_config(path, fallback)`, `save_cached_config(path, config)`.

- [ ] **Step 1: Write failing config tests**

Add to `test/apps-script-api.test.mjs`:
```js
const CONFIG_HEADER = ['key', 'value', 'updatedAt', 'notes'];

function relayConfigBody(at = new Date().toISOString(), secret = SNAPSHOT_SECRET) {
  return {
    action: 'relayConfig',
    at,
    signature: crypto.createHmac('sha256', secret).update('relayConfig\n' + at).digest('hex'),
  };
}

test('relayConfig returns defaults, applies overrides, and clamps values', () => {
  const env = setup({
    props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET },
    sheets: {
      Config: [
        CONFIG_HEADER,
        ['relay.intervalSeconds', '120', '', ''],
        ['relay.imageWidth', '99999', '', ''],
        ['snapshot.retentionDays', '45', '', ''],
        ['vision.engine', 'plate+vlm', '', ''],
      ],
    },
  });
  const result = send(env, relayConfigBody());
  assert.equal(result.ok, true);
  assert.equal(result.config['relay.intervalSeconds'], 120);
  assert.equal(result.config['relay.imageWidth'], 2560);
  assert.equal(result.config['relay.crop'], '');
  assert.equal(result.config['relay.enabled'], true);
  assert.equal(result.config['snapshot.retentionDays'], undefined);
  assert.equal(result.config['vision.engine'], undefined);
});

test('relayConfig rejects a bad signature and an old timestamp', () => {
  const env = setup({ props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET } });
  const bad = relayConfigBody();
  bad.signature = '00';
  assert.equal(send(env, bad).ok, false);
  assert.match(send(env, bad).error, /signature/i);
  const old = relayConfigBody('2026-11-01T00:00:00.000Z');
  assert.equal(send(env, old).ok, false);
  assert.match(send(env, old).error, /timestamp/i);
});

test('setup seeds the Config tab with defaults', () => {
  const env = setup();
  env.call('setup');
  const rows = env.values('Config');
  assert.equal(rows[0][0], 'key');
  assert.ok(rows.some((row) => row[0] === 'relay.intervalSeconds' && row[1] === '300'));
  assert.ok(rows.some((row) => row[0] === 'snapshot.retentionDays' && row[1] === '30'));
});
```

Add relay tests in `tools/relay/test_relay.py`:
```python
from tapo_relay import build_relay_config_payload, validate_relay_config


class RelayConfigTest(unittest.TestCase):
    def test_config_payload_is_signed(self):
        at = "2026-11-21T05:00:00Z"
        payload = build_relay_config_payload(at, "secret")
        self.assertEqual(payload["action"], "relayConfig")
        self.assertEqual(
            payload["signature"],
            hmac.new(b"secret", ("relayConfig\n" + at).encode(), hashlib.sha256).hexdigest(),
        )

    def test_validate_config_clamps_and_defaults(self):
        cfg = validate_relay_config({
            "relay.intervalSeconds": 10,
            "relay.imageWidth": 99999,
            "relay.crop": "bad",
            "relay.enabled": False,
        }, {})
        self.assertEqual(cfg["relay.intervalSeconds"], 60)
        self.assertEqual(cfg["relay.imageWidth"], 2560)
        self.assertEqual(cfg["relay.crop"], "")
        self.assertEqual(cfg["relay.enabled"], False)
        self.assertEqual(cfg["relay.jpegQuality"], 3)
```

- [ ] **Step 2: Run tests to verify failure**

Run:
```bash
node --test test/apps-script-api.test.mjs
npm run test:relay
```
Expected: FAIL (unknown action/functions).

- [ ] **Step 3: Add the Config repository**

Append to `apps-script/SheetRepo.gs`:
```js
var CONFIG_COLUMNS = ['key', 'value', 'updatedAt', 'notes'];
var CONFIG_DEFAULTS = {
  'relay.enabled': 'true',
  'relay.intervalSeconds': '300',
  'relay.imageWidth': '1920',
  'relay.jpegQuality': '3',
  'relay.crop': '',
  'relay.captureTimeoutSeconds': '30',
  'relay.maxQueue': '1000',
  'relay.cleanupIntervalSeconds': '3600',
  'relay.cleanupBatch': '500',
  'snapshot.retentionDays': '30',
  'snapshot.windowMinutes': '10',
  'snapshot.candidateCount': '3',
  'vision.engine': 'plate',
  'vision.minConfidence': '0.8',
  'vision.maxPerSync': '5',
  'vision.vlmModel': '',
  'policy.minSamples': '5',
  'policy.minPrecision': '0.9',
};

function readConfigMap_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Config', CONFIG_COLUMNS);
  var map = {};
  var latest = '';
  var rows = readObjects_(sheet, CONFIG_COLUMNS);
  for (var i = 0; i < rows.length; i += 1) {
    var key = String(rows[i].key || '').trim();
    if (!key) continue;
    map[key] = String(rows[i].value === undefined || rows[i].value === null ? '' : rows[i].value).trim();
    var at = isoValue_(rows[i].updatedAt);
    if (at && at > latest) latest = at;
  }
  return { values: map, updatedAt: latest || new Date().toISOString() };
}

function configValue_(key) {
  var map = readConfigMap_().values;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : CONFIG_DEFAULTS[key];
}

function ensureConfigDefaults_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Config', CONFIG_COLUMNS);
  var rows = readObjects_(sheet, CONFIG_COLUMNS);
  var existing = {};
  for (var i = 0; i < rows.length; i += 1) existing[String(rows[i].key || '').trim()] = true;
  var now = new Date().toISOString();
  for (var key in CONFIG_DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key) || existing[key]) continue;
    sheet.appendRow([key, CONFIG_DEFAULTS[key], now, 'default']);
  }
}
```

- [ ] **Step 4: Add parsing helpers and `relayConfigAction_` to Code.gs**

Insert after `cleanupAction_`:
```js
var CONFIG_INT_LIMITS_ = {
  'relay.intervalSeconds': [60, 3600],
  'relay.imageWidth': [640, 2560],
  'relay.jpegQuality': [2, 10],
  'relay.captureTimeoutSeconds': [10, 120],
  'relay.maxQueue': [100, 5000],
  'relay.cleanupIntervalSeconds': [600, 86400],
  'relay.cleanupBatch': [10, 1000],
  'snapshot.retentionDays': [1, 365],
  'snapshot.windowMinutes': [1, 60],
  'snapshot.candidateCount': [1, 5],
  'vision.maxPerSync': [0, 20],
  'policy.minSamples': [1, 50],
};

function configRaw_(map, key, fallback) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

function configBool_(map, key, fallback) {
  var raw = String(configRaw_(map, key, fallback)).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function configInt_(map, key, fallback) {
  var limits = CONFIG_INT_LIMITS_[key];
  var number = Number(configRaw_(map, key, fallback));
  if (!isFinite(number)) number = fallback;
  number = Math.round(number);
  if (!limits) return number;
  return Math.min(Math.max(number, limits[0]), limits[1]);
}

function configNumber_(map, key, fallback, min, max) {
  var number = Number(configRaw_(map, key, fallback));
  if (!isFinite(number)) number = fallback;
  return Math.min(Math.max(number, min), max);
}

function configCrop_(map) {
  var raw = String(configRaw_(map, 'relay.crop', '') || '').trim();
  if (raw === 'full') return 'full';
  if (!/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/.test(raw)) return '';
  var parts = raw.split(':').map(Number);
  if (parts[2] <= 0 || parts[3] <= 0) return '';
  return raw;
}

function relayConfigAction_(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_HMAC_SECRET');
  if (!secret) throw new Error('Missing RELAY_HMAC_SECRET');
  if (!validIso_(data.at)) throw new Error('Invalid config timestamp');
  if (Math.abs(Date.now() - Date.parse(data.at)) > SNAPSHOT_MAX_AGE_MS_) throw new Error('Config timestamp outside window');
  var expected = hmacHex_('relayConfig\n' + String(data.at), secret);
  if (String(data.signature || '') !== expected) throw new Error('Invalid signature');
  var read = readConfigMap_();
  var map = read.values;
  var config = {
    'relay.enabled': configBool_(map, 'relay.enabled', true),
    'relay.intervalSeconds': configInt_(map, 'relay.intervalSeconds', 300),
    'relay.imageWidth': configInt_(map, 'relay.imageWidth', 1920),
    'relay.jpegQuality': configInt_(map, 'relay.jpegQuality', 3),
    'relay.crop': configCrop_(map),
    'relay.captureTimeoutSeconds': configInt_(map, 'relay.captureTimeoutSeconds', 30),
    'relay.maxQueue': configInt_(map, 'relay.maxQueue', 1000),
    'relay.cleanupIntervalSeconds': configInt_(map, 'relay.cleanupIntervalSeconds', 3600),
    'relay.cleanupBatch': configInt_(map, 'relay.cleanupBatch', 500),
  };
  return { config: config, updatedAt: read.updatedAt };
}
```

Add routing in `doPost` next to `cleanup`:
```js
else if (action === 'relayConfig') result = relayConfigAction_(data);
```

Call `ensureConfigDefaults_()` at the start of `setup()`:
```js
function setup() {
  ensureConfigDefaults_();
  var cars = readCars_();
```

- [ ] **Step 5: Run API tests**

Run: `node --test test/apps-script-api.test.mjs`
Expected: PASS.

- [ ] **Step 6: Add the Pi config client**

Add to `tools/relay/tapo_relay.py`:
```python
import re

RELAY_CONFIG_DEFAULTS = {
    "relay.enabled": True,
    "relay.intervalSeconds": 300,
    "relay.imageWidth": 1920,
    "relay.jpegQuality": 3,
    "relay.crop": "",
    "relay.captureTimeoutSeconds": 30,
    "relay.maxQueue": 1000,
    "relay.cleanupIntervalSeconds": 3600,
    "relay.cleanupBatch": 500,
}
RELAY_CONFIG_LIMITS = {
    "relay.intervalSeconds": (60, 3600),
    "relay.imageWidth": (640, 2560),
    "relay.jpegQuality": (2, 10),
    "relay.captureTimeoutSeconds": (10, 120),
    "relay.maxQueue": (100, 5000),
    "relay.cleanupIntervalSeconds": (600, 86400),
    "relay.cleanupBatch": (10, 1000),
}


def build_relay_config_payload(at, secret):
    return {
        "action": "relayConfig",
        "at": at,
        "signature": sign(secret, "relayConfig\n" + at),
    }


def validate_relay_config(raw, fallback):
    config = dict(RELAY_CONFIG_DEFAULTS)
    for key, value in (fallback or {}).items():
        if key in config:
            config[key] = value
    if not isinstance(raw, dict):
        return config
    if isinstance(raw.get("relay.enabled"), bool):
        config["relay.enabled"] = raw["relay.enabled"]
    for key, limits in RELAY_CONFIG_LIMITS.items():
        if key not in raw:
            continue
        try:
            number = int(round(float(raw[key])))
        except (TypeError, ValueError):
            continue
        config[key] = max(limits[0], min(limits[1], number))
    crop = str(raw.get("relay.crop", "") or "").strip()
    if crop == "full":
        config["relay.crop"] = "full"
    elif re.fullmatch(r"[0-9]+:[0-9]+:[0-9]+:[0-9]+", crop):
        parts = [int(part) for part in crop.split(":")]
        config["relay.crop"] = crop if parts[2] > 0 and parts[3] > 0 else ""
    else:
        config["relay.crop"] = ""
    return config


def load_cached_config(path, fallback):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return validate_relay_config(json.load(handle), fallback)
    except (OSError, ValueError):
        return validate_relay_config({}, fallback)


def save_cached_config(path, config):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(config, separators=(",", ":")), encoding="utf-8")
    temp.replace(path)
```

- [ ] **Step 7: Run relay tests**

Run: `npm run test:relay`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps-script/SheetRepo.gs apps-script/Code.gs test/apps-script-api.test.mjs tools/relay/tapo_relay.py tools/relay/test_relay.py
git commit -m "feat: add remote relay config"
```

---

### Task 2: Crop Capture and Fail-Closed Behavior

**Files:**
- Modify: `tools/relay/tapo_relay.py`
- Modify: `tools/relay/test_relay.py`
- Modify: `tools/relay/relay.env.example`

**Interfaces:**
- Produces: `parse_crop(value) -> (tuple|None, bool full_mode)`, `build_capture_command(rtsp_url, output_path, width, quality, crop, full_mode)`, `capture_frame(...)`, `CropRequired`.
- Consumes: `validate_relay_config` from Task 1.

- [ ] **Step 1: Write failing capture tests**

Append to `tools/relay/test_relay.py`:
```python
from tapo_relay import CropRequired, build_capture_command, build_cleanup_payload, parse_crop


class RelayCropTest(unittest.TestCase):
    def test_parse_crop_modes(self):
        self.assertEqual(parse_crop("10:20:800:600"), ((10, 20, 800, 600), False))
        self.assertEqual(parse_crop("full"), (None, True))
        self.assertEqual(parse_crop(""), (None, False))
        self.assertEqual(parse_crop("bad"), (None, False))
        self.assertEqual(parse_crop("0:0:0:600"), (None, False))

    def test_capture_command_crops_and_scales(self):
        command = build_capture_command("rtsp://cam", "/tmp/a.jpg", 1280, 5, (10, 20, 800, 600), False)
        joined = " ".join(command)
        self.assertIn("crop=800:600:10:20", joined)
        self.assertIn("scale='min(1280,iw)':-2", joined)
        self.assertIn("-q:v 5", joined)

    def test_capture_requires_crop(self):
        with self.assertRaises(CropRequired):
            build_capture_command("rtsp://cam", "/tmp/a.jpg", 1280, 5, None, False)

    def test_full_mode_is_explicit(self):
        command = build_capture_command("rtsp://cam", "/tmp/a.jpg", 1280, 5, None, True)
        self.assertNotIn("crop=", " ".join(command))


class RelayCleanupPayloadTest(unittest.TestCase):
    def test_cleanup_payload_is_signed(self):
        at = "2026-11-21T05:00:00Z"
        payload = build_cleanup_payload(at, "secret", 300)
        self.assertEqual(payload["action"], "cleanup")
        self.assertEqual(payload["at"], at)
        self.assertEqual(payload["limit"], 300)
        expected = hmac.new(
            b"secret", ("cleanup\n" + at).encode("utf-8"), hashlib.sha256
        ).hexdigest()
        self.assertEqual(payload["signature"], expected)
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test:relay`
Expected: FAIL (missing names).

- [ ] **Step 3: Implement crop capture**

Replace the existing `capture_frame` in `tools/relay/tapo_relay.py`:
```python
class CropRequired(RuntimeError):
    pass


def parse_crop(value):
    text = str(value or "").strip()
    if text == "full":
        return None, True
    match = re.fullmatch(r"([0-9]+):([0-9]+):([0-9]+):([0-9]+)", text)
    if not match:
        return None, False
    x, y, width, height = [int(part) for part in match.groups()]
    if width <= 0 or height <= 0:
        return None, False
    return (x, y, width, height), False


def build_capture_command(rtsp_url, output_path, width, quality, crop, full_mode):
    if not crop and not full_mode:
        raise CropRequired("relay.crop is not configured")
    filters = []
    if crop:
        x, y, crop_width, crop_height = crop
        filters.append(f"crop={crop_width}:{crop_height}:{x}:{y}")
    filters.append(f"scale='min({int(width)},iw)':-2")
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-frames:v", "1", "-vf", ",".join(filters),
        "-q:v", str(int(quality)), "-an", "-y", str(output_path),
    ]


def capture_frame(rtsp_url, output_path, width=1920, quality=3, crop=None, full_mode=False, timeout_seconds=30):
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    cmd = build_capture_command(rtsp_url, output_path, width, quality, crop, full_mode)
    subprocess.run(cmd, check=True, timeout=max(10, int(timeout_seconds)))
    return Path(output_path)


def build_cleanup_payload(at, secret, limit=500):
    return {
        "action": "cleanup",
        "at": at,
        "limit": int(limit),
        "signature": sign(secret, "cleanup\n" + at),
    }
```

- [ ] **Step 4: Use the config in `main()`**

Replace the capture/upload block and add config polling at the top of the loop:
```python
    cache_path = queue.parent / "config.json"
    fallback = {
        "relay.enabled": True,
        "relay.intervalSeconds": int(os.environ.get("INTERVAL_SECONDS", "300")),
        "relay.imageWidth": int(os.environ.get("IMAGE_WIDTH", "1920")),
        "relay.jpegQuality": int(os.environ.get("JPEG_QUALITY", "3")),
        "relay.crop": os.environ.get("CROP", ""),
        "relay.captureTimeoutSeconds": int(os.environ.get("CAPTURE_TIMEOUT_SECONDS", "30")),
        "relay.maxQueue": int(os.environ.get("MAX_QUEUE", "1000")),
        "relay.cleanupIntervalSeconds": int(os.environ.get("CLEANUP_INTERVAL_SECONDS", "3600")),
        "relay.cleanupBatch": int(os.environ.get("CLEANUP_BATCH", "500")),
    }
    config = load_cached_config(cache_path, fallback)
    last_cleanup = 0.0
    while True:
        if env["API_URL"]:
            at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            try:
                result = post_json(env["API_URL"], build_relay_config_payload(at, env["RELAY_HMAC_SECRET"]), timeout=30)
                if not result.get("ok"):
                    raise RuntimeError(result.get("error") or "config rejected")
                config = validate_relay_config(result.get("config") or {}, config)
                save_cached_config(cache_path, config)
            except Exception as error:
                print("config error:", error, flush=True)
        if not config["relay.enabled"]:
            time.sleep(config["relay.intervalSeconds"])
            continue
        crop, full_mode = parse_crop(config["relay.crop"])
        if not crop and not full_mode:
            print("crop required: set relay.crop in the Config tab", flush=True)
            time.sleep(config["relay.intervalSeconds"])
            continue
        captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        image_path = queue / ("pending-" + str(int(time.time())) + ".jpg")
        try:
            capture_frame(
                env["RTSP_URL"], image_path, config["relay.imageWidth"], config["relay.jpegQuality"],
                crop, full_mode, config["relay.captureTimeoutSeconds"],
            )
            width, height = probe_size(image_path)
            if env["API_URL"]:
                payload = build_payload(image_path.read_bytes(), captured_at, width, height, env["RELAY_HMAC_SECRET"])
                result = post_json(env["API_URL"], payload)
                if not result.get("ok"):
                    raise RuntimeError(result.get("error") or "snapshot rejected")
                image_path.unlink(missing_ok=True)
        except Exception as error:
            print("relay error:", error, flush=True)
        if env["API_URL"]:
            now_ts = time.time()
            if now_ts - last_cleanup >= config["relay.cleanupIntervalSeconds"]:
                try:
                    at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                    cleanup = build_cleanup_payload(at, env["RELAY_HMAC_SECRET"], config["relay.cleanupBatch"])
                    result = post_json(env["API_URL"], cleanup, timeout=120)
                    if not result.get("ok"):
                        raise RuntimeError(result.get("error") or "cleanup rejected")
                    print("cleanup deleted:", result.get("deleted"), flush=True)
                    last_cleanup = now_ts
                except Exception as error:
                    print("cleanup error:", error, flush=True)
        try:
            prune_queue(queue, config["relay.maxQueue"])
        except Exception as error:
            print("queue error:", error, flush=True)
        time.sleep(config["relay.intervalSeconds"])
```
The cleanup uses `build_cleanup_payload` from the existing relay module. The first loop runs cleanup immediately after the first capture (last_cleanup starts at 0).

- [ ] **Step 5: Update the env template**

In `tools/relay/relay.env.example`, replace the fixed tunables with bootstrap values and a comment:
```bash
RTSP_URL=rtsp://CAMERA_USER:CAMERA_PASS@CAMERA_IP:554/stream1
API_URL=
RELAY_HMAC_SECRET=replace-with-openssl-rand-hex-32
QUEUE_DIR=/var/lib/ev-relay/queue
# Capture tunables now come from the Apps Script Config tab.
# Bootstrap fallbacks only:
INTERVAL_SECONDS=300
IMAGE_WIDTH=1920
JPEG_QUALITY=3
CROP=
CAPTURE_TIMEOUT_SECONDS=30
MAX_QUEUE=1000
CLEANUP_INTERVAL_SECONDS=3600
CLEANUP_BATCH=500
```

- [ ] **Step 6: Run relay tests and commit**

Run: `npm run test:relay`
Expected: PASS.

```bash
git add tools/relay/tapo_relay.py tools/relay/test_relay.py tools/relay/relay.env.example
git commit -m "feat: crop and config-driven capture"
```

---

### Task 3: Schema for Crop, Engines, Feedback, and Descriptions

**Files:**
- Modify: `apps-script/SheetRepo.gs`
- Modify: `apps-script/Logic.gs`
- Modify: `apps-script/Code.gs`
- Modify: `test/apps-script-sheet.test.mjs`
- Modify: `test/apps-script-logic.test.mjs`
- Modify: `test/apps-script-api.test.mjs`

**Interfaces:**
- Produces: `SNAPSHOTS_COLUMNS` with `crop`; `LOG_COLUMNS` with `suggestionEngine`, `suggestionSnapshotId`; `FEEDBACK_COLUMNS` with `engine`, `snapshotId`, `lighting`; `CARS_COLUMNS` with `description`.
- Produces: `lightingFor_(iso)`, `readFeedback_()`, `appendFeedback_()`, `deleteSnapshots_()`.

- [ ] **Step 1: Write failing schema/lighting tests**

Add to `test/apps-script-logic.test.mjs`:
```js
test('lightingFor_ classifies HK day and night', () => {
  assert.equal(call('lightingFor_', '2026-11-21T04:00:00.000Z'), 'day');   // 12:00 HK
  assert.equal(call('lightingFor_', '2026-11-21T13:00:00.000Z'), 'night'); // 21:00 HK
});
```

Add to `test/apps-script-sheet.test.mjs`:
```js
test('feedback keeps guest choices and engine metadata', () => {
  const env = createEnv({});
  env.call('appendFeedback_', {
    id: 'fb-1', recordId: 'u-1', startAt: '2026-11-21T04:00:00.000Z', engine: 'vlm',
    suggestedCar: 'model3', chosenCar: 'guest', confidence: 0.84, plate: '',
    snapshotId: 'snap-1', lighting: 'day', actor: 'owner', createdAt: '2026-11-21T04:01:00.000Z',
  });
  assert.equal(plain(env.call('readFeedback_')).length, 1);
  assert.equal(plain(env.call('readFeedback_'))[0].chosenCar, 'guest');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/apps-script-logic.test.mjs test/apps-script-sheet.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Add the schema and helpers**

In `apps-script/SheetRepo.gs`:
```js
var LOG_COLUMNS = [
  'id', 'startAt', '日期', '時間', 'car', 'kWh', 'durationSec',
  'teslaStartAt', 'teslaEndAt', 'peakKWh', 'offPeakKWh', 'teslaKey', 'source',
  'evidenceUrl', 'suggestedCar', 'suggestionConfidence', 'suggestionPlate',
  'suggestionStatus', 'identifiedAt', 'suggestionEngine', 'suggestionSnapshotId',
];
var SNAPSHOTS_COLUMNS = [
  'id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height',
  'bytes', 'source', 'createdAt', 'crop',
];
var FEEDBACK_COLUMNS = [
  'id', 'recordId', 'startAt', 'engine', 'suggestedCar', 'chosenCar',
  'confidence', 'plate', 'snapshotId', 'lighting', 'actor', 'createdAt',
];
var CARS_COLUMNS = ['id', 'name', 'active', 'createdAt', 'peakFactor', 'description'];
```
Extend `normalizeLogRow_` with:
```js
    suggestionEngine: String(row.suggestionEngine || '').trim(),
    suggestionSnapshotId: String(row.suggestionSnapshotId || '').trim(),
```
Extend `normalizeCarRow_` with:
```js
    description: String(row.description || '').trim(),
```
Update `readSnapshots_` to include `crop: String(row.crop || '').trim()`; `readFeedback_` to the new columns and filter:
```js
function readFeedback_() {
  var sheet = sheetNamed_(openSpreadsheet_(), 'Feedback', FEEDBACK_COLUMNS);
  return readObjects_(sheet, FEEDBACK_COLUMNS).map(function (row) {
    return {
      id: String(row.id || '').trim(),
      recordId: String(row.recordId || '').trim(),
      startAt: isoValue_(row.startAt) || '',
      engine: String(row.engine || '').trim(),
      suggestedCar: String(row.suggestedCar || '').trim(),
      chosenCar: String(row.chosenCar || '').trim(),
      confidence: numberOrNull_(row.confidence),
      plate: normalizePlate_(row.plate),
      snapshotId: String(row.snapshotId || '').trim(),
      lighting: String(row.lighting || '').trim(),
      actor: String(row.actor || '').trim(),
      createdAt: isoValue_(row.createdAt) || '',
    };
  }).filter(function (row) {
    return row.recordId && (row.chosenCar === 'guest' || validCarId_(row.chosenCar));
  });
}
```
Add to `apps-script/Logic.gs`:
```js
function lightingFor_(iso) {
  var at = Date.parse(iso);
  if (isNaN(at)) return '';
  var local = new Date(at + 8 * 3600 * 1000);
  var hour = local.getUTCHours();
  return hour >= 7 && hour < 19 ? 'day' : 'night';
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/apps-script-logic.test.mjs test/apps-script-sheet.test.mjs test/apps-script-api.test.mjs`
Expected: PASS. Update existing fixtures that deep-equal header arrays or record shapes (add the new columns/fields with empty values) if they fail.

- [ ] **Step 5: Commit**

```bash
git add apps-script/SheetRepo.gs apps-script/Logic.gs apps-script/Code.gs \
  test/apps-script-sheet.test.mjs test/apps-script-logic.test.mjs test/apps-script-api.test.mjs
git commit -m "feat: add evidence engine and feedback schema"
```

---

### Task 4: Plate OCR, Free VLM, Policy, and Identify

**Files:**
- Create: `apps-script/Vision.gs`
- Modify: `apps-script/Code.gs`
- Modify: `test/fake-apps-script.mjs`
- Create: `test/apps-script-vision.test.mjs`
- Modify: `test/apps-script-api.test.mjs`

**Interfaces:**
- Consumes: `readConfigMap_`, `readPlates_`, `readSnapshots_`, `readFeedback_`, `nearestSnapshot_`/candidate selection, `updateLog_`.
- Produces: `visionEngine_()`, `plateIdentify_(imageBase64)`, `vlmIdentify_(imageBase64, cars)`, `selectCandidateSnapshots_(record, snapshots)`, `policyAllowsSuggestion_(engine, car, lighting)`, `identifySession_(record, force)`, `identifyPending_()`, `identifyAction_(data)`.

- [ ] **Step 1: Write failing Vision tests**

Create `test/apps-script-vision.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppsScriptEnv } from './fake-apps-script.mjs';

function setupVision({ props = {}, fetch, sheets = {} } = {}) {
  return createAppsScriptEnv({
    props: { CLOUD_VISION_API_KEY: 'key-1', CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'token', ...props },
    sheets: {
      Config: [
        ['key', 'value', 'updatedAt', 'notes'],
        ['vision.vlmModel', '@cf/test/vision-model', '', ''],
      ],
      ...sheets,
    },
    fetch,
  });
}

test('plate OCR returns the mapped car for a unique plate match', () => {
  const env = setupVision({
    fetch: (url) => {
      if (!url.includes('vision.googleapis.com')) throw new Error(`Unexpected URL: ${url}`);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        responses: [{ textAnnotations: [{ description: 'AB 1234\nHONG KONG' }] }],
      }) };
    },
  });
  const result = env.call('plateIdentify_', 'base64', [
    { plate: 'AB1234', car: 'model3', active: true },
    { plate: 'CD5678', car: 'ix3', active: true },
  ]);
  assert.equal(result.status, 'matched');
  assert.equal(result.car, 'model3');
  assert.equal(result.engine, 'plate');
  assert.equal(result.confidence, 1);
});

test('VLM low confidence and guest become unknown', () => {
  const env = setupVision({
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
      result: { response: '{"carId":"guest","confidence":0.99,"reason":"white mazda"}' },
    }) }),
  });
  const cars = [{ id: 'model3', name: 'Model 3', description: 'blue Tesla Model 3' }];
  const result = env.call('vlmIdentify_', 'base64', cars, 0.8);
  assert.equal(result.status, 'unknown');
  assert.equal(result.car, '');
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test test/apps-script-vision.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement Vision.gs**

Create `apps-script/Vision.gs`:
```js
function visionEngine_() {
  return String(configValue_('vision.engine') || 'plate').toLowerCase();
}

function normalizeOcrText_(text) {
  return String(text || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function matchPlate_(ocrText, plates) {
  var text = normalizeOcrText_(ocrText);
  var matches = [];
  for (var i = 0; i < plates.length; i += 1) {
    var plate = normalizePlate_(plates[i].plate);
    if (plate && text.indexOf(plate) !== -1) matches.push(plates[i]);
  }
  return matches.length === 1 ? matches[0] : null;
}

function cloudVisionText_(imageBase64) {
  var key = scriptProperty_('CLOUD_VISION_API_KEY');
  if (!key) throw new Error('Missing CLOUD_VISION_API_KEY');
  var response = UrlFetchApp.fetch(
    'https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(key),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        requests: [{ image: { content: imageBase64 }, features: [{ type: 'TEXT_DETECTION', maxResults: 1 }] }],
      }),
      muteHttpExceptions: true,
    },
  );
  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status === 429) throw new Error('rate_limited');
  if (status < 200 || status >= 300) throw new Error('Cloud Vision ' + status + ': ' + body);
  var parsed = JSON.parse(body);
  var annotation = parsed.responses && parsed.responses[0]
    && parsed.responses[0].textAnnotations && parsed.responses[0].textAnnotations[0];
  return annotation ? String(annotation.description || '') : '';
}

function plateIdentify_(imageBase64, plates) {
  try {
    var text = cloudVisionText_(imageBase64);
    var match = matchPlate_(text, plates);
    if (!match) return { engine: 'plate', car: '', confidence: 0, plate: '', status: 'unknown', reason: 'No unique plate match' };
    return { engine: 'plate', car: match.car, confidence: 1, plate: match.plate, status: 'matched', reason: 'Plate match' };
  } catch (error) {
    var message = String(error.message || error);
    return { engine: 'plate', car: '', confidence: 0, plate: '', status: message === 'rate_limited' ? 'rate_limited' : 'error', reason: message };
  }
}

function vlmIdentify_(imageBase64, cars, minConfidence) {
  try {
    var account = scriptProperty_('CLOUDFLARE_ACCOUNT_ID');
    var token = scriptProperty_('CLOUDFLARE_API_TOKEN');
    var model = String(configValue_('vision.vlmModel') || '');
    if (!account || !token || !model) throw new Error('VLM provider is not configured');
    var choices = cars.filter(function (car) { return car.active; }).map(function (car) {
      return car.id + ' = ' + (car.description || car.name);
    }).join('; ');
    var prompt = 'Identify the car parked in the charging slot. Choose exactly one: '
      + choices + '; guest = any other car; unknown = unclear. Only the car in the charging slot counts; ignore other parked cars. '
      + 'Return JSON only: {"carId":"<id>","confidence":0..1,"reason":"<short>"}';
    var response = UrlFetchApp.fetch(
      'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(account)
        + '/ai/run/' + model.split('/').map(encodeURIComponent).join('/'),
      {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ prompt: prompt, image: Utilities.base64Decode(imageBase64) }),
        muteHttpExceptions: true,
      },
    );
    var status = response.getResponseCode();
    var body = response.getContentText();
    if (status < 200 || status >= 300) throw new Error('VLM ' + status + ': ' + body);
    var parsed = JSON.parse(body);
    var text = parsed.result && parsed.result.response ? parsed.result.response : '';
    var data = JSON.parse(text);
    var carId = String(data.carId || '');
    var confidence = Number(data.confidence);
    var valid = cars.some(function (car) { return car.active && car.id === carId; });
    if (!valid || carId === 'guest' || carId === 'unknown' || !isFinite(confidence) || confidence < minConfidence) {
      return { engine: 'vlm', car: '', confidence: isFinite(confidence) ? confidence : 0, plate: '', status: 'unknown', reason: String(data.reason || 'not confident') };
    }
    return { engine: 'vlm', car: carId, confidence: confidence, plate: '', status: 'matched', reason: String(data.reason || '') };
  } catch (error) {
    return { engine: 'vlm', car: '', confidence: 0, plate: '', status: 'error', reason: String(error.message || error) };
  }
}

function selectCandidateSnapshots_(record, snapshots) {
  var config = readConfigMap_().values;
  var count = configInt_(config, 'snapshot.candidateCount', 3);
  var windowMs = configInt_(config, 'snapshot.windowMinutes', 10) * 60 * 1000;
  var target = Date.parse(record.teslaStartAt || record.startAt);
  return (snapshots || []).filter(function (snapshot) {
    var at = Date.parse(snapshot.capturedAt);
    return !isNaN(at) && Math.abs(at - target) <= windowMs;
  }).sort(function (a, b) {
    var delta = Math.abs(Date.parse(a.capturedAt) - target) - Math.abs(Date.parse(b.capturedAt) - target);
    return delta !== 0 ? delta : String(a.id).localeCompare(String(b.id));
  }).slice(0, count);
}

function policyAllowsSuggestion_(engine, car, lighting) {
  if (!car) return true;
  var config = readConfigMap_().values;
  var minSamples = configInt_(config, 'policy.minSamples', 5);
  var minPrecision = configNumber_(config, 'policy.minPrecision', 0.9, 0.5, 0.99);
  var rows = readFeedback_().filter(function (row) {
    return row.engine === engine && row.suggestedCar === car && row.lighting === lighting;
  });
  if (rows.length < minSamples) return true;
  var correct = rows.filter(function (row) { return row.chosenCar === car; }).length;
  return correct / rows.length >= minPrecision;
}

function identifySession_(record, force) {
  if (!record || record.car !== 'unassigned') return { status: 'unknown', reason: 'not unassigned' };
  var engineSetting = visionEngine_();
  if (engineSetting === 'off') return { status: 'unknown', reason: 'vision disabled' };
  var snapshots = readSnapshots_();
  var candidates = selectCandidateSnapshots_(record, snapshots);
  if (!candidates.length) {
    updateLog_(record.id, { suggestionStatus: 'unknown', identifiedAt: new Date().toISOString() });
    return { status: 'unknown', reason: 'no snapshot' };
  }
  var plates = readPlates_();
  var lighting = lightingFor_(record.teslaStartAt || record.startAt);
  var result = null;
  for (var i = 0; i < candidates.length; i += 1) {
    var image = readDriveImageBase64_(candidates[i].driveFileId);
    result = plateIdentify_(image, plates);
    if (result.status === 'matched') break;
    if (i <= 1 && engineSetting.indexOf('vlm') !== -1) {
      var cars = readCars_();
      var vlm = vlmIdentify_(image, cars, configNumber_(readConfigMap_().values, 'vision.minConfidence', 0.8, 0.5, 0.99));
      if (vlm.status === 'matched' && policyAllowsSuggestion_('vlm', vlm.car, lighting)) result = vlm;
    }
  }
  if (!result) result = { engine: '', car: '', confidence: 0, plate: '', status: 'unknown', reason: 'no match' };
  updateLog_(record.id, {
    evidenceUrl: candidates[0].driveUrl,
    suggestedCar: result.car,
    suggestionConfidence: result.confidence,
    suggestionPlate: result.plate,
    suggestionStatus: result.status,
    suggestionEngine: result.engine,
    suggestionSnapshotId: candidates[0].id,
    identifiedAt: new Date().toISOString(),
  });
  return result;
}

function identifyPending_() {
  if (visionEngine_() === 'off') return { identified: 0, unknown: 0, engine: 'off' };
  var max = configInt_(readConfigMap_().values, 'vision.maxPerSync', 5);
  var candidates = readLog_().filter(function (record) {
    return record.car === 'unassigned' && record.teslaKey
      && record.suggestionStatus !== 'matched' && record.suggestionStatus !== 'unknown';
  }).sort(function (a, b) { return Date.parse(b.startAt) - Date.parse(a.startAt); }).slice(0, max);
  var identified = 0;
  var unknown = 0;
  for (var i = 0; i < candidates.length; i += 1) {
    var result = identifySession_(candidates[i], false);
    if (result.status === 'matched') identified += 1;
    else unknown += 1;
  }
  return { identified: identified, unknown: unknown };
}
```

Add to `apps-script/Code.gs`:
```js
function readDriveImageBase64_(fileId) {
  return Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes());
}

function identifyAction_(data) {
  var record = findRecord_(readLog_(), String(data.id || ''));
  if (!record) throw new Error('Unknown record');
  return identifySession_(record, Boolean(data.force));
}
```
`configValue_` is defined in `SheetRepo.gs` (Task 1) so Vision.gs can use it in unit tests without loading Code.gs.
Add `identify` routing in `doPost`:
```js
else if (action === 'identify') result = identifyAction_(data);
```
In `syncAction_`, after the owner sync, call `identifyPending_`:
```js
function syncAction_(data) {
  var result = syncTesla_(!data || !data.car);
  if (!data || !data.car) {
    try { result.vision = identifyPending_(); } catch (error) { result.vision = { error: String(error.message || error) }; }
  }
  return result;
}
```

Add `Vision.gs` to the fake harness sources:
```js
const sources = ['Logic.gs', 'SheetRepo.gs', 'Tesla.gs', 'Rates.gs', 'Vision.gs'].map(...)
```
Add `getBlob()` to the fake Drive file:
```js
getBlob: () => ({ getBytes: () => [...file.bytes] }),
```
Add `Utilities.base64Encode`:
```js
base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
```

- [ ] **Step 4: Run Vision and API tests**

Run: `node --test test/apps-script-vision.test.mjs test/apps-script-api.test.mjs`
Expected: PASS.

Add these API tests to `test/apps-script-api.test.mjs`:
```js
test('identify stores a plate suggestion without assigning the car', () => {
  const at = SESSION_START;
  const env = setup({
    props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET, CLOUD_VISION_API_KEY: 'key-1' },
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'u-1', 4: 'unassigned', 11: 'din:u', 12: 'tesla' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Plates: [['plate', 'car', 'active', 'createdAt'], ['AB1234', 'model3', 'TRUE', '']],
      Rates: [RATES_HEADER, RATE_ROW],
      Snapshots: [
        ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt', 'crop'],
        ['snap-1', at, 'file-1', 'https://drive.google.com/file/d/file-1/view', 1280, 720, 100, 'pi', at, ''],
      ],
    },
    fetch: (url) => {
      if (url.includes('vision.googleapis.com')) {
        return response(200, JSON.stringify({
          responses: [{ textAnnotations: [{ description: 'AB 1234\nHONG KONG' }] }],
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  env.driveFiles.push({ id: 'file-1', getBlob: () => ({ getBytes: () => [0xff, 0xd8, 0xff, 0xd9] }) });
  const result = send(env, { action: 'identify', id: 'u-1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'matched');
  const record = plain(env.call('readLog_'))[0];
  assert.equal(record.car, 'unassigned');
  assert.equal(record.suggestedCar, 'model3');
  assert.equal(record.suggestionEngine, 'plate');
});

test('policy suppresses a low-precision VLM combination', () => {
  const feedbackHeader = ['id', 'recordId', 'startAt', 'engine', 'suggestedCar', 'chosenCar', 'confidence', 'plate', 'snapshotId', 'lighting', 'actor', 'createdAt'];
  const wrong = [1, 2, 3, 4, 5].map((n) => [
    `fb-${n}`, `r-${n}`, SESSION_START, 'vlm', 'model3', 'ix3', 0.85, '', 'snap-1', 'day', 'owner', SESSION_START,
  ]);
  const env = setup({ sheets: { Feedback: [feedbackHeader, ...wrong] } });
  assert.equal(env.call('policyAllowsSuggestion_', 'vlm', 'model3', 'day'), false);
  assert.equal(env.call('policyAllowsSuggestion_', 'vlm', 'ix3', 'day'), true);
});
```

- [ ] **Step 5: Commit**

```bash
git add apps-script/Vision.gs apps-script/Code.gs test/fake-apps-script.mjs \
  test/apps-script-vision.test.mjs test/apps-script-api.test.mjs
git commit -m "feat: add plate and VLM suggestions"
```

---

### Task 5: Feedback Recording, Plate Map, Reassign, and Ignore

**Files:**
- Modify: `apps-script/Code.gs`
- Modify: `apps-script/SheetRepo.gs`
- Modify: `test/apps-script-api.test.mjs`

**Interfaces:**
- Consumes: `readFeedback_`, `appendFeedback_`, `upsertPlate_`.
- Produces: `recordAssignmentFeedback_(target, chosenCar, actor)`, `reassignAction_(data)`, feedback on assign/claim/ignore.

- [ ] **Step 1: Write failing feedback tests**

Add to `test/apps-script-api.test.mjs`:
```js
test('ignore records guest feedback and removes the session', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'unassigned-1', 4: 'unassigned', 11: 'din:u', 12: 'tesla' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  assert.equal(send(env, { action: 'ignore', id: 'unassigned-1' }).ok, true);
  const feedback = env.values('Feedback');
  assert.equal(feedback[1][5], 'guest');
  assert.equal(plain(env.call('readLog_')).length, 0);
});

test('reassign updates the car and records a correction', () => {
  const env = setup({
    sheets: {
      Log: [LOG_HEADER, row({ 0: 'rec-1', 4: 'model3', 11: 'din:r', 12: 'tesla' })],
      Cars: [CARS_HEADER, ['model3', 'Model 3', 'TRUE', 'x'], ['ix3', 'iX3', 'TRUE', 'x']],
      Rates: [RATES_HEADER, RATE_ROW],
    },
  });
  assert.equal(send(env, { action: 'reassign', id: 'rec-1', car: 'ix3' }).ok, true);
  assert.equal(plain(env.call('readLog_'))[0].car, 'ix3');
  assert.equal(env.values('Feedback')[1][5], 'ix3');
});
```

- [ ] **Step 2: Implement feedback and reassign**

Add these functions to `apps-script/Code.gs` (the feature branch is clean; the WIP draft is reference only). Call `recordAssignmentFeedback_` in `assignUnassigned_` before changes and in `ignoreAction_` before deletion:
```js
function recordAssignmentFeedback_(target, chosenCar, actor) {
  recordFeedbackRow_(target, chosenCar, actor);
}

function recordCorrectionFeedback_(target, chosenCar) {
  recordFeedbackRow_(target, chosenCar, 'owner');
}

function recordFeedbackRow_(target, chosenCar, actor) {
  if (!target) return;
  appendFeedback_({
    id: 'fb-' + target.id + '-' + Date.now(),
    recordId: target.id,
    startAt: target.teslaStartAt || target.startAt,
    engine: target.suggestionEngine || (target.suggestedCar ? 'manual' : ''),
    suggestedCar: target.suggestedCar || '',
    chosenCar: chosenCar,
    confidence: target.suggestionConfidence,
    plate: target.suggestionPlate || '',
    snapshotId: target.suggestionSnapshotId || '',
    lighting: lightingFor_(target.teslaStartAt || target.startAt),
    actor: actor || '',
    createdAt: new Date().toISOString(),
  });
  if (target.suggestionPlate && target.suggestedCar && target.suggestedCar !== chosenCar) {
    upsertPlate_(target.suggestionPlate, chosenCar);
  }
}
```
Call `recordAssignmentFeedback_(target, car.id, actor)` at the start of `assignUnassigned_` (after validation, before the merge/split). In `ignoreAction_` before deletion:
```js
function ignoreAction_(data) {
  var record = findRecord_(readLog_(), String(data.id || ''));
  if (record && record.car === 'unassigned') {
    recordAssignmentFeedback_(record, 'guest', 'owner');
  }
  var deleted = deleteLog_(String(data.id || ''));
  return { ignored: deleted };
}
```
Add `reassignAction_`:
```js
function reassignAction_(data) {
  var record = findRecord_(readLog_(), String(data.id || ''));
  if (!record) throw new Error('Unknown record');
  var car = findCar_(data.car);
  if (!car || !car.active) throw new Error('Unknown or inactive car: ' + data.car);
  var rates = readRates_();
  var split = record.kWh !== null && record.durationSec
    ? splitPeakKwh_(record.teslaStartAt || record.startAt, record.durationSec, record.kWh,
        selectRateRow_(hkMonth_(record.teslaStartAt || record.startAt), rates)
          ? selectRateRow_(hkMonth_(record.teslaStartAt || record.startAt), rates).peakStart : DEFAULT_PEAK_START_,
        selectRateRow_(hkMonth_(record.teslaStartAt || record.startAt), rates)
          ? selectRateRow_(hkMonth_(record.teslaStartAt || record.startAt), rates).peakEnd : DEFAULT_PEAK_END_,
        car.peakFactor)
    : null;
  recordCorrectionFeedback_(record, car.id);
  var patch = { car: car.id, source: record.source };
  if (split) { patch.peakKWh = split.peakKWh; patch.offPeakKWh = split.offPeakKWh; }
  var updated = updateLog_(record.id, patch);
  if (!updated) throw new Error('Failed to reassign record');
  return { reassigned: true, id: record.id, car: car.id };
}
```
Add `reassign` routing in `doPost`.

- [ ] **Step 3: Run tests and commit**

Run: `node --test test/apps-script-api.test.mjs`
Expected: PASS.

```bash
git add apps-script/Code.gs apps-script/SheetRepo.gs test/apps-script-api.test.mjs
git commit -m "feat: record feedback and support reassignment"
```

---

### Task 6: Owner and Family UI

**Files:**
- Modify: `owner.js`
- Modify: `family.js`
- Modify: `style.css`
- Modify: `test/integration-ui.test.mjs`
- Modify: `test/integration-harness.mjs`
- Modify: `api.js`

**Interfaces:**
- Consumes: `record.evidenceUrl`, `suggestedCar`, `suggestionConfidence`, `suggestionEngine`, `suggestionStatus`.
- Produces: owner crop thumbnail, suggestion label/adopt, ignore, reassign; family hint.

- [ ] **Step 1: Extend the harness and write failing UI tests**

In `test/integration-harness.mjs`, extend the Log header and row mapping with `evidenceUrl`, `suggestedCar`, `suggestionConfidence`, `suggestionPlate`, `suggestionStatus`, `identifiedAt`, `suggestionEngine`, `suggestionSnapshotId`; support a `Feedback` sheet only when seeded.

In `test/integration-ui.test.mjs`, extend `unassignedRecord` with the new fields and add:
```js
test('owner sees snapshot, engine, confidence, adopt, and ignore', { timeout: 20000 }, async () => {
  const record = {
    ...unassignedRecord('u-suggest', '2026-11-21T04:00:00.000Z', 'din:s'),
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
    suggestedCar: 'model3',
    suggestionConfidence: 0.84,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
  };
  const sheets = defaultSheets({ records: [logRow(record)] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?owner=1' });
  try {
    await waitFor(() => ui.document.querySelector('.suggestion-label'), 12000);
    assert.match(ui.document.querySelector('.suggestion-label').textContent, /Model 3.*84%/);
    assert.match(ui.document.querySelector('.suggestion-label').textContent, /視覺/);
    assert.equal(ui.document.querySelector('.evidence-link').href, record.evidenceUrl);
    const select = ui.document.querySelector('#ownerPending select');
    ui.document.querySelector('.owner-suggestion').click();
    assert.equal(select.value, 'model3');
    assert.ok(ui.document.querySelector('.owner-ignore'));
  } finally {
    ui.close();
  }
});
```
Add a family test:
```js
test('family sees a suggestion hint and no evidence', { timeout: 20000 }, async () => {
  const record = {
    ...unassignedRecord('u-family', '2026-11-21T04:00:00.000Z', 'din:f'),
    suggestedCar: 'model3',
    suggestionConfidence: 0.9,
    suggestionStatus: 'matched',
    suggestionEngine: 'vlm',
    evidenceUrl: 'https://drive.google.com/file/d/file-1/view',
  };
  const sheets = defaultSheets({ records: [logRow(record)] });
  const harness = await createHarness({ sheets });
  const ui = await loadUi({ apiUrl: harness.apiUrl, query: '?car=model3' });
  try {
    await waitFor(() => ui.document.querySelector('.suggestion-label'), 12000);
    assert.match(ui.document.querySelector('.suggestion-label').textContent, /系統建議係你/);
    assert.equal(ui.document.querySelector('.evidence-link'), null);
  } finally {
    ui.close();
  }
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/integration-ui.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the UI**

Use `wip/cctv-evidence-draft` as the concrete source for the owner/family UI and styles; cherry-pick the `makeUnassignedRow` suggestion/evidence/adopt block from `owner.js`, the suggestion hint from `family.js`, and the related `style.css` rules. Adapt the owner label to include the engine: `建議：Model 3（84%，視覺）` / `（98%，車牌）`.

Add the client helpers to `api.js`:
```js
export async function ignoreSession(apiUrl, id, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'ignore', id }, fetchImpl);
}

export async function reassignSession(apiUrl, id, car, fetchImpl = fetch) {
  return apiPost(apiUrl, { action: 'reassign', id, car }, fetchImpl);
}
```

Add an ignore handler:
```js
async function onIgnore(record) {
  if (!apiUrl || state.busy) return;
  state.busy = true;
  render();
  try {
    await ignoreSession(apiUrl, record.id);
    showToast(els.toast, '已標記為非家中車輛。');
    await refreshOrWarn('已忽略，但未能載入最新資料，請重新載入。');
  } catch (error) {
    state.offline = true;
    showToast(els.toast, friendlyError(error, '忽略失敗，請檢查網絡後重試。'));
  } finally {
    state.busy = false;
    render();
  }
}
```

In `owner.js` `makeUnassignedRow`, after the meta:
- Add a suggestion block with engine labels (`車牌`/`視覺`), confidence, adopt, or `未能辨識，請人手選擇`/`辨識失敗，請人手選擇`.
- Add an evidence link with the Drive thumbnail (`https://drive.google.com/thumbnail?id=<id>&sz=w480`) and fallback text.
- Add an ignore button calling the existing ignore API (add `ignoreSession` to `api.js` if missing).
- Add a reassign control to owner assigned records (a compact select + button calling `reassignSession`).
- In `family.js` `makeUnassignedRow`, add the suggestion hint when `record.suggestedCar === state.car.id`; never append an evidence link.
- Styles: `.suggestion-row`, `.suggestion-label`, `.owner-suggestion`, `.owner-ignore`, `.evidence-link`, `.evidence-thumb`.

- [ ] **Step 4: Run all UI tests and commit**

Run: `node --test test/integration-ui.test.mjs && npm test`
Expected: PASS.

```bash
git add owner.js family.js style.css api.js test/integration-ui.test.mjs test/integration-harness.mjs
git commit -m "feat: show evidence and matching controls"
```

---

### Task 7: Retention, Cleanup, Docs, and Deployment Runbook

**Files:**
- Modify: `apps-script/Code.gs`
- Modify: `apps-script/SheetRepo.gs`
- Modify: `test/apps-script-api.test.mjs`
- Modify: `tools/relay/tapo_relay.py`
- Modify: `tools/relay/test_relay.py`
- Modify: `README.md`

**Interfaces:**
- Produces: `cleanupSnapshots_(now, limit)`, `cleanupAction_(data)`, `deleteSnapshots_(ids)`; Pi cleanup uses config.

- [ ] **Step 1: Write failing cleanup tests**

Add to `test/apps-script-api.test.mjs`:
```js
test('cleanupSnapshots_ removes expired rows in batches', () => {
  const env = setup({
    props: { RELAY_HMAC_SECRET: SNAPSHOT_SECRET },
    sheets: {
      Config: [
        ['key', 'value', 'updatedAt', 'notes'],
        ['snapshot.retentionDays', '30', '', ''],
      ],
      Snapshots: [
        ['id', 'capturedAt', 'driveFileId', 'driveUrl', 'width', 'height', 'bytes', 'source', 'createdAt', 'crop'],
        ['snap-old-1', '2026-10-01T00:00:00.000Z', 'file-1', 'u1', 1280, 720, 1, 'pi', '', ''],
        ['snap-old-2', '2026-10-02T00:00:00.000Z', 'file-2', 'u2', 1280, 720, 1, 'pi', '', ''],
        ['snap-new', '2026-11-15T00:00:00.000Z', 'file-3', 'u3', 1280, 720, 1, 'pi', '', ''],
      ],
    },
  });
  const result = env.call('cleanupSnapshots_', new Date('2026-11-15T00:00:00.000Z'), 1);
  assert.equal(result.deleted, 1);
  assert.equal(plain(env.call('readSnapshots_')).length, 2);
});
```

- [ ] **Step 2: Implement cleanup and Pi trigger**

Add `cleanupSnapshots_` (config-driven retention, batch) and `cleanupAction_` (HMAC `cleanup\n<at>`, timestamp, limit) to `Code.gs`; add `deleteSnapshots_(ids)` to `SheetRepo.gs` (reverse row deletion). Route `cleanup` in `doPost`.

```js
function cleanupSnapshots_(now, limit) {
  var retentionDays = configInt_(readConfigMap_().values, 'snapshot.retentionDays', 30);
  var cutoff = (now ? now.getTime() : Date.now()) - retentionDays * 86400000;
  var max = Math.max(1, Math.min(Number(limit) || 500, 1000));
  var expired = readSnapshots_().filter(function (snapshot) {
    return Date.parse(snapshot.capturedAt) < cutoff;
  }).sort(function (a, b) {
    return Date.parse(a.capturedAt) - Date.parse(b.capturedAt);
  }).slice(0, max);
  for (var i = 0; i < expired.length; i += 1) {
    try { DriveApp.getFileById(expired[i].driveFileId).setTrashed(true); } catch (ignored) {}
  }
  if (expired.length) deleteSnapshots_(expired.map(function (snapshot) { return snapshot.id; }));
  return { deleted: expired.length };
}

function cleanupAction_(data) {
  var secret = PropertiesService.getScriptProperties().getProperty('RELAY_HMAC_SECRET');
  if (!secret) throw new Error('Missing RELAY_HMAC_SECRET');
  if (!validIso_(data.at)) throw new Error('Invalid cleanup timestamp');
  if (Math.abs(Date.now() - Date.parse(data.at)) > SNAPSHOT_MAX_AGE_MS_) throw new Error('Cleanup timestamp outside window');
  var expected = hmacHex_('cleanup\n' + String(data.at), secret);
  if (String(data.signature || '') !== expected) throw new Error('Invalid signature');
  return cleanupSnapshots_(new Date(), data.limit);
}
```

Add to `SheetRepo.gs`:
```js
function deleteSnapshots_(ids) {
  if (!ids || !ids.length) return 0;
  var sheet = sheetNamed_(openSpreadsheet_(), 'Snapshots', SNAPSHOTS_COLUMNS);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return 0;
  var header = values[0].map(function (value) { return String(value || '').trim(); });
  var idCol = header.indexOf('id');
  if (idCol === -1) return 0;
  var wanted = {};
  for (var i = 0; i < ids.length; i += 1) wanted[String(ids[i])] = true;
  var rows = [];
  for (var r = 1; r < values.length; r += 1) {
    if (wanted[String(values[r][idCol] || '')]) rows.push(r + 1);
  }
  rows.sort(function (a, b) { return b - a; });
  for (var d = 0; d < rows.length; d += 1) sheet.deleteRow(rows[d]);
  return rows.length;
}
```

In `tapo_relay.py`, the loop calls cleanup every `config["relay.cleanupIntervalSeconds"]` with `config["relay.cleanupBatch"]`; use `build_cleanup_payload` and `post_json(..., timeout=120)`; update `last_cleanup` only on success.

- [ ] **Step 3: Docs**

Update `README.md`:
- Config tab keys/defaults and remote tuning.
- Crop/fail-closed behavior; `full` testing-only.
- Plate/VLM setup, Script Properties, free-tier notes, Hong Kong Gemini exclusion.
- Feedback/reassign/ignore semantics.
- 30-day retention and Pi cleanup.
- Deployment: Apps Script v26 (new `Vision.gs`), `ev-relay-update`, Config seeding, crop, keys.
- Privacy: crop only; family no evidence; no public links.

Update `tools/relay/README.md` with config polling/cache and crop.

- [ ] **Step 4: Full verification**

Run:
```bash
npm test
npm run test:relay
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps-script/Code.gs apps-script/SheetRepo.gs test/apps-script-api.test.mjs \
  tools/relay/tapo_relay.py tools/relay/test_relay.py README.md tools/relay/README.md
git commit -m "feat: add snapshot retention and docs"
```

---

## Deployment Runbook (after the PR is merged)

1. Apps Script: add `Vision.gs` (new file), update Code/SheetRepo/Logic/Tesla as changed; save; deploy a new version (v26). The deployment URL stays the same.
2. Script Properties: `RELAY_HMAC_SECRET` (already set), `CLOUD_VISION_API_KEY` (when ready), `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (only if VLM). Enter them manually; never in chat or the Sheet.
3. Config tab: run `setup()` once to seed defaults; set `relay.crop` (use `full` only for the test camera; production requires the ROI); optionally set `snapshot.retentionDays=30` (default).
4. Pi: `sudo ev-relay-update` (pulls the new relay code), then verify the first config fetch and the next capture in the logs. No SSH needed for later tuning.
5. Verify: Plate OCR on one session (after plates and the Vision key are set); VLM only after the Cloudflare provider trial; owner UI shows the crop/suggestion; family hint; a correction records Feedback and updates Plates.
6. Physical: install the camera, capture day/night frames, set the ROI, confirm the guest car stays outside the crop, run 20 sessions before enabling the VLM in production.

## Self-Review

- **Spec coverage:** remote config (§6) → Task 1; crop/fail-closed (§7) → Task 2; schema (§5) → Task 3; plate/VLM/policy (§8) → Task 4; feedback/reassign/ignore (§9) → Task 5; UI (§10) → Task 6; retention (§11) → Task 7; security (§12) → global constraints and Tasks 1/4/7; testing/rollout (§13/14) → Tasks 4/6/7 and the runbook.
- **Placeholders:** none; all code steps contain concrete code or explicit commands.
- **Type consistency:** `configValue_`, `configInt_`, `configNumber_`, `readConfigMap_`; `suggestionEngine`/`suggestionSnapshotId`; `chosenCar` `guest`; `engine` `plate|vlm|manual`; `relayConfig`; `cleanup` signatures match across tasks.
