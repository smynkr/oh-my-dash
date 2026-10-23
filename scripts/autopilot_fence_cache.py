"""Private per-session autopilot fence cache shared by Claude hooks."""
import sys
import json
import os
import re
import stat
import tempfile
import time

HOST_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_JSON_BYTES = 4096
MAX_TTL_MS = 24 * 60 * 60 * 1000


def _directory(create):
    state_home = os.environ.get("XDG_STATE_HOME")
    if state_home is None:
        home = os.environ.get("HOME") or os.path.expanduser("~")
        if not home or not os.path.isabs(home):
            raise OSError("Fence cache needs an absolute user-state directory")
        state_home = os.path.join(home, ".local", "state")
    elif not os.path.isabs(state_home):
        raise OSError("XDG_STATE_HOME must be absolute")
    directory = os.path.join(state_home, "dash", "fence")
    if create:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    try:
        info = os.lstat(directory)
    except FileNotFoundError:
        return None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise OSError("Fence cache directory is not a private user directory")
    os.chmod(directory, 0o700)
    return directory


def _path(host, session, create=False):
    if not isinstance(host, str) or not HOST_RE.fullmatch(host):
        raise ValueError("Invalid fence cache host")
    if not isinstance(session, str) or not SESSION_RE.fullmatch(session):
        raise ValueError("Invalid fence cache session")
    directory = _directory(create)
    return os.path.join(directory, host + "_" + session + ".json") if directory else None


def write_fence_cache(host, session, active, goal_id=None, expires_at=None, remaining_ttl_ms=0):
    if type(active) is not bool:
        raise ValueError("Invalid fence cache state")
    valid_fallback = goal_id is None and expires_at is None
    valid_metadata = type(goal_id) is int and goal_id > 0 and type(expires_at) is int and expires_at > 0
    if active and (not (valid_fallback or valid_metadata) or type(remaining_ttl_ms) is not int or
                   remaining_ttl_ms < 1 or remaining_ttl_ms > MAX_TTL_MS):
        raise ValueError("Invalid active-goal fence metadata")
    path = _path(host, session, create=True)
    directory = os.path.dirname(path)
    record = {
        "active": active,
        "goal_id": goal_id if active else None,
        "expires_at": expires_at if active else None,
        "remaining_ttl_ms": remaining_ttl_ms if active else 0,
        "seeded_monotonic_ms": time.monotonic_ns() // 1_000_000,
    }
    encoded = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
    descriptor, temporary = tempfile.mkstemp(prefix=".fence-", dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_fence_cache(host, session):
    """Return True/False, None when cold, or "invalid" for a present untrusted cache."""
    try:
        path = _path(host, session, create=False)
        if path is None:
            return None
        info = os.lstat(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return "invalid"
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > MAX_JSON_BYTES:
        return "invalid"
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        opened = os.fstat(descriptor)
        if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.getuid() or opened.st_mode & 0o077 or
                opened.st_ino != info.st_ino or opened.st_dev != info.st_dev or opened.st_size > MAX_JSON_BYTES):
            return "invalid"
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            raw = stream.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            return "invalid"
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict) or set(value) != {
                "active", "goal_id", "expires_at", "remaining_ttl_ms", "seeded_monotonic_ms"}:
            return "invalid"
        if (type(value["active"]) is not bool or type(value["seeded_monotonic_ms"]) is not int or
                value["seeded_monotonic_ms"] < 0):
            return "invalid"
        if not value["active"]:
            return False if value["goal_id"] is None and value["expires_at"] is None and value["remaining_ttl_ms"] == 0 else "invalid"
        fallback = value["goal_id"] is None and value["expires_at"] is None
        metadata = (type(value["goal_id"]) is int and value["goal_id"] > 0 and
                    type(value["expires_at"]) is int and value["expires_at"] > 0)
        if (not (fallback or metadata) or type(value["remaining_ttl_ms"]) is not int or
                value["remaining_ttl_ms"] < 1 or value["remaining_ttl_ms"] > MAX_TTL_MS):
            return "invalid"
        current = time.monotonic_ns() // 1_000_000
        seed = value["seeded_monotonic_ms"]
        if current < seed:
            return True  # Monotonic clock reset across a reboot: deny until the hub refreshes.
        if current - seed >= value["remaining_ttl_ms"]:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            return False
        return True
    except (OSError, UnicodeError, ValueError, TypeError):
        return "invalid"
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def seed_fence_cache(host, session, autopilot):
    if not isinstance(autopilot, dict) or set(autopilot) != {
            "goal_id", "expires_at", "remaining_ttl_ms"}:
        raise ValueError("Invalid active-goal fence metadata")
    goal_id = autopilot.get("goal_id")
    expires_at = autopilot.get("expires_at")
    remaining_ttl_ms = autopilot.get("remaining_ttl_ms")
    if (type(goal_id) is not int or goal_id < 1 or type(expires_at) is not int or expires_at < 1 or
            type(remaining_ttl_ms) is not int or remaining_ttl_ms < 1 or remaining_ttl_ms > MAX_TTL_MS):
        raise ValueError("Invalid active-goal fence metadata")
    remaining = min(remaining_ttl_ms, expires_at - int(time.time() * 1000))
    if remaining < 1 or remaining > MAX_TTL_MS:
        raise ValueError("Expired or oversized active-goal fence metadata")
    write_fence_cache(host, session, True, goal_id, expires_at, remaining)


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--seed":
        try:
            seed_fence_cache(sys.argv[2], sys.argv[3], json.load(sys.stdin))
        except BaseException:
            sys.exit(1)
