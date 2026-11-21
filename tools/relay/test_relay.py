import hashlib
import hmac
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tapo_relay import (
    CropRequired,
    build_capture_command,
    build_cleanup_payload,
    build_relay_config_payload,
    canonical,
    load_cached_config,
    parse_crop,
    prune_queue,
    save_cached_config,
    sign,
    validate_relay_config,
)


class RelaySigningTest(unittest.TestCase):
    def test_canonical_and_signature(self):
        data = {
            "id": "snap-1763000000",
            "capturedAt": "2026-11-15T04:00:00.000Z",
            "width": 1280,
            "height": 720,
            "image": "abc",
        }
        text = canonical(data)
        self.assertEqual(
            text,
            "snap-1763000000\n2026-11-15T04:00:00.000Z\n1280\n720\nabc",
        )
        expected = hmac.new(
            b"secret", text.encode("utf-8"), hashlib.sha256
        ).hexdigest()
        self.assertEqual(sign("secret", text), expected)

    def test_plate_payload_has_no_secret(self):
        data = {
            "id": "snap-1763000000",
            "capturedAt": "2026-11-15T04:00:00.000Z",
            "width": 1280,
            "height": 720,
            "image": "abc",
        }
        payload = {**data, "action": "snapshot", "signature": sign("secret", canonical(data))}
        self.assertNotIn("password", payload)
        self.assertNotIn("rtsp", payload)


class RelayQueueTest(unittest.TestCase):
    def test_save_and_prune_keeps_newest(self):
        with TemporaryDirectory() as tmp:
            for epoch in range(5):
                (Path(tmp) / f"pending-{epoch}.jpg").write_bytes(b"jpg")
            prune_queue(tmp, keep=3)
            names = sorted(p.name for p in Path(tmp).glob("pending-*.jpg"))
            self.assertEqual(
                names,
                ["pending-2.jpg", "pending-3.jpg", "pending-4.jpg"],
            )


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

    def test_cached_config_round_trips_and_falls_back(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "config.json"
            save_cached_config(path, {**validate_relay_config({}, {}), "relay.crop": "10:20:800:600"})
            loaded = load_cached_config(path, {})
            self.assertEqual(loaded["relay.crop"], "10:20:800:600")
            self.assertEqual(loaded["relay.intervalSeconds"], 300)
            self.assertFalse(path.with_suffix(".tmp").exists())
            broken = Path(tmp) / "broken.json"
            broken.write_text("not json", encoding="utf-8")
            fallback = load_cached_config(broken, {"relay.intervalSeconds": 900})
            self.assertEqual(fallback["relay.intervalSeconds"], 900)
            self.assertEqual(fallback["relay.crop"], "")


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


if __name__ == "__main__":
    unittest.main()
