#!/usr/bin/env python3
"""Antigravity (agy) lifecycle hook bridge for Dash visibility, replies, and ask_question."""
import argparse
import json
import os
import secrets
import signal
import sqlite3
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def default_output(event_name):
    if event_name in ("PreToolUse", "Stop"):
        return {"decision": "allow"}
    return {}


def load_config(argv):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cfg_path = os.path.join(script_dir, "dash-config.json")
    file_cfg = {}
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                loaded = json.load(fh)
                if isinstance(loaded, dict):
                    file_cfg = loaded
        except (OSError, ValueError):
            file_cfg = {}

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--url", default=None)
    parser.add_argument("--reply-base", dest="reply_base", default=None)
    parser.add_argument("--no-replies", dest="no_replies", action="store_true")
    parser.add_argument("--host", default=None)
    parser.add_argument("--account", default=None)
    parser.add_argument("--remote-questions", dest="remote_questions", action="store_true", default=None)
    parser.add_argument("--no-remote-questions", dest="no_remote_questions", action="store_true")
    parser.add_argument("--stop-wait", dest="stop_wait", type=int, default=None)
    parser.add_argument("--question-timeout-ms", dest="question_timeout_ms", type=int, default=None)
    args, _ = parser.parse_known_args(argv)

    env_url = os.environ.get("DASH_AGY_URL")
    env_reply = os.environ.get("DASH_AGY_REPLY_BASE")
    url = args.url or env_url or file_cfg.get("url") or "http://127.0.0.1:4777/ingest/agy"

    if args.no_replies or file_cfg.get("repliesEnabled") is False:
        reply_base = ""
    else:
        reply_base = args.reply_base if args.reply_base is not None else (
            env_reply if env_reply is not None else file_cfg.get("replyBase")
        )
        if reply_base is None:
            parts = urlsplit(url)
            reply_base = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else ""

    host = args.host or os.environ.get("DASH_AGY_HOST") or file_cfg.get("host") or ""
    account = args.account or os.environ.get("DASH_AGY_ACCOUNT") or file_cfg.get("account") or ""

    env_rq = os.environ.get("DASH_AGY_REMOTE_QUESTIONS")
    if args.no_remote_questions:
        remote_questions = False
    elif args.remote_questions:
        remote_questions = True
    elif env_rq is not None:
        remote_questions = env_rq.strip() in ("1", "true", "yes")
    else:
        remote_questions = bool(file_cfg.get("remoteQuestions", False))

    env_sw = os.environ.get("DASH_AGY_STOP_WAIT_SEC")
    if args.stop_wait is not None:
        stop_wait = args.stop_wait
    elif env_sw and env_sw.strip().isdigit():
        stop_wait = int(env_sw.strip())
    elif isinstance(file_cfg.get("stopWaitSec"), int):
        stop_wait = file_cfg["stopWaitSec"]
    else:
        stop_wait = 5
    stop_wait = max(0, min(55, stop_wait))

    env_qt = os.environ.get("DASH_AGY_QUESTION_TIMEOUT_MS")
    if args.question_timeout_ms is not None:
        q_timeout = args.question_timeout_ms
    elif env_qt and env_qt.strip().isdigit():
        q_timeout = int(env_qt.strip())
    elif isinstance(file_cfg.get("questionTimeoutMs"), int):
        q_timeout = file_cfg["questionTimeoutMs"]
    else:
        q_timeout = 55000
    q_timeout = max(1000, min(600000, q_timeout))

    return {
        "url": url,
        "reply_base": reply_base.rstrip("/") if isinstance(reply_base, str) else "",
        "host": host.strip() if isinstance(host, str) else "",
        "account": account.strip() if isinstance(account, str) else "",
        "remote_questions": remote_questions,
        "stop_wait": stop_wait,
        "question_timeout_ms": q_timeout,
    }


def request_json(opener, url, method, headers, body, timeout):
    encoded = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = Request(url, data=encoded, headers=headers, method=method)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except HTTPError as err:
        return err.code, err.read()


def make_headers(cfg):
    headers = {
        "Content-Type": "application/json",
        "X-Dash-Entrypoint": "cli",
        "X-Dash-Harness": "agy",
    }
    if cfg["host"]:
        headers["X-Dash-Host"] = cfg["host"]
    if cfg["account"]:
        headers["X-Dash-Account-Alias"] = cfg["account"]
    return headers


