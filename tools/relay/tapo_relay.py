import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def canonical(data):
    return "\n".join([
        str(data["id"]),
        str(data["capturedAt"]),
        str(data["width"]),
        str(data["height"]),
        str(data["image"]),
    ])


def sign(secret, text):
    return hmac.new(secret.encode("utf-8"), text.encode("utf-8"), hashlib.sha256).hexdigest()


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


def probe_size(path):
    result = subprocess.run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path),
    ], check=True, capture_output=True, text=True, timeout=10)
    width, height = result.stdout.strip().split(",")[:2]
    return int(width), int(height)


def build_payload(image_bytes, captured_at, width, height, secret):
    data = {
        "id": "snap-" + str(int(datetime.fromisoformat(captured_at.replace("Z", "+00:00")).timestamp())),
        "capturedAt": captured_at,
        "width": width,
        "height": height,
        "image": base64.b64encode(image_bytes).decode("ascii"),
    }
    data["action"] = "snapshot"
    data["signature"] = sign(secret, canonical(data))
    return data


def post_json(url, payload, timeout=30):
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "text/plain;charset=utf-8"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def prune_queue(queue_dir, keep):
    keep = max(int(keep), 0)
    files = sorted(
        Path(queue_dir).glob("pending-*.jpg"),
        key=lambda path: int(path.stem.split("-", 1)[1]),
    )
    for path in files[: max(len(files) - keep, 0)]:
        path.unlink(missing_ok=True)


def main():
    env = {
        "RTSP_URL": os.environ["RTSP_URL"],
        "API_URL": os.environ.get("API_URL", "").strip(),
        "RELAY_HMAC_SECRET": os.environ.get("RELAY_HMAC_SECRET", ""),
        "QUEUE_DIR": os.environ.get("QUEUE_DIR", "/var/lib/ev-relay/queue"),
    }
    if env["API_URL"] and not env["RELAY_HMAC_SECRET"]:
        raise SystemExit("RELAY_HMAC_SECRET is required when API_URL is set")
    queue = Path(env["QUEUE_DIR"])
    queue.mkdir(parents=True, exist_ok=True)
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


if __name__ == "__main__":
    main()
