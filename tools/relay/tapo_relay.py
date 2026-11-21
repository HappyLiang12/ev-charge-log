import base64
import hashlib
import hmac
import json
import os
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


def capture_frame(rtsp_url, output_path, width=1280):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-rtsp_transport", "tcp", "-i", rtsp_url,
        "-frames:v", "1", "-vf", f"scale='min({width},iw)':-2",
        "-q:v", "3", "-an", "-y", str(output_path),
    ]
    subprocess.run(cmd, check=True, timeout=30)
    return output_path


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
        "INTERVAL_SECONDS": int(os.environ.get("INTERVAL_SECONDS", "300")),
        "IMAGE_WIDTH": int(os.environ.get("IMAGE_WIDTH", "1280")),
        "QUEUE_DIR": os.environ.get("QUEUE_DIR", "/var/lib/ev-relay/queue"),
        "MAX_QUEUE": int(os.environ.get("MAX_QUEUE", "1000")),
    }
    if env["API_URL"] and not env["RELAY_HMAC_SECRET"]:
        raise SystemExit("RELAY_HMAC_SECRET is required when API_URL is set")
    queue = Path(env["QUEUE_DIR"])
    queue.mkdir(parents=True, exist_ok=True)
    while True:
        captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        image_path = queue / ("pending-" + str(int(time.time())) + ".jpg")
        try:
            capture_frame(env["RTSP_URL"], image_path, env["IMAGE_WIDTH"])
            width, height = probe_size(image_path)
            if env["API_URL"]:
                payload = build_payload(image_path.read_bytes(), captured_at, width, height, env["RELAY_HMAC_SECRET"])
                result = post_json(env["API_URL"], payload)
                if not result.get("ok"):
                    raise RuntimeError(result.get("error") or "snapshot rejected")
                image_path.unlink(missing_ok=True)
        except Exception as error:
            print("relay error:", error, flush=True)
        try:
            prune_queue(queue, env["MAX_QUEUE"])
        except Exception as error:
            print("queue error:", error, flush=True)
        time.sleep(env["INTERVAL_SECONDS"])


if __name__ == "__main__":
    main()