def lookup_summary_meta(session_id, transcript_path):
    roots = []
    if isinstance(transcript_path, str) and "/brain/" in transcript_path:
        roots.append(transcript_path.split("/brain/")[0])
    env_home = os.environ.get("DASH_AGY_HOME", "").strip()
    if env_home:
        roots.extend([p.strip() for p in env_home.split(":") if p.strip()])
    else:
        home = os.path.expanduser("~")
        roots.extend([
            os.path.join(home, ".gemini", "antigravity-cli"),
            os.path.join(home, ".gemini", "antigravity"),
            os.path.join(home, ".gemini", "antigravity-ide"),
        ])
    seen = set()
    for root in roots:
        if not root or root in seen:
            continue
        seen.add(root)
        db_path = os.path.join(root, "conversation_summaries.db")
        if not os.path.isfile(db_path):
            continue
        conn = None
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=0.2)
            cur = conn.execute(
                "SELECT title, nesting_depth, parent_conversation_id, killed FROM conversation_summaries WHERE conversation_id = ?",
                (session_id,),
            )
            row = cur.fetchone()
            if row is not None:
                title, nesting_depth, parent_id, killed = row
                is_subagent = bool((nesting_depth or 0) > 0 or (isinstance(parent_id, str) and parent_id.strip()) or killed)
                return {"title": title.strip() if isinstance(title, str) and title.strip() else None, "skip": is_subagent}
        except sqlite3.Error:
            pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
    return {"title": None, "skip": False}


def tail_lines(path, max_bytes=4 * 1024 * 1024):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            read_len = min(size, max_bytes)
            fh.seek(size - read_len, os.SEEK_SET)
            raw = fh.read(read_len).decode("utf-8", errors="replace")
            if size > read_len:
                nl = raw.find("\n")
                if nl >= 0:
                    raw = raw[nl + 1:]
            return [line for line in raw.splitlines() if line.strip()]
    except OSError:
        return []


def extract_latest_user_prompt(transcript_path):
    if not isinstance(transcript_path, str) or not transcript_path or not os.path.isfile(transcript_path):
        return None
    for line in reversed(tail_lines(transcript_path)):
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("type") == "USER_INPUT" and item.get("source") in ("USER_EXPLICIT", None):
            content = item.get("content")
            if isinstance(content, str) and content.strip():
                return content
    return None


def extract_latest_response(transcript_path):
    if not isinstance(transcript_path, str) or not transcript_path or not os.path.isfile(transcript_path):
        return None
    entries = []
    for line in tail_lines(transcript_path):
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                entries.append(item)
        except ValueError:
            continue
    if not entries:
        return None
    last_user_idx = -1
    for i, entry in enumerate(entries):
        if entry.get("type") == "USER_INPUT" and entry.get("source") in ("USER_EXPLICIT", None):
            last_user_idx = i
    candidates = entries[last_user_idx + 1:] if last_user_idx >= 0 else entries
    chosen = None
    for entry in reversed(candidates):
        if entry.get("type") != "PLANNER_RESPONSE":
            continue
        content = entry.get("content")
        if isinstance(content, str) and content.strip():
            chosen = entry
            break
    if chosen is None:
        return None
    trunc = chosen.get("truncated_fields")
    step_index = chosen.get("step_index")
    if isinstance(trunc, list) and "content" in trunc and isinstance(step_index, int):
        full_path = os.path.join(os.path.dirname(transcript_path), "transcript_full.jsonl")
        for line in reversed(tail_lines(full_path, 16 * 1024 * 1024)):
            try:
                full_entry = json.loads(line)
                if isinstance(full_entry, dict) and full_entry.get("step_index") == step_index:
                    full_content = full_entry.get("content")
                    if isinstance(full_content, str) and full_content.strip():
                        return full_content
                    break
            except ValueError:
                continue
    return chosen.get("content")


def format_reply(reply_obj):
    text = reply_obj.get("text", "") if isinstance(reply_obj, dict) else ""
    source = reply_obj.get("source", "web") if isinstance(reply_obj, dict) else "web"
    if source == "autopilot":
        return f"[dash autopilot, not the owner]:\n{text}"
    origin = "the dashboard" if source == "web" else "Telegram"
    return f"[dash] The owner replied from {origin}. Treat this as their next message:\n{text}"


