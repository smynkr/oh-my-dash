import io
import json
from unittest.mock import patch
import importlib.util
from pathlib import Path
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("autopilot_dialog_hook", ROOT / "scripts" / "claude-autopilot-dialog.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class RegistrationParserTests(unittest.TestCase):
    def setUp(self):
        self.now = int(time.time() * 1000)
        self.invocation = "a" * 43
        self.labels = {"Which database?": (["Postgres", "SQLite"], False, "SQLite")}
        self.deadline = self.now + 600_000

    def test_hook_payload_preserves_only_a_valid_recommendation_index(self):
        payload = {
            "hook_event_name": "PreToolUse", "session_id": "synthetic-session", "tool_use_id": "tool-1",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Which database?",
                "options": [{"label": "Postgres"}, {"label": "SQLite"}], "recommended": 1}]},
        }
        with patch("sys.stdin", io.StringIO(json.dumps(payload))):
            parsed = helper.read_payload()
        self.assertEqual(parsed[3][0]["id"], "0")
        self.assertEqual(parsed[3][0]["recommended"], 1)
        self.assertEqual(parsed[4]["Which database?"], (["Postgres", "SQLite"], False, "SQLite"))
    def test_rejects_oversized_hook_input(self):
        with patch("sys.stdin", io.StringIO(" " * (helper.MAX_HOOK_INPUT_BYTES + 1))):
            self.assertIsNone(helper.read_payload())


    def test_autopilot_answers_must_match_each_recommendation(self):
        metadata = {"goal_id": 7, "expires_at": self.deadline, "remaining_ttl_ms": 600_000}
        base = {"action": "answer", "invocationId": self.invocation, "source": "autopilot", "autopilot": metadata}
        self.assertIsNone(helper._answer_source({**base, "answers": {"Which database?": "Postgres"}},
                                                self.labels, self.invocation))
        self.assertEqual(helper._answer_source({**base, "answers": {"Which database?": "SQLite"}},
                                               self.labels, self.invocation)[0], {"Which database?": "SQLite"})

    def test_autopilot_metadata_requires_explicit_source(self):
        metadata = {"goal_id": 7, "expires_at": self.deadline, "remaining_ttl_ms": 600_000}
        value = {"answers": {"Which database?": "SQLite"}, "autopilot": metadata}
        self.assertIsNone(helper._answer_source(value, self.labels))
    def test_multi_select_labels_with_answer_separator_release_to_native_ui(self):
        payload = {
            "hook_event_name": "PreToolUse", "session_id": "synthetic-session", "tool_use_id": "tool-1",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Which flags?", "multiSelect": True,
                "options": [{"label": "A, B"}, {"label": "C"}]}]},
        }
        with patch("sys.stdin", io.StringIO(json.dumps(payload))):
            self.assertIsNone(helper.read_payload())

    def test_registration_uses_server_question_schema(self):
        payload = {
            "hook_event_name": "PreToolUse", "session_id": "synthetic-session", "tool_use_id": "tool-1",
            "tool_name": "AskUserQuestion",
            "tool_input": {"questions": [{"question": "Which database?", "multiSelect": True,
                "options": [{"label": "Postgres", "description": "stable", "preview": "safe"}, {"label": "SQLite"}],
                "recommended": 1}]},
        }
        calls = []

        def fake_request(_opener, url, method, _headers, body, _timeout):
            calls.append((url, method, body))
            if url.endswith("/hook/ask"):
                return 200, b'{"action":"release"}'
            return 404, b""

        with patch.dict(helper.os.environ, {"CLAUDE_CODE_ENTRYPOINT": "cli"}), \
                patch.object(helper.sys, "argv", ["claude-autopilot-dialog.py", "--hub-url", "http://127.0.0.1:4777", "--host", "synthetic-host"]), \
                patch.object(helper.sys, "stdin", io.StringIO(json.dumps(payload))), \
                patch.object(helper, "request_json", side_effect=fake_request), \
                patch.object(helper.signal, "getitimer", return_value=(0, 0)), \
                patch.object(helper.signal, "setitimer"), \
                patch.object(helper.signal, "signal", return_value=None):
            helper.run()
        request = calls[0][2]
        self.assertEqual(request["toolName"], "AskUserQuestion")
        self.assertEqual(request["questions"], [{
            "id": "0", "question": "Which database?", "multi": True, "recommended": 1,
            "options": [
                {"label": "Postgres", "description": "stable", "preview": "safe"},
                {"label": "SQLite"},
            ],
        }])

    def test_delayed_hold_exposes_bounded_answer_time(self):
        value = {
            "action": "hold", "invocationId": self.invocation, "questionId": self.invocation,
            "expiresAt": self.deadline, "answerAt": self.now + 5_000,
            "autopilot": {"goal_id": 7, "expires_at": self.deadline, "remaining_ttl_ms": 600_000},
        }
        parsed = helper._parse_registration(value, self.invocation, self.labels, self.deadline)
        self.assertEqual(parsed, ("hold", value["autopilot"], self.deadline, value["answerAt"]))

    def test_owner_hold_has_no_automatic_answer_deadline(self):
        value = {"action": "hold", "invocationId": self.invocation, "questionId": self.invocation,
                 "expiresAt": self.deadline}
        self.assertEqual(helper._parse_registration(value, self.invocation, self.labels, self.deadline),
                         ("hold", None, self.deadline, None))

    def test_delayed_hold_rejects_missing_or_out_of_window_answer_time(self):
        metadata = {"goal_id": 7, "expires_at": self.deadline, "remaining_ttl_ms": 600_000}
        base = {"action": "hold", "invocationId": self.invocation, "questionId": self.invocation,
                "expiresAt": self.deadline, "autopilot": metadata}
        self.assertIsNone(helper._parse_registration(base, self.invocation, self.labels, self.deadline))
        for answer_at in (self.now, self.deadline, True, "later"):
            with self.subTest(answer_at=answer_at):
                value = {**base, "answerAt": answer_at}
                self.assertIsNone(helper._parse_registration(value, self.invocation, self.labels, self.deadline))


if __name__ == "__main__":
    unittest.main()
