import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

import counter_photo_chatgpt as reader


class ChatGPTMeterTests(unittest.TestCase):
    def test_partial_readings_and_validation(self):
        self.assertEqual(reader.parse_readings({"reading_a": "004925", "reading_b": "000591"}), (591, 4925))
        self.assertIsNone(reader.parse_readings({"reading_a": None, "reading_b": "000591"}))
        self.assertIsNone(reader.parse_readings({"reading_a": "000001", "reading_b": "1"}))
        for result in (None, [], {}, {"reading_a": 100, "reading_b": "2"},
                       {"reading_a": "-1", "reading_b": "2"}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                reader.parse_readings(result)

    def test_cli_receives_images_and_prompt_without_worker_credentials(self):
        def respond(args, **kwargs):
            self.assertEqual(args[-2:], ["--", reader.PROMPT])
            self.assertEqual(args.count("--image"), 6)
            self.assertNotIn("SITE2_OCR_HEADER_FILE", kwargs["env"])
            self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
            self.assertIn("--ignore-user-config", args)
            self.assertIn("gpt-6-luna", args)
            schema = json.loads(Path(args[args.index("--output-schema") + 1]).read_text())
            self.assertEqual(schema, reader.SCHEMA)
            Path(args[args.index("--output-last-message") + 1]).write_text(
                '{"reading_a":"004925","reading_b":"000591"}'
            )
            return subprocess.CompletedProcess(args, 0, "", "")

        with tempfile.TemporaryDirectory() as directory:
            photo = Path(directory) / "test.jpg"
            Image.new("RGB", (64, 64)).save(photo)
            with patch.dict(reader.os.environ, {
                "SITE2_CODEX_BIN": "/usr/bin/codex",
                "SITE2_CHATGPT_MODEL": "gpt-6-luna",
                "SITE2_OCR_HEADER_FILE": "/private/worker-header",
                "OPENAI_API_KEY": "test-secret",
            }), patch.object(reader.subprocess, "run", side_effect=respond):
                self.assertEqual(reader.read_pair(photo), (591, 4925))

    def test_connection_errors_remain_pending_instead_of_unreadable(self):
        spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("counter-photo-ocr.py"))
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        jobs = [{"id": 1, "photoObjectKey": "services/test.jpg"}]
        with patch.object(worker, "api_request", return_value=jobs) as api, \
                patch.object(worker.Path, "is_file", return_value=True), \
                patch.object(worker, "read_pair", side_effect=RuntimeError("connection failed")):
            with self.assertRaises(RuntimeError):
                worker.run_pending()
            api.assert_called_once_with("/pending")

    def test_transport_timeout_raises(self):
        with tempfile.TemporaryDirectory() as directory:
            photo = Path(directory) / "test.jpg"
            Image.new("RGB", (32, 32)).save(photo)
            with patch.dict(reader.os.environ, {"SITE2_CODEX_BIN": "/usr/bin/codex"}), \
                    patch.object(reader.subprocess, "run", side_effect=subprocess.TimeoutExpired("codex", 180)):
                with self.assertRaisesRegex(RuntimeError, "не ответил вовремя"):
                    reader.read_pair(photo)


if __name__ == "__main__":
    unittest.main()