def poll_and_commit_reply(opener, cfg, headers, session_id, wait_sec):
    base = cfg["reply_base"]
    if not base:
        return None
    waiter = "agy_" + secrets.token_urlsafe(12)
    started = int(time.time() * 1000)
    wait_url = base + "/reply/wait/agy?" + urlencode({
        "session": session_id,
        "waiter": waiter,
        "started": started,
        "wait": wait_sec,
        "commit": "1",
    })
    try:
        status, body = request_json(opener, wait_url, "GET", headers, None, max(3, wait_sec + 3))
    except (OSError, URLError, TimeoutError, ValueError):
        return None
    if status != 200:
        return None
    try:
        reply_obj = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(reply_obj, dict) or not isinstance(reply_obj.get("id"), int) or not isinstance(reply_obj.get("text"), str):
        return None
    reply_id = reply_obj["id"]
    try:
        c_status, _ = request_json(opener, base + "/reply/commit", "POST", headers, {"id": reply_id, "waiter": waiter}, 3)
    except (OSError, URLError, TimeoutError, ValueError):
        return None
    if c_status != 200:
        try:
            request_json(opener, base + "/reply/ack", "POST", headers, {"id": reply_id, "waiter": waiter, "outcome": "deferred"}, 2)
        except (OSError, URLError, TimeoutError, ValueError):
            pass
        return None
    try:
        request_json(opener, base + "/reply/ack", "POST", headers, {"id": reply_id, "waiter": waiter, "outcome": "sent"}, 3)
    except (OSError, URLError, TimeoutError, ValueError):
        pass
    return format_reply(reply_obj)


def handle_remote_question(opener, cfg, headers, payload, session_id, title):
    base = cfg["reply_base"]
    tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
    tool_use_id = tool_call.get("id") or payload.get("tool_use_id") or f"ask_{payload.get('stepIdx', 0)}"
    tool_args = tool_call.get("args") if isinstance(tool_call.get("args"), dict) else payload.get("tool_input")
    questions = tool_args.get("questions") if isinstance(tool_args, dict) else None
    if not base or not isinstance(tool_use_id, str) or not tool_use_id or not isinstance(questions, list) or not (1 <= len(questions) <= 16):
        return None

    timeout_ms = cfg["question_timeout_ms"]
    question_id = secrets.token_urlsafe(32)
    deadline = time.monotonic() + timeout_ms / 1000.0
    reg_body = {
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "invocationId": question_id,
        "questions": questions,
        "timeoutMs": timeout_ms,
    }
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        wps = payload.get("workspacePaths")
        if isinstance(wps, list) and wps and isinstance(wps[0], str):
            cwd = wps[0]
    if isinstance(cwd, str) and cwd:
        reg_body["cwd"] = cwd
    if isinstance(title, str) and title:
        reg_body["title"] = title
    tp = payload.get("transcriptPath")
    if isinstance(tp, str) and tp:
        reg_body["transcriptPath"] = tp

    registered = False

    def _on_alarm(_sig, _frame):
        raise TimeoutError("ask_question hook deadline")

    prev_handler = signal.signal(signal.SIGALRM, _on_alarm)
    signal.setitimer(signal.ITIMER_REAL, max(0.05, deadline - time.monotonic()))
    try:
        rem = deadline - time.monotonic()
        if rem <= 0:
            return None
        status, _ = request_json(opener, base + "/question/register", "POST", headers, reg_body, min(4.0, rem))
        if status != 201:
            return None
        registered = True
        while True:
            rem = deadline - time.monotonic()
            if rem <= 0:
                return None
            wait_sec = max(1, min(3, int(rem)))
            wait_url = base + "/question/wait?" + urlencode({
                "session": session_id,
                "toolUseId": tool_use_id,
                "question": question_id,
                "wait": wait_sec,
            })
            w_status, w_body = request_json(opener, wait_url, "GET", headers, None, min(4.0, rem + 0.5))
            if w_status == 204:
                continue
            if w_status == 404:
                registered = False
                return None
            if w_status != 200:
                return None
            parsed = json.loads(w_body.decode("utf-8"))
            answers = parsed.get("answers") if isinstance(parsed, dict) else None
            if not isinstance(answers, dict) or not answers:
                return None
            lines = ["[dash] The owner answered your ask_question prompt from Dash (proceed with these answers; do not re-ask):"]
            for q_text, ans in answers.items():
                if isinstance(q_text, str) and isinstance(ans, str):
                    lines.append(f"- {q_text}: {ans}")
            registered = False
            return {"decision": "deny", "reason": "\n".join(lines)}
    except (OSError, URLError, TimeoutError, ValueError, UnicodeDecodeError):
        return None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        if registered:
            try:
                signal.setitimer(signal.ITIMER_REAL, 2.0)
                cancel_url = base + "/question/cancel?" + urlencode({
                    "session": session_id,
                    "toolUseId": tool_use_id,
                    "question": question_id,
                })
                request_json(opener, cancel_url, "DELETE", headers, None, 1.8)
            except BaseException:
                pass
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prev_handler)


