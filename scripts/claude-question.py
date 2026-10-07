#!/usr/bin/env python3
"""Synchronous Claude PreToolUse bridge for explicit Dash question answers."""
import json
import os
import secrets
import signal
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def read_payload():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return None
    if not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse" or payload.get("tool_name") != "AskUserQuestion":
        return None
    session = payload.get("session_id")
    tool_use_id = payload.get("tool_use_id")
    tool_input = payload.get("tool_input")
    if not isinstance(session, str) or not session or not isinstance(tool_use_id, str) or not tool_use_id:
        return None
    if not isinstance(tool_input, dict):
        return None
    questions = tool_input.get("questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= 16:
        return None
    seen = set()
    for question in questions:
        if not isinstance(question, dict):
            return None
        text = question.get("question")
        options = question.get("options")
        if not isinstance(text, str) or not text.strip() or text in seen or not isinstance(options, list) or len(options) > 64:
            return None
        seen.add(text)
        for option in options:
            if not isinstance(option, dict) or not isinstance(option.get("label"), str) or not option["label"].strip():
                return None
    return session, tool_use_id, tool_input, questions


def request_json(opener, url, method, headers, body, timeout):
    encoded = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(url, data=encoded, headers=headers, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def cancel(opener, base, headers, session, tool_use_id, question_id):
    url = base.rstrip("/") + "/question/cancel?" + urlencode({
        "session": session,
        "toolUseId": tool_use_id,
        "question": question_id,
    })
    try:
        request_json(opener, url, "DELETE", headers, None, 2)
    except (OSError, URLError, TimeoutError, ValueError):
        pass


def valid_answers(questions, value):
    if not isinstance(value, dict) or len(value) != len(questions):
        return False
    for question in questions:
        text = question["question"]
        if text not in value:
            return False
        answer = value[text]
        if not isinstance(answer, str) or (not answer and question.get("multiSelect") is not True):
            return False
        if len(answer.encode("utf-8")) > 32768 or any(ord(char) < 32 and char not in "\t\n\r" or ord(char) == 127 for char in answer):
            return False
    return set(value) == {question["question"] for question in questions}

def deadline_expired(_signal, _frame):
    raise TimeoutError("Question answer deadline expired")



def run():
    # Non-CLI hooks have no supported interactive terminal to resume into; leave them untouched.
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT") != "cli":
        return
    payload = read_payload()
    if (payload is None or len(sys.argv) != 7 or
            sys.argv[1] != "--hub-url" or sys.argv[3] != "--host" or sys.argv[5] != "--timeout-ms"):
        return
    session, tool_use_id, tool_input, questions = payload
    base, host, raw_timeout = sys.argv[2], sys.argv[4], sys.argv[6]
    if not base.startswith(("http://", "https://")) or not host or not raw_timeout.isdigit():
        return
    timeout_ms = int(raw_timeout)
    if not 1000 <= timeout_ms <= 600000:
        return
    question_id = secrets.token_urlsafe(32)
    deadline = time.monotonic() + timeout_ms / 1000
    headers = {
        "Content-Type": "application/json",
        "X-Dash-Host": host,
        "X-Dash-Entrypoint": "cli",
    }
    opener = build_opener(NoRedirect)
    registered = False
    previous_handler = signal.signal(signal.SIGALRM, deadline_expired)
    signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        status, _ = request_json(opener, base.rstrip("/") + "/question/register", "POST", headers, {
            "sessionId": session,
            "toolUseId": tool_use_id,
            "invocationId": question_id,
            "questions": questions,
            "timeoutMs": timeout_ms,
        }, min(5, remaining))
        if status != 201:
            return
        registered = True
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            wait_seconds = max(1, min(2, int(remaining)))
            url = base.rstrip("/") + "/question/wait?" + urlencode({
                "session": session,
                "toolUseId": tool_use_id,
                "question": question_id,
                "wait": wait_seconds,
            })
            status, body = request_json(opener, url, "GET", headers, None, min(3, remaining + 0.5))
            if status == 204:
                continue
            if status != 200:
                return
            try:
                result = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return
            answers = result.get("answers") if isinstance(result, dict) else None
            if time.monotonic() >= deadline or not valid_answers(questions, answers):
                return
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
            registered = False
            return
    except (OSError, URLError, TimeoutError, ValueError):
        return
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            if registered:
                # Cancellation has its own absolute bound, including a slow response body.
                signal.setitimer(signal.ITIMER_REAL, 2)
                cancel(opener, base, headers, session, tool_use_id, question_id)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)


if __name__ == "__main__":
    try:
        run()
    except BaseException:
        # A bridge failure must return no hook decision so Claude handles the question natively.
        pass
