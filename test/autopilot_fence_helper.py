import importlib.util
import json
import io
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).parents[1] / "scripts" / "claude-autopilot-fence.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("dash_autopilot_fence", SCRIPT)
fence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fence)


CACHE_SPEC = importlib.util.spec_from_file_location("dash_autopilot_fence_cache", SCRIPT.parent / "autopilot_fence_cache.py")
cache = importlib.util.module_from_spec(CACHE_SPEC)
CACHE_SPEC.loader.exec_module(cache)


class JsonResponse:
    status = 200

    def __init__(self, value):
        self.value = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return self.value


class FakeOpener:
    def __init__(self, value):
        self.response = JsonResponse(value)

    def open(self, _request, timeout):
        self.timeout = timeout
        return self.response


class FenceResponseValidationTests(unittest.TestCase):
    def test_boolean_zero_is_not_an_inactive_ttl(self):
        response = {
            "active_goal": False,
            "goal_id": None,
            "expires_at": None,
            "remaining_ttl_ms": False,
        }
        opener = FakeOpener(response)
        with patch.object(fence, "build_opener", return_value=opener), \
                patch.object(fence, "write_fence_cache"):
            denied, reason = fence.post_fence(
                "http://127.0.0.1:4777", "synthetic-host", "synthetic-session", "Bash", {"command": "echo safe"}
            )
        self.assertTrue(denied)
        self.assertEqual(reason, "dash autopilot fence metadata invalid; ask the owner")

    def test_valid_inactive_goal_leaves_ordinary_tool_call_unchanged(self):
        opener = FakeOpener({
            "active_goal": False, "goal_id": None, "expires_at": None, "remaining_ttl_ms": 0,
        })
        with patch.object(fence, "build_opener", return_value=opener), \
                patch.object(fence, "write_fence_cache") as write_cache:
            denied, reason = fence.post_fence(
                "http://127.0.0.1:4777", "synthetic-host", "synthetic-session", "Bash", {"command": "echo safe"}
            )
        self.assertFalse(denied)
        self.assertIsNone(reason)
        write_cache.assert_called_once_with("synthetic-host", "synthetic-session", False)

class FenceNetworkFailureTests(unittest.TestCase):
    def test_cold_or_inactive_cache_denies_when_hub_is_unreachable(self):
        payload = {
            "hook_event_name": "PreToolUse",
            "session_id": "synthetic-session",
            "tool_name": "Bash",
            "tool_input": {"command": "echo safe"},
        }
        for cached_state in (None, False):
            with self.subTest(cached_state=cached_state):
                output = io.StringIO()
                stdin = SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode("utf-8")))
                with patch.object(fence, "post_fence", side_effect=OSError("synthetic hub outage")), \
                        patch.object(fence, "read_fence_cache", return_value=cached_state), \
                        patch.object(sys, "argv", [
                            "claude-autopilot-fence.py", "--hub-url", "http://127.0.0.1:4777",
                            "--host", "synthetic-host",
                        ]), patch.object(sys, "stdin", stdin), patch.object(sys, "stdout", output):
                    fence.run()
                self.assertTrue(output.getvalue())
                result = json.loads(output.getvalue())
                self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")


class FenceCacheSeedTests(unittest.TestCase):
    def test_seed_helper_writes_only_bounded_live_goal_metadata(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as temporary, \
                patch.dict(os.environ, {"XDG_STATE_HOME": directory, "TMPDIR": temporary}):
            now = 1_700_000_000_000
            with patch.object(cache.time, "time", return_value=now / 1000):
                cache.seed_fence_cache("synthetic-host", "synthetic-session", {
                    "goal_id": 7, "expires_at": now + 60_000, "remaining_ttl_ms": 50_000,
                })
                self.assertTrue(cache.read_fence_cache("synthetic-host", "synthetic-session"))
                with patch.dict(os.environ, {"TMPDIR": "/removed-temporary-directory"}):
                    self.assertTrue(cache.read_fence_cache("synthetic-host", "synthetic-session"))
            with self.assertRaises(ValueError):
                cache.seed_fence_cache("synthetic-host", "synthetic-session", {
                    "goal_id": 7, "expires_at": now + 60_000, "remaining_ttl_ms": 50_000, "extra": True,
                })

    def test_expired_cache_is_removed_before_a_monotonic_clock_reset(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_STATE_HOME": directory}):
            with patch.object(cache.time, "monotonic_ns", return_value=10_000_000_000):
                cache.write_fence_cache("synthetic-host", "synthetic-session", True, 7, 20_000, 1_000)
            with patch.object(cache.time, "monotonic_ns", return_value=11_000_000_000):
                self.assertFalse(cache.read_fence_cache("synthetic-host", "synthetic-session"))
            with patch.object(cache.time, "monotonic_ns", return_value=100_000_000):
                self.assertIsNone(cache.read_fence_cache("synthetic-host", "synthetic-session"))


if __name__ == "__main__":
    unittest.main()
