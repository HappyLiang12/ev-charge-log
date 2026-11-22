import hashlib
import hmac
import io
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from tapo_relay import (
    CROP_REQUIRED_MESSAGE,
    CropRequired,
    PENDING_MAX_AGE_SECONDS,
    SNAPSHOT_TIMEOUT_SECONDS,
    build_capture_command,
    build_cleanup_payload,
    build_relay_config_payload,
    canonical,
    cleanup_due,
    drain_pending,
    load_cached_config,
    log_once,
    parse_cleanup_result,
    parse_crop,
    pending_epoch,
    prune_queue,
    save_cached_config,
    sign,
    upload_pending,
    upload_with_retry,
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

    def test_fallback_crop_survives_missing_raw_key(self):
        cfg = validate_relay_config({}, {"relay.crop": "10:20:800:600"})
        self.assertEqual(cfg["relay.crop"], "10:20:800:600")

    def test_blank_raw_crop_overrides_fallback(self):
        cfg = validate_relay_config({"relay.crop": ""}, {"relay.crop": "10:20:800:600"})
        self.assertEqual(cfg["relay.crop"], "")

    def test_fallback_numbers_are_clamped(self):
        cfg = validate_relay_config({}, {"relay.intervalSeconds": 5})
        self.assertEqual(cfg["relay.intervalSeconds"], 60)

    def test_non_finite_numbers_fall_back_to_default(self):
        for value in (float("inf"), float("-inf")):
            cfg = validate_relay_config({"relay.intervalSeconds": value}, {})
            self.assertEqual(cfg["relay.intervalSeconds"], 300)
        cfg = validate_relay_config({}, {"relay.intervalSeconds": float("inf")})
        self.assertEqual(cfg["relay.intervalSeconds"], 300)

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


class RelayCleanupTriggerTest(unittest.TestCase):
    def test_cleanup_due(self):
        self.assertTrue(cleanup_due(1000.0, 0.0, 600))
        self.assertFalse(cleanup_due(1000.0, 500.0, 600))
        self.assertTrue(cleanup_due(1100.0, 500.0, 600))


class RelayCleanupLogTest(unittest.TestCase):
    def test_parse_cleanup_result(self):
        self.assertEqual(parse_cleanup_result({"deleted": 3, "failed": 2}), (3, 2))
        self.assertEqual(parse_cleanup_result({"deleted": 1}), (1, 0))
        self.assertEqual(parse_cleanup_result({"deleted": 0, "failed": None}), (0, 0))
        self.assertEqual(parse_cleanup_result({"deleted": 0, "failed": "bad"}), (0, 0))

    def test_crop_warning_logs_once_per_change(self):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            last = log_once(None, CROP_REQUIRED_MESSAGE)
            last = log_once(last, CROP_REQUIRED_MESSAGE)
            last = log_once(last, CROP_REQUIRED_MESSAGE)
            self.assertEqual(last, CROP_REQUIRED_MESSAGE)
            # A later recurrence (after a valid crop reset) logs again.
            last = log_once(None, CROP_REQUIRED_MESSAGE)
        self.assertEqual(buffer.getvalue().count(CROP_REQUIRED_MESSAGE), 2)


class RelayPendingRetryTest(unittest.TestCase):
    def test_pending_upload_uses_file_epoch_and_deletes_after_success(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "pending-1795284558.jpg"
            path.write_bytes(b"jpeg")
            captured = {}

            def fake_post(url, payload, timeout=30):
                captured["url"] = url
                captured["payload"] = payload
                captured["timeout"] = timeout
                return {"ok": True, "stored": True, "existing": True}

            with patch("tapo_relay.probe_size", return_value=(1920, 1080)):
                result = upload_pending("https://api", "secret", path, post=fake_post)

            self.assertTrue(result["existing"])
            self.assertFalse(path.exists())
            self.assertEqual(captured["url"], "https://api")
            self.assertEqual(captured["timeout"], SNAPSHOT_TIMEOUT_SECONDS)
            payload = captured["payload"]
            self.assertEqual(payload["id"], "snap-1795284558")
            self.assertEqual(payload["capturedAt"], "2026-11-21T18:09:18Z")
            self.assertEqual(payload["width"], 1920)
            self.assertEqual(payload["height"], 1080)
            self.assertEqual(payload["signature"], sign("secret", canonical(payload)))

    def test_upload_with_retry_succeeds_after_timeouts(self):
        calls = []
        sleeps = []

        def fake_upload(api_url, secret, path):
            calls.append(path)
            if len(calls) < 3:
                raise RuntimeError("The read operation timed out")
            return {"ok": True}

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "pending-1.jpg"
            path.write_bytes(b"jpg")
            result = upload_with_retry(
                "https://api", "secret", path,
                sleep_func=sleeps.append, upload_func=fake_upload,
            )

        self.assertTrue(result)
        self.assertEqual(calls, [path, path, path])
        self.assertEqual(sleeps, [5, 15])

    def test_upload_with_retry_logs_final_failure(self):
        calls = []
        sleeps = []
        buffer = io.StringIO()

        def fake_upload(api_url, secret, path):
            calls.append(path)
            raise RuntimeError("The read operation timed out")

        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "pending-1.jpg"
            path.write_bytes(b"jpg")
            with redirect_stdout(buffer):
                result = upload_with_retry(
                    "https://api", "secret", path,
                    sleep_func=sleeps.append, upload_func=fake_upload,
                )

        self.assertFalse(result)
        self.assertEqual(len(calls), 4)
        self.assertEqual(sleeps, [5, 15, 30])
        self.assertIn("relay error:", buffer.getvalue())
        self.assertIn("timed out", buffer.getvalue())

    def test_drain_pending_uploads_recent_and_moves_expired(self):
        with TemporaryDirectory() as tmp:
            queue = Path(tmp) / "queue"
            queue.mkdir()
            now = 1_800_000_000
            recent = queue / f"pending-{now - 60}.jpg"
            expired = queue / f"pending-{now - PENDING_MAX_AGE_SECONDS - 120}.jpg"
            recent.write_bytes(b"recent")
            expired.write_bytes(b"expired")
            uploaded = []

            def fake_upload(api_url, secret, path):
                uploaded.append(path.name)
                path.unlink()
                return {"ok": True}

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = drain_pending(
                    "https://api", "secret", queue, now=now, upload_func=fake_upload,
                )

            self.assertEqual(uploaded, [recent.name])
            self.assertFalse(recent.exists())
            self.assertFalse(expired.exists())
            self.assertTrue((Path(tmp) / "expired" / expired.name).exists())
            self.assertEqual(result, {"uploaded": 1, "expired": 1, "failed": 0})
            self.assertIn("pending expired:", buffer.getvalue())

    def test_drain_pending_keeps_recent_failure(self):
        with TemporaryDirectory() as tmp:
            queue = Path(tmp) / "queue"
            queue.mkdir()
            now = 1_800_000_000
            recent = queue / f"pending-{now - 30}.jpg"
            recent.write_bytes(b"recent")
            buffer = io.StringIO()

            def fake_upload(api_url, secret, path):
                raise RuntimeError("The read operation timed out")

            with redirect_stdout(buffer):
                result = drain_pending(
                    "https://api", "secret", queue, now=now, upload_func=fake_upload,
                )

            self.assertTrue(recent.exists())
            self.assertFalse((Path(tmp) / "expired" / recent.name).exists())
            self.assertEqual(result, {"uploaded": 0, "expired": 0, "failed": 1})
            self.assertIn("pending retry failed:", buffer.getvalue())

    def test_pending_epoch_parses_only_valid_names(self):
        self.assertEqual(pending_epoch(Path("pending-123.jpg")), 123)
        self.assertIsNone(pending_epoch(Path("pending-abc.jpg")))
        self.assertIsNone(pending_epoch(Path("other-123.jpg")))


if __name__ == "__main__":
    unittest.main()
