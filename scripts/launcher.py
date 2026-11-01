#!/usr/bin/env python3
"""Start the user-local companion without depending on a working directory."""

import ast
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time

CORE = "org.zaiko.Companion"
CORE_PATH = "/org/zaiko/Companion"
DESKTOP = "org.zaiko.Desktop"
UUID = "zaiko@znnn.local"
VERSION = "0.1.0"


def dbus(destination, path, method, *args, timeout=5):
    return subprocess.run(
        ["gdbus", "call", "--session", "--dest", destination, "--object-path", path,
         "--method", method, *args],
        capture_output=True, text=True, timeout=timeout, check=False,
    )


def has_owner(name):
    result = dbus("org.freedesktop.DBus", "/org/freedesktop/DBus",
                  "org.freedesktop.DBus.NameHasOwner", name)
    return result.returncode == 0 and result.stdout.strip() == "(true,)"


def core_call(method):
    result = dbus(CORE, CORE_PATH, f"{CORE}.{method}")
    if result.returncode:
        raise RuntimeError(f"Core {method} request failed; try 'zaiko status'.")
    return result.stdout


def locations():
    directory = Path(__file__).resolve().parent
    installed = directory / "zaiko-core"
    if installed.is_file():
        config_root = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config")))
        return installed, config_root / "zaiko" / ".env"
    project = directory.parent
    binary = project / "target/debug/zaiko-core"
    if not binary.is_file():
        binary = project / "target/release/zaiko-core"
    return binary, project / ".env"


def state_directory():
    base = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    path = base / "zaiko"
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def stop():
    if not has_owner(CORE):
        print("Zaiko is stopped.")
        return
    core_call("Quit")
    deadline = time.monotonic() + 5
    while has_owner(CORE):
        if time.monotonic() >= deadline:
            raise RuntimeError("Zaiko has not stopped yet; inspect the core log.")
        time.sleep(0.05)
    print("Zaiko stopped.")


def start(*, present=True):
    binary, config = locations()
    if not binary.is_file():
        raise RuntimeError("Core is not built. Run 'make install' or 'make run' from the project.")
    directory = state_directory()
    lock_fd = os.open(directory / "launch.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(lock_fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not has_owner(CORE):
            log_path = directory / "core.log"
            if log_path.exists() and log_path.stat().st_size > 2_000_000:
                log_path.replace(directory / "core.log.1")
            log_fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            with os.fdopen(log_fd, "ab", buffering=0) as log:
                process = subprocess.Popen(
                    [str(binary), "--config", str(config)],
                    stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                    start_new_session=True,
                )
            deadline = time.monotonic() + 8
            while not has_owner(CORE):
                if process.poll() is not None:
                    raise RuntimeError(f"Core exited at startup. Inspect {log_path}.")
                if time.monotonic() >= deadline:
                    process.terminate()
                    raise RuntimeError(f"Core startup timed out. Inspect {log_path}.")
                time.sleep(0.05)
        if not has_owner(DESKTOP):
            subprocess.run(["gnome-extensions", "enable", UUID],
                           capture_output=True, timeout=10, check=False)
            deadline = time.monotonic() + 3
            while not has_owner(DESKTOP) and time.monotonic() < deadline:
                time.sleep(0.1)
        if not has_owner(DESKTOP):
            raise RuntimeError(
                "Core is running, but the GNOME extension is not available. "
                "Enable Zaiko in Extensions; after a first install, log out and back in "
                "if GNOME has not discovered it, then run 'zaiko' again."
            )
        if present:
            core_call("Show")
        print("Zaiko is running.")


def main():
    args = sys.argv[1:]
    if args in (["--help"], ["-h"]):
        print("usage: zaiko [status|stop|restart|--no-present|--foreground|--version]\n"
              "Start or show the desktop companion. Configuration is read at startup.\n"
              "--no-present starts without opening input.")
        return 0
    if args in (["--version"], ["-V"]):
        print(f"zaiko {VERSION}")
        return 0
    if args == ["--foreground"]:
        binary, config = locations()
        os.execv(str(binary), [str(binary), "--config", str(config)])
    if args == ["--no-present"]:
        start(present=False)
        return 0
    if args == ["status"]:
        if not has_owner(CORE):
            print("Zaiko is stopped.")
            return 1
        import json
        snapshot = json.loads(ast.literal_eval(core_call("GetSnapshot"))[0])
        print(f"Zaiko: {snapshot.get('state', 'unknown')}")
        print(f"Provider: {snapshot.get('provider', 'unset')}")
        print(f"Model: {snapshot.get('model', 'unset')}")
        print(f"Desktop: {'connected' if has_owner(DESKTOP) else 'unavailable'}")
        return 0
    if args == ["stop"]:
        stop()
        return 0
    if args == ["restart"]:
        stop()
        start()
        return 0
    if args:
        raise RuntimeError("Unknown arguments. Run 'zaiko --help'.")
    start()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, SyntaxError) as error:
        print(f"zaiko: {error}", file=sys.stderr)
        sys.exit(2)