def post_ingest(opener, cfg, headers, body):
    if not cfg["url"]:
        return
    try:
        request_json(opener, cfg["url"], "POST", headers, body, 3.0)
    except (OSError, URLError, TimeoutError, ValueError):
        pass


def main():
    raw_in = sys.stdin.read()
    try:
        payload = json.loads(raw_in) if raw_in.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        emit({})
        return

    event_name = payload.get("hookEventName") or payload.get("hook_event_name") or ""
    session_id = payload.get("conversationId") or payload.get("sessionId") or payload.get("session_id") or ""
    if not isinstance(session_id, str) or not session_id:
        emit(default_output(event_name))
        return

    meta = lookup_summary_meta(session_id, payload.get("transcriptPath"))
    if meta.get("skip"):
        emit(default_output(event_name))
        return

    cfg = load_config(sys.argv[1:])
    opener = build_opener(NoRedirect)
    headers = make_headers(cfg)
    ingest_body = dict(payload)
    if meta.get("title") and not ingest_body.get("title"):
        ingest_body["title"] = meta["title"]

    if event_name == "SessionStart":
        post_ingest(opener, cfg, headers, ingest_body)
        emit({})
        return

    if event_name == "PreInvocation":
        inv_num = payload.get("invocationNum", 0)
        if not isinstance(inv_num, int) or inv_num <= 1:
            if not (ingest_body.get("prompt") or ingest_body.get("userPrompt") or ingest_body.get("lastUserInput")):
                latest_prompt = extract_latest_user_prompt(payload.get("transcriptPath"))
                if latest_prompt:
                    ingest_body["prompt"] = latest_prompt
            post_ingest(opener, cfg, headers, ingest_body)
            injected = poll_and_commit_reply(opener, cfg, headers, session_id, 0)
            if injected:
                emit({"injectSteps": [{"userMessage": injected}]})
                return
        emit({})
        return

    if event_name == "PreToolUse":
        tool_call = payload.get("toolCall") if isinstance(payload.get("toolCall"), dict) else {}
        tool_name = tool_call.get("name") or payload.get("tool_name")
        if tool_name == "ask_question" and cfg["remote_questions"] and cfg["reply_base"]:
            decision = handle_remote_question(opener, cfg, headers, ingest_body, session_id, meta.get("title"))
            if decision is not None:
                emit(decision)
                return
        post_ingest(opener, cfg, headers, ingest_body)
        emit({"decision": "allow"})
        return

    if event_name == "PostToolUse":
        post_ingest(opener, cfg, headers, ingest_body)
        emit({})
        return

    if event_name == "Stop":
        term_reason = payload.get("terminationReason") or "NO_TOOL_CALL"
        if term_reason != "USER_CANCELED" and not ingest_body.get("last_assistant_message"):
            latest = extract_latest_response(payload.get("transcriptPath"))
            if latest:
                ingest_body["last_assistant_message"] = latest
        post_ingest(opener, cfg, headers, ingest_body)
        if term_reason == "NO_TOOL_CALL" and not payload.get("error") and cfg["reply_base"]:
            continued = poll_and_commit_reply(opener, cfg, headers, session_id, cfg["stop_wait"])
            if continued:
                emit({"decision": "continue", "reason": continued})
                return
        emit({"decision": "allow"})
        return

    post_ingest(opener, cfg, headers, ingest_body)
    emit(default_output(event_name))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        emit({"decision": "allow"})
