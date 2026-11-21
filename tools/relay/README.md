# Raspberry Pi Relay

Every `INTERVAL_SECONDS` (default 300) the Pi pulls one frame from the Tapo RTSP
stream, signs a JSON payload and POSTs it to the Apps Script Web App. Failed
uploads stay in `QUEUE_DIR`; the newest `MAX_QUEUE` frames are kept.

The camera keeps recording to its own SD card and can still be viewed in the
Tapo app. The relay only opens a short-lived RTSP client (about 4 seconds per
frame), so it does not replace or stop the camera's CCTV recording. `go2rtc` is
optional and unrelated to the relay.

5-minute frames are enough because a car stays parked for the whole charging
session. When a session is classified later, pick a few frames around the
session window and OCR those instead of analysing the stream continuously.

## Pi setup

1. Raspberry Pi OS Lite (64-bit). Give the Pi a DHCP reservation; `evpi.local`
   may not resolve on every network.
2. `sudo apt install ffmpeg python3`
3. `sudo useradd --system --home /var/lib/ev-relay --shell /usr/sbin/nologin evrelay`
4. `sudo install -d -o evrelay -g evrelay /var/lib/ev-relay/queue`
5. `sudo install -d -o evrelay -g evrelay /opt/ev-relay`
6. Copy `tapo_relay.py` to `/opt/ev-relay/`.
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
  python3 -c 'import tapo_relay, sys; tapo_relay.capture_frame(__import__("os").environ["RTSP_URL"], "/tmp/relay-test.jpg", 1920); print(tapo_relay.probe_size("/tmp/relay-test.jpg"))'
ls -lh /tmp/relay-test.jpg
```

With `API_URL` empty the service is capture-only: frames accumulate under
`QUEUE_DIR` up to `MAX_QUEUE`. Set `API_URL` and `RELAY_HMAC_SECRET` once the
Apps Script endpoint is deployed.

## Time

The Pi 3 B has no RTC. The relay timestamps and HMAC payloads assume the clock
is correct, so the network must provide NTP; otherwise add an RTC module or a
network with a local NTP server. HMAC timestamps older than 10 minutes are
rejected by the Web App.

## Security

- Never expose RTSP to the internet. The Pi only makes outbound requests.
- `relay.env` holds the camera password and the HMAC secret. Keep it off git.
- Generate the secret on the Pi: `openssl rand -hex 32`.
