#!/usr/bin/env python3
"""Synchronous Claude PreToolUse deny-fence hook."""
import json
import os
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from autopilot_fence_cache import MAX_TTL_MS, read_fence_cache, write_fence_cache

HOST_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TOOL_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,255}$")
MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 1_048_576


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None



def emit_deny(reason):
    if not isinstance(reason, str) or not reason or len(reason) > 512 or any(ord(char) < 32 for char in reason):
        reason = "dash hub unreachable; autopilot paused, ask the owner"
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def cache_deny(host, session):
    state = read_fence_cache(host, session)
    return state is True or state == "invalid"


def post_fence(base, host, session, tool, tool_input):
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("Invalid hub URL")
    body = json.dumps({"harness": "claude", "sessionId": session, "tool": tool, "input": tool_input},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = Request(base.rstrip("/") + "/hook/fence", data=body, headers={
        "Content-Type": "application/json",
        "X-Dash-Host": host,
        "X-Dash-Entrypoint": "cli",
    }, method="POST")
    opener = build_opener(ProxyHandler({}), NoRedirect)
    with opener.open(request, timeout=3) as response:
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Fence response too large")
        result = json.loads(raw.decode("utf-8"))
        base_keys = {"active_goal", "goal_id", "expires_at", "remaining_ttl_ms"}
        if not isinstance(result, dict) or type(result.get("active_goal")) is not bool:
            try:
                write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
            except (OSError, ValueError):
                pass
            return True, "dash autopilot fence metadata invalid; ask the owner"
        if not result["active_goal"]:
            if (set(result) != base_keys or result.get("goal_id") is not None or
                    result.get("expires_at") is not None or
                    type(result.get("remaining_ttl_ms")) is not int or result["remaining_ttl_ms"] != 0):
                try:
                    write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
                except (OSError, ValueError):
                    pass
                return True, "dash autopilot fence metadata invalid; ask the owner"
            write_fence_cache(host, session, False)
            return False, None
        allowed_keys = base_keys | {"permissionDecision", "reason"}
        if not set(result).issubset(allowed_keys) or \
                (set(result) != base_keys and set(result) != base_keys | {"permissionDecision", "reason"}):
            try:
                write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
            except (OSError, ValueError):
                pass
            return True, "dash autopilot fence metadata invalid; ask the owner"
        if ("permissionDecision" in result and (result.get("permissionDecision") != "deny" or
                not isinstance(result.get("reason"), str) or len(result["reason"]) > 512 or
                any(ord(char) < 32 for char in result["reason"]))) or \
                ("permissionDecision" not in result and "reason" in result):
            try:
                write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
            except (OSError, ValueError):
                pass
            return True, "dash autopilot fence metadata invalid; ask the owner"
        goal_id = result.get("goal_id")
        expires_at = result.get("expires_at")
        remaining = result.get("remaining_ttl_ms")
        now_ms = int(time.time() * 1000)
        if (type(goal_id) is not int or goal_id < 1 or type(expires_at) is not int or expires_at <= now_ms or
                type(remaining) is not int or remaining < 1 or remaining > MAX_TTL_MS):
            try:
                write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
            except (OSError, ValueError):
                pass
            return True, "dash autopilot fence metadata invalid; ask the owner"
        remaining = min(remaining, expires_at - now_ms)
        if remaining < 1:
            try:
                write_fence_cache(host, session, True, None, None, MAX_TTL_MS)
            except (OSError, ValueError):
                pass
            return True, "dash autopilot fence metadata invalid; ask the owner"
        try:
            write_fence_cache(host, session, True, goal_id, expires_at, remaining)
        except (OSError, ValueError):
            return True, "dash autopilot fence cache unavailable; ask the owner"
        denied = result.get("permissionDecision") == "deny"
        reason = result.get("reason")
        return denied, reason if denied else None


def run():
    try:
        if len(sys.argv) != 5 or sys.argv[1] != "--hub-url" or sys.argv[3] != "--host":
            emit_deny("dash autopilot fence: invalid hook configuration; ask the owner")
            return
        base, host = sys.argv[2], sys.argv[4]
        if not HOST_RE.fullmatch(host):
            emit_deny("dash autopilot fence: invalid host identity; ask the owner")
            return
        raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            emit_deny("dash autopilot fence: uninspectable tool input; ask the owner")
            return
        payload = json.loads(raw.decode("utf-8"))
        if (not isinstance(payload, dict) or payload.get("hook_event_name") != "PreToolUse" or
                not isinstance(payload.get("tool_name"), str) or not TOOL_RE.fullmatch(payload["tool_name"])):
            emit_deny("dash autopilot fence: uninspectable tool call; ask the owner")
            return
        session = payload.get("session_id")
        tool_input = payload.get("tool_input")
        if not isinstance(session, str) or not SESSION_RE.fullmatch(session) or not isinstance(tool_input, (dict, list)):
            emit_deny("dash autopilot fence: uninspectable tool call; ask the owner")
            return
        try:
            denied, reason = post_fence(base, host, session, payload["tool_name"], tool_input)
            if denied:
                emit_deny(reason or "dash autopilot fence: ask the owner")
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, TypeError, UnicodeError):
            if cache_deny(host, session):
                emit_deny("dash hub unreachable; autopilot paused, ask the owner")
    except BaseException:
        # Malformed local hook data fails closed; no tool input or exception is logged.
        emit_deny("dash autopilot fence: uninspectable tool call; ask the owner")


if __name__ == "__main__":
    run()
