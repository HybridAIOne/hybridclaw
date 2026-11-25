"""Noninteractive evaluation cancels protected actions; it never grants consent."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import launch


class ContinuationTests(unittest.TestCase):
    def run_launcher(self, *, approval_id="abcdef12", repeat=False, headers=True, expired=False):
        temporary = tempfile.TemporaryDirectory(prefix="wcb-denial-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name) / "runtime"
        calls = []
        approval = {"approvalId": approval_id, "toolName": "read", "expiresAt": None}

        def response(value, response_headers=None):
            result = io.BytesIO(json.dumps(value).encode())
            result.status = 200
            result.headers = response_headers or {}
            return result

        def open_request(request, **kwargs):
            if isinstance(request, str):
                return response({})
            body = json.loads(request.data)
            calls.append((request, body, kwargs))
            if request.full_url.endswith("/v1/chat/completions"):
                ids = {"X-HybridClaw-Session-Id": "storage-id", "X-HybridClaw-Session-Key": "original-user-key"} if headers else {}
                return response({"choices": [{}], "hybridclaw": {"pendingApproval": approval}}, ids)
            self.assertEqual(request.full_url, "http://127.0.0.1:9090/api/chat")
            self.assertEqual(body["approval"], {"approvalId": "abcdef12", "decision": "no"})
            self.assertEqual(body["sessionId"], "storage-id")
            self.assertEqual(body["userId"], "original-user-key")
            self.assertEqual(body["reasoningEffort"], "high")
            self.assertNotIn("content", body)
            self.assertLessEqual(kwargs["timeout"], 60)
            return response({"status": "success", "result": "Fixture response", **({"pendingApproval": approval} if repeat else {})})

        gateway = Mock()
        gateway.poll.side_effect = [None, 0]
        def start(*args, **kwargs):
            (root / "data/gateway").mkdir(parents=True)
            return gateway
        payload = {"model": "example/model", "prompt": "Fixture original request", "timeout_seconds": 60, "thinking": "high"}
        clock = patch.object(launch.time, "monotonic", side_effect=[0, 0, 61]) if expired else patch.object(launch.time, "monotonic", return_value=0)
        with patch.dict(os.environ, {"HYBRIDCLAW_DATA_DIR": str(root)}), patch.object(launch.sys, "stdin", io.StringIO(json.dumps(payload))), patch.object(launch.subprocess, "Popen", side_effect=start), patch.object(launch.urllib.request, "urlopen", side_effect=open_request), patch.object(launch.signal, "signal"), clock:
            launch.main()
        return root, calls

    def test_denies_in_same_session_and_preserves_result(self):
        root, calls = self.run_launcher()
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]["messages"], [{"role": "user", "content": "Fixture original request"}])
        self.assertEqual(calls[0][0].get_header("X-hybridclaw-timeout-ms"), "60000")
        self.assertEqual(json.loads((root / "completion.json").read_text())["choices"][0]["message"]["content"], "Fixture response")
        self.assertEqual(json.loads((root / "data/gateway/approval-continuations.json").read_text())[0]["decision"], "no")

    def test_repeated_approval_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "repeated"):
            self.run_launcher(repeat=True)

    def test_missing_identity_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "bind"):
            self.run_launcher(headers=False)

    def test_non_native_approval_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "bind"):
            self.run_launcher(approval_id="connector-request")

    def test_original_deadline_stops_continuation(self):
        with self.assertRaises(TimeoutError):
            self.run_launcher(expired=True)


if __name__ == "__main__":
    unittest.main()
