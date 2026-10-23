#!/usr/bin/env python3
"""Synchronous Claude goal-aware AskUserQuestion hook."""
import json
import os
import re
import secrets
import signal
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from autopilot_fence_cache import write_fence_cache


HOOK_TIMEOUT_MS = 605_000
MAX_RESPONSE_BYTES = 1_048_576
MAX_HOOK_INPUT_BYTES = 2_097_152
HOST_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def _deadline(_signum, _frame):
    raise TimeoutError("Claude dialog hook deadline expired")


def _abort(_signum, _frame):
    raise InterruptedError("Claude dialog hook was interrupted")


def _valid_text(value, limit):
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= limit and
            not any(ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127 for char in value))


def read_payload():
    try:
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        raw = stream.read(MAX_HOOK_INPUT_BYTES + 1)
        if isinstance(raw, bytes):
            if len(raw) > MAX_HOOK_INPUT_BYTES:
                return None
            raw = raw.decode("utf-8")
        elif len(raw.encode("utf-8")) > MAX_HOOK_INPUT_BYTES:
            return None
        payload = json.loads(raw)
    except (ValueError, OSError):
        return None
    if (not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse" or
            payload.get("tool_name") != "AskUserQuestion"):
        return None
    session = payload.get("session_id")
    tool_use_id = payload.get("tool_use_id")
    tool_input = payload.get("tool_input")
    if (not isinstance(session, str) or not SESSION_RE.fullmatch(session) or
            not isinstance(tool_use_id, str) or not 1 <= len(tool_use_id) <= 256 or
            any(ord(char) < 32 or ord(char) == 127 for char in tool_use_id) or
            not isinstance(tool_input, dict)):
        return None
    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 16:
        return None
    normalized = []
    labels_by_question = {}
    seen_questions = set()
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            return None
        text = question.get("question")
        options = question.get("options")
        if (not _valid_text(text, 8192) or text in seen_questions or
                not isinstance(options, list) or not 1 <= len(options) <= 64):
            return None
        seen_questions.add(text)
        clean = {"id": str(index), "question": text}
        if "header" in question:
            if not _valid_text(question["header"], 1024):
                return None
            clean["header"] = question["header"]
        multi_select = question.get("multiSelect") is True
        if "multiSelect" in question:
            if not isinstance(question["multiSelect"], bool):
                return None
            clean["multi"] = multi_select
        labels = []
        normalized_options = []
        for option in options:
            if not isinstance(option, dict) or not _valid_text(option.get("label"), 1024):
                return None
            label = option["label"]
            if label in labels or (multi_select and ", " in label):
                return None
            labels.append(label)
            normalized_option = {"label": label}
            if "description" in option:
                description = option["description"]
                if not isinstance(description, str) or len(description) > 4096 or any(
                        ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127 for char in description):
                    return None
                normalized_option["description"] = description
            if "preview" in option:
                preview = option["preview"]
                if not isinstance(preview, str) or len(preview) > 8192 or any(
                        ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127 for char in preview):
                    return None
                normalized_option["preview"] = preview
            normalized_options.append(normalized_option)
        clean["options"] = normalized_options
        recommendation = question.get("recommended")
        recommended_label = None
        if type(recommendation) is int and 0 <= recommendation < len(normalized_options):
            clean["recommended"] = recommendation
            recommended_label = normalized_options[recommendation]["label"]
        normalized.append(clean)
        labels_by_question[text] = (labels, multi_select, recommended_label)
    return session, tool_use_id, tool_input, normalized, labels_by_question


def _valid_answers(value, labels_by_question):
    if not isinstance(value, dict) or set(value) != set(labels_by_question):
        return False
    for text, answer in value.items():
        labels, multi_select, _recommended = labels_by_question[text]
        if (not isinstance(answer, str) or len(answer.encode("utf-8")) > 32768 or
                any(ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127 for char in answer)):
            return False
        if answer == "" and multi_select:
            continue
        if answer in labels:
            continue
        if not multi_select:
            return False
        selections = answer.split(", ")
        if (not selections or any(selection not in labels for selection in selections) or
                len(set(selections)) != len(selections)):
            return False
    return True


def _valid_autopilot(value):
    if not isinstance(value, dict) or set(value) != {"goal_id", "expires_at", "remaining_ttl_ms"}:
        return False
    return (all(type(value.get(name)) is int and 0 < value[name] <= 9_007_199_254_740_991
                for name in ("goal_id", "expires_at", "remaining_ttl_ms")) and
            value["expires_at"] > int(time.time() * 1000))


