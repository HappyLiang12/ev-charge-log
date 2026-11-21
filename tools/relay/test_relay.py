import hashlib
import hmac
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tapo_relay import canonical, sign, prune_queue


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


if __name__ == "__main__":
    unittest.main()
