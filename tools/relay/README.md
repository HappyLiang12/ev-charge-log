# Raspberry Pi Relay

When `API_URL` is set, every cycle the Pi pulls the capture tunables from the
Apps Script `Config` tab (signed `relayConfig` request), crops the
charging-slot ROI from the Tapo RTSP stream, signs a JSON payload and POSTs the
JPEG to the Apps Script Web App. Failed uploads stay in `QUEUE_DIR`; the newest
`relay.maxQueue` frames are kept.

The camera keeps recording to its own SD card and can still be viewed in the
Tapo app. The relay only opens a short-lived RTSP client (about 4 seconds per
frame), so it does not replace or stop the camera's CCTV recording. `go2rtc` is
optional and unrelated to the relay.

5-minute frames are enough because a car stays parked for the whole charging
session. When a session is classified later, pick a few frames around the
session window and OCR those instead of analysing the stream continuously.

## Remote config

When `API_URL` is set:

- At the start of every cycle the relay POSTs
  `{ action: 'relayConfig', at, signature: HMAC(secret, "relayConfig\n" + at) }`.
- On success the response is validated and clamped again on the Pi, cached
  atomically at `/var/lib/ev-relay/config.json`, and applied from the next
  capture. No restart or SSH is needed for later tuning.
- On failure the cached file is used, then the `relay.env` bootstrap values.
  Capture and cleanup keep running; the error is logged once per change.
- If the cache is corrupt or missing, the env bootstrap values apply.
- `relay.enabled=false` pauses capture/upload but keeps config polling and
  cleanup running.

| key | default | range | effect |
| --- | --- | --- | --- |
| `relay.enabled` | `true` | true/false | Pause capture/upload |
| `relay.intervalSeconds` | `300` | 60–3600 | Capture cadence |
| `relay.imageWidth` | `1920` | 640–2560 | Output width after crop |
| `relay.jpegQuality` | `3` | 2–10 | ffmpeg `-q:v` |
| `relay.crop` | empty | `x:y:w:h` or `full` | Charging-slot ROI; empty/invalid stops capture; `full` is testing-only |
| `relay.captureTimeoutSeconds` | `30` | 10–120 | ffmpeg capture timeout |
| `relay.maxQueue` | `1000` | 100–5000 | Offline queue cap |
| `relay.cleanupIntervalSeconds` | `3600` | 600–86400 | Cleanup trigger cadence |
| `relay.cleanupBatch` | `500` | 10–1000 | Snapshots deleted per cleanup call |

The `relay.env` file keeps only the bootstrap values: `RTSP_URL`, `API_URL`,
`RELAY_HMAC_SECRET`, `QUEUE_DIR`, and fallbacks for the tunables above. The
Config tab overrides the tunables.

## Crop

`relay.crop` is `x:y:w:h` in source (`stream1`) pixels. The Pi applies
`crop=w:h:x:y`, then `scale='min(imageWidth,iw)':-2`, then JPEG quality. Only
the crop is uploaded, so a guest car outside the ROI is neither stored nor
analysed.

An empty or invalid crop is a fail-closed state: the relay logs
`crop required: set relay.crop in the Config tab` and skips capture/upload. It
never falls back to a full frame. `relay.crop=full` is the only full-frame
mode; use it for a controlled camera test only, then set the production ROI.

## Cleanup

The Pi triggers retention cleanup every `relay.cleanupIntervalSeconds`
(default hourly). Each signed `cleanup` request deletes up to
`relay.cleanupBatch` expired snapshots, oldest first; Apps Script trashes the
Drive file and removes the `Snapshots` row. A row whose file could not be
trashed is kept and retried at the next cleanup run; the response reports
`deleted` and `failed` counts. `last_cleanup` advances only after a successful
response, so a rejected request retries on the next cycle. There is no
ScriptApp trigger.

## Pi setup

1. Raspberry Pi OS Lite (64-bit). Give the Pi a DHCP reservation; `evpi.local`
   may not resolve on every network.
2. `sudo apt install ffmpeg python3`
3. `sudo useradd --system --home /var/lib/ev-relay --shell /usr/sbin/nologin evrelay`
4. `sudo install -d -o evrelay -g evrelay /var/lib/ev-relay/queue`
5. `sudo install -d -o evrelay -g evrelay /opt/ev-relay`
6. Copy `tapo_relay.py` to `/opt/ev-relay/` (or run the Pi's
   `sudo ev-relay-update`).
7. `sudo install -d /etc/ev-relay`
8. Create `/etc/ev-relay/relay.env` from `relay.env.example`:
   `sudo chown root:evrelay /etc/ev-relay/relay.env && sudo chmod 600 /etc/ev-relay/relay.env`
9. `sudo cp ev-relay.service /etc/systemd/system/ && sudo systemctl daemon-reload`
10. `sudo systemctl enable --now ev-relay`

## Camera

- Enable the Camera Account in the Tapo app, then keep RTSP on the LAN only.
- C520WS streams: `stream1` is 2560x1440, `stream2` is 640x360. Use `stream1`
  with `IMAGE_WIDTH=1920` so plates survive the downscale.
- The Pi 3 B and the C520WS are 2.4 GHz only.

## Test one frame

```bash
sudo systemctl stop ev-relay
sudo -u evrelay env $(sudo cat /etc/ev-relay/relay.env | xargs) \
  python3 -c 'import os, tapo_relay; tapo_relay.capture_frame(os.environ["RTSP_URL"], "/tmp/relay-test.jpg", 1920, crop=(10, 20, 800, 600)); print(tapo_relay.probe_size("/tmp/relay-test.jpg"))'
ls -lh /tmp/relay-test.jpg
```

Replace the crop with the real ROI. For a controlled full-frame test only, pass
`full_mode=True` instead of `crop=(...)`; never leave `relay.crop=full` in
production. `capture_frame(url, path, 1920)` without a crop now raises
`CropRequired`.

With `API_URL` empty the service is capture-only: frames accumulate under
`QUEUE_DIR` up to `relay.maxQueue` (the `MAX_QUEUE` env value is only the
bootstrap default until the first Config fetch). Set `API_URL` and
`RELAY_HMAC_SECRET` once the Apps Script endpoint is deployed.

## Time

The Pi 3 B has no RTC. The relay timestamps and HMAC payloads assume the clock
is correct, so the network must provide NTP; otherwise add an RTC module or a
network with a local NTP server. HMAC timestamps older than 10 minutes are
rejected by the Web App for snapshots, config, and cleanup.

## Security

- Never expose RTSP to the internet. The Pi only makes outbound requests.
- `relay.env` holds the camera password and the HMAC secret. Keep it off git.
- Generate the secret on the Pi: `openssl rand -hex 32`.
- Only the crop is uploaded; the full frame stays on the camera's own
  recording. `relay.crop=full` is a testing exception.
- The config response contains no secrets, Sheet IDs, plates, or model
  credentials.