def _seed_fence_cache(host, session, autopilot):
    if (not HOST_RE.fullmatch(host) or not SESSION_RE.fullmatch(session) or
            not _valid_autopilot(autopilot)):
        raise ValueError("Invalid active-goal fence metadata")
    remaining = min(autopilot["remaining_ttl_ms"], autopilot["expires_at"] - int(time.time() * 1000))
    if remaining < 1:
        raise ValueError("Expired active-goal fence metadata")
    write_fence_cache(host, session, True, autopilot["goal_id"], autopilot["expires_at"], remaining)


def request_json(opener, url, method, headers, body, timeout):
    encoded = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=encoded, headers=headers, method=method)
    try:
        with opener.open(request, timeout=max(0.001, timeout)) as response:
            return response.status, response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as error:
        return error.code, error.read(MAX_RESPONSE_BYTES + 1)


def _cancel(opener, base, headers, session, tool_use_id, invocation_id):
    url = base.rstrip("/") + "/question/cancel?" + urlencode({
        "session": session,
        "toolUseId": tool_use_id,
        "question": invocation_id,
    })
    try:
        request_json(opener, url, "DELETE", headers, None, 2)
    except (OSError, URLError, TimeoutError, ValueError):
        pass


def _decode_json(status, body):
    if status != 200 or len(body) > MAX_RESPONSE_BYTES:
        return None
    try:
        value = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _answer_source(value, labels_by_question, invocation_id=None):
    if not isinstance(value, dict):
        return None
    allowed = {"answers", "source", "autopilot"}
    required = {"answers"}
    if invocation_id is not None:
        allowed |= {"action", "invocationId"}
        required |= {"action", "invocationId", "source"}
        if value.get("action") != "answer" or value.get("invocationId") != invocation_id:
            return None
    if not required.issubset(value) or not set(value).issubset(allowed):
        return None
    source = value.get("source")
    autopilot = value.get("autopilot")
    if source is not None and source not in ("autopilot", "web", "telegram"):
        return None
    if source == "autopilot" and not _valid_autopilot(autopilot):
        return None
    if source in ("web", "telegram") and autopilot is not None:
        return None
    if source is None and autopilot is not None:
        return None
    answers = value.get("answers")
    if not _valid_answers(answers, labels_by_question):
        return None
    if source == "autopilot" and any(answers.get(text) != question[2] for text, question in labels_by_question.items()):
        return None
    if source is None:
        source = "owner"
    return answers, source, autopilot


def _parse_registration(value, invocation_id, labels_by_question, hook_deadline_ms):
    if not isinstance(value, dict) or not isinstance(value.get("action"), str):
        return None
    action = value["action"]
    if action == "release":
        return ("release", None, None, None) if set(value) == {"action"} else None
    if action == "answer":
        answer = _answer_source(value, labels_by_question, invocation_id)
        return ("answer", answer, None, None) if answer is not None else None
    if action != "hold":
        return None
    if set(value) - {"action", "invocationId", "questionId", "expiresAt", "answerAt", "autopilot"} or \
            value.get("invocationId") != invocation_id or value.get("questionId") != invocation_id:
        return None
    expires_at = value.get("expiresAt")
    answer_at = value.get("answerAt")
    now_ms = int(time.time() * 1000)
    if type(expires_at) is not int or not now_ms < expires_at <= hook_deadline_ms:
        return None
    if answer_at is not None and (type(answer_at) is not int or not now_ms < answer_at < expires_at):
        return None
    autopilot = value.get("autopilot")
    if autopilot is not None and (not _valid_autopilot(autopilot) or answer_at is None):
        return None
    if not {"action", "invocationId", "questionId", "expiresAt"}.issubset(value):
        return None
    return "hold", autopilot, expires_at, answer_at


def _emit_answer(tool_input, answers, source, autopilot, host, session):
    if source == "autopilot":
        _seed_fence_cache(host, session, autopilot)
    updated_input = dict(tool_input)
    updated_input["answers"] = answers
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated_input,
        },
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run():
    start_wall_ms = int(time.time() * 1000)
    start_monotonic = time.monotonic()
    hook_deadline_ms = start_wall_ms + HOOK_TIMEOUT_MS
    deadline = start_monotonic + HOOK_TIMEOUT_MS / 1000
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT") != "cli":
        return
    if len(sys.argv) != 5 or sys.argv[1] != "--hub-url" or sys.argv[3] != "--host":
        return
    base, host = sys.argv[2], sys.argv[4]
    if (not base.startswith(("http://", "https://")) or not HOST_RE.fullmatch(host)):
        return
    parsed = read_payload()
    if parsed is None:
        return
    session, tool_use_id, tool_input, questions, labels_by_question = parsed
    invocation_id = secrets.token_urlsafe(32)
    headers = {
        "Content-Type": "application/json",
        "X-Dash-Host": host,
        "X-Dash-Entrypoint": "cli",
    }
    opener = build_opener(ProxyHandler({}), NoRedirect)
    registration_attempted = False
    completed = False
    previous_handlers = {}
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    previous_timer_started = time.monotonic()
    try:
        previous_handlers[signal.SIGALRM] = signal.signal(signal.SIGALRM, _deadline)
        previous_handlers[signal.SIGINT] = signal.signal(signal.SIGINT, _abort)
        previous_handlers[signal.SIGTERM] = signal.signal(signal.SIGTERM, _abort)
        signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
        body = {
            "toolName": "AskUserQuestion",
            "sessionId": session,
            "toolUseId": tool_use_id,
            "invocationId": invocation_id,
            "questions": questions,
            "hook_deadline_ms": hook_deadline_ms,
        }
        registration_attempted = True
        status, response_body = request_json(opener, base.rstrip("/") + "/hook/ask", "POST", headers, body,
                                             min(5, max(0.001, deadline - time.monotonic())))
        registration = _decode_json(status, response_body)
        outcome = _parse_registration(registration, invocation_id, labels_by_question, hook_deadline_ms)
        if outcome is None:
            return
        action, value, expires_at, answer_at = outcome
        if action == "release":
            return
        if action == "answer":
            answers, source, autopilot = value
            if time.monotonic() >= deadline:
                return
            _emit_answer(tool_input, answers, source, autopilot, host, session)
            completed = True
            return

        hold_deadline = min(deadline, time.monotonic() + max(0, expires_at - int(time.time() * 1000)) / 1000)
        resolve_body = {**body, "action": "resolve"}
        while True:
            remaining = hold_deadline - time.monotonic()
            if remaining <= 0:
                return
            if autopilot is not None and answer_at is not None:
                until_answer = (answer_at - int(time.time() * 1000)) / 1000
                if until_answer <= 0:
                    status, response_body = request_json(
                        opener, base.rstrip("/") + "/hook/ask", "POST", headers, resolve_body,
                        min(5, max(0.001, remaining)))
                    refreshed = _parse_registration(_decode_json(status, response_body), invocation_id,
                                                    labels_by_question, hook_deadline_ms)
                    if refreshed is None:
                        return
                    action, value, expires_at, answer_at = refreshed
                    if action == "release":
                        return
                    if action == "answer":
                        answers, source, autopilot = value
                        if time.monotonic() >= deadline or time.monotonic() >= hold_deadline:
                            return
                        _emit_answer(tool_input, answers, source, autopilot, host, session)
                        completed = True
                        return
                    autopilot = value
                    hold_deadline = min(deadline, time.monotonic() +
                                        max(0, expires_at - int(time.time() * 1000)) / 1000)
                    continue
            wait_seconds = max(1, min(50, int(remaining + 0.999)))
            if autopilot is not None and answer_at is not None:
                wait_seconds = min(wait_seconds, max(1, int((answer_at - int(time.time() * 1000) + 999) / 1000)))
            wait_url = base.rstrip("/") + "/question/wait?" + urlencode({
                "session": session,
                "toolUseId": tool_use_id,
                "question": invocation_id,
                "wait": wait_seconds,
            })
            status, response_body = request_json(opener, wait_url, "GET", headers, None, remaining)
            if status == 204:
                continue
            answer = _answer_source(_decode_json(status, response_body), labels_by_question)
            if answer is None:
                return
            answers, source, autopilot = answer
            if time.monotonic() >= deadline or time.monotonic() >= hold_deadline:
                return
            _emit_answer(tool_input, answers, source, autopilot, host, session)
            completed = True
            return
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if registration_attempted and not completed:
            _cancel(opener, base, headers, session, tool_use_id, invocation_id)
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
        if previous_timer[0] > 0:
            elapsed = time.monotonic() - previous_timer_started
            remaining = max(0.001, previous_timer[0] - elapsed)
            signal.setitimer(signal.ITIMER_REAL, remaining, previous_timer[1])


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--seed":
        try:
            _seed_fence_cache(sys.argv[2], sys.argv[3], json.load(sys.stdin))
        except BaseException:
            sys.exit(1)
    else:
        try:
            run()
        except BaseException:
            # Fail closed without exposing questions, answers, or tool input.
            pass
