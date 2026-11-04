#!/usr/bin/env python3
"""Isolated installer/core checks. Never reads the workspace .env or calls an API."""

import argparse
import ast
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time


PROJECT = Path(__file__).resolve().parents[1]
CORE_BUS = "org.zaiko.Companion"
CORE_PATH = "/org/zaiko/Companion"
VARIABLES = {
    "ZAIKO_LLM_PROVIDER", "ZAIKO_LLM_MODEL", "OPENAI_API_KEY", "DEEPSEEK_API_KEY"
}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run(args, *, env=None, cwd=None, timeout=12, success=True):
    result = subprocess.run(
        [str(arg) for arg in args], env=env, cwd=cwd,
        text=True, capture_output=True, timeout=timeout,
    )
    if success and result.returncode != 0:
        raise AssertionError(
            f"Command failed ({result.returncode}): {args[0]}\n"
            f"{result.stdout[-2000:]}{result.stderr[-2000:]}"
        )
    return result


def variable_names(path):
    # Callers pass the public example or QA-owned temporary files only.
    names = re.findall(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=", path.read_text(), re.M)
    check(len(names) == len(set(names)), "Duplicate configuration variable")
    return set(names)


def call(method, *args, success=True):
    return run([
        "gdbus", "call", "--session", "--dest", CORE_BUS,
        "--object-path", CORE_PATH, "--method", f"{CORE_BUS}.{method}", *args,
    ], success=success)


def snapshot():
    reply = ast.literal_eval(call("GetSnapshot").stdout.strip())
    return json.loads(reply[0])


def eventually(predicate, description, timeout=6):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.04)
    raise AssertionError(f"Timed out: {description}")


def has_owner(name):
    result = run([
        "gdbus", "call", "--session", "--dest", "org.freedesktop.DBus",
        "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.NameHasOwner", name,
    ])
    return result.stdout.strip() == "(true,)"


def fixture_requests(path):
    if not path.exists():
        return []
    return [item for item in json.loads(path.read_text()) if item["method"] == "OpenApp"]


def session_checks(layout):
    """Executed under dbus-run-session, never the user's real session bus."""
    launcher = Path(layout["launcher"])
    working = Path(layout["working"])
    log_path = working / "desktop requests.json"
    fixture = None
    try:
        initial = run([launcher, "status"], cwd=working, success=False)
        check(not has_owner(CORE_BUS), "status unexpectedly started the core")
        # The launcher may report inactive via text or a nonzero exit code.
        check("running" not in initial.stdout.lower() or "not running" in initial.stdout.lower(),
              "Inactive status claimed the core was running")

        started = run([launcher], cwd=working, success=False)
        eventually(lambda: has_owner(CORE_BUS), "installed launcher starts core from unrelated cwd")
        check(started.returncode == 0 or "extension" in (started.stdout + started.stderr).lower(),
              "Missing desktop did not produce an actionable extension message")
        current = snapshot()
        check(current["provider"] == "openai", "Installed configuration did not select OpenAI")
        check(current["model"] == "qa-local-no-api", "Installed configuration was not loaded")
        check(layout["synthetic_key"] not in json.dumps(current), "Snapshot exposed synthetic key")
        call("OpenApp", "qa-no-desktop", "terminal", success=False)
        eventually(lambda: snapshot()["state"] in ("idle", "error"), "missing desktop result")
        check(snapshot().get("error") or any(m.get("role") == "tool" for m in snapshot()["messages"]),
              "Missing desktop failure was not recoverable in snapshot")

        fixture = subprocess.Popen(
            ["gjs", str(PROJECT / "tests" / "desktop-fixture.js"), str(log_path)],
            cwd=working, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        )
        eventually(lambda: has_owner("org.zaiko.Desktop"), "test desktop service readiness")
        run([launcher, "--no-present"], cwd=working)
        check(not log_path.exists(), "--no-present unexpectedly requested desktop presentation")
        call("OpenApp", "qa-first", "terminal")
        eventually(lambda: len(fixture_requests(log_path)) == 1, "first tool dispatch")
        call("OpenApp", "qa-overlap", "vscode", success=False)
        eventually(lambda: snapshot()["state"] in ("idle", "error"), "first tool completion")
        check(len(fixture_requests(log_path)) == 1, "Concurrent active request was executed")
        call("OpenApp", "qa-first", "terminal", success=False)
        time.sleep(0.1)
        check(len(fixture_requests(log_path)) == 1, "Duplicate request ID executed twice")

        marker = working / "injection-marker"
        for index, alias in enumerate(("note", "unknown", f"terminal;touch {marker}")):
            call("OpenApp", f"qa-invalid-{index}", alias, success=False)
            eventually(lambda: snapshot()["state"] in ("idle", "error"), "invalid alias result")
        check(len(fixture_requests(log_path)) == 1, "Invalid alias reached desktop dispatch")
        check(not marker.exists(), "Alias caused shell execution")

        call("OpenApp", "qa-second", "vscode")
        eventually(lambda: len(fixture_requests(log_path)) == 2, "VS Code tool dispatch")
        eventually(lambda: snapshot()["state"] in ("idle", "error"), "VS Code completion")
        check([r["app"] for r in fixture_requests(log_path)] == ["terminal", "vscode"],
              "Supported tool set differs from terminal/vscode")
        run([launcher, "status"], cwd=working)
        run([launcher], cwd=working)
        check(len(fixture_requests(log_path)) == 2, "Showing the companion replayed an app request")
        check(layout["synthetic_key"] not in json.dumps(snapshot()), "Snapshot exposed synthetic key")
        run([launcher, "stop"], cwd=working)
        eventually(lambda: not has_owner(CORE_BUS), "stop releases core service")
        run([launcher, "stop"], cwd=working)
        run([launcher, "restart"], cwd=working)
        eventually(lambda: has_owner(CORE_BUS), "restart starts the core")
        check(snapshot()["messages"] == [], "Restart retained the previous in-memory session")
        run([launcher, "stop"], cwd=working)
        eventually(lambda: not has_owner(CORE_BUS), "final stop releases service")
        print("PASS isolated D-Bus lifecycle, tools, duplicate/overlap rejection, and no shell execution from app aliases")
    finally:
        if has_owner(CORE_BUS):
            call("Quit", success=False)
        if fixture:
            fixture.terminate()
            try:
                fixture.communicate(timeout=3)
            except subprocess.TimeoutExpired:
                fixture.kill()
                fixture.communicate()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=PROJECT / "target/debug/zaiko-core")
    parser.add_argument("--session", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.session:
        session_checks(json.loads(args.session.read_text()))
        return
    for program in ("dbus-run-session", "gdbus", "gjs"):
        check(shutil.which(program), f"Missing test dependency: {program}")
    check(args.binary.is_file(), "Build zaiko-core first or pass --binary PATH")
    check(variable_names(PROJECT / ".env.example") == VARIABLES,
          "Public example does not have the four documented variables")
    print("PASS public configuration variable names (workspace .env was not read)")

    with tempfile.TemporaryDirectory(prefix="zaiko QA spaces ") as temporary:
        base = Path(temporary)
        source = base / "source with spaces"
        source.mkdir()
        # Copy only public install inputs; never traverse the workspace .env.
        for name in ("scripts", "gnome-extension"):
            shutil.copytree(PROJECT / name, source / name)
        shutil.copy2(PROJECT / ".env.example", source / ".env.example")
        env = os.environ.copy()
        for name in VARIABLES:
            env.pop(name, None)
        env.update({
            "HOME": str(base / "home with spaces"),
            "XDG_DATA_HOME": str(base / "data with spaces"),
            "XDG_CONFIG_HOME": str(base / "config with spaces"),
            "XDG_CACHE_HOME": str(base / "cache with spaces"),
            "XDG_STATE_HOME": str(base / "state with spaces"),
            "ZAIKO_BIN_DIR": str(base / "bin with spaces"),
        })
        for name in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "ZAIKO_BIN_DIR"):
            Path(env[name]).mkdir(parents=True, exist_ok=True)
        commands = base / "test commands"
        commands.mkdir()
        extension_command = commands / "gnome-extensions"
        extension_command.write_text("#!/bin/sh\nexit 1\n")
        extension_command.chmod(0o755)
        env["PATH"] = str(commands) + os.pathsep + env.get("PATH", "")
        synthetic_key = "qa-synthetic-key-never-sent"
        config_source = base / "synthetic configuration"
        fixture_bytes = (
            "# QA-owned synthetic configuration; not a credential.\n"
            "ZAIKO_LLM_PROVIDER=openai\nZAIKO_LLM_MODEL=qa-local-no-api\n"
            f"OPENAI_API_KEY={synthetic_key}\nDEEPSEEK_API_KEY=\n"
        ).encode()
        config_source.write_bytes(fixture_bytes)
        install = [sys.executable, source / "scripts/install.py", "--binary", args.binary.resolve(),
                   "--config-source", config_source, "--no-enable"]
        missing_source = run([
            sys.executable, source / "scripts/install.py", "--binary", args.binary.resolve(),
            "--config-source", base / "missing configuration", "--no-enable",
        ], env=env, cwd=base, success=False)
        check(missing_source.returncode != 0, "Missing explicit config source silently fell back")
        check(not (Path(env["XDG_DATA_HOME"]) / "zaiko").exists(),
              "Missing explicit config source caused a partial installation")
        run(install, env=env, cwd=base)
        data = Path(env["XDG_DATA_HOME"]) / "zaiko"
        installed_config = Path(env["XDG_CONFIG_HOME"]) / "zaiko/.env"
        check(installed_config.read_bytes() == fixture_bytes, "Initial config copy changed content")
        check(variable_names(installed_config) == variable_names(source / ".env.example"),
              "Generated isolated config/example variable names differ")
        check(installed_config.stat().st_mode & 0o077 == 0, "Installed config permits group/other access")
        extension = Path(env["XDG_DATA_HOME"]) / "gnome-shell/extensions/zaiko@znnn.local"
        retired = ("themes.js", "themeSettings.js", "tests/themes.test.mjs", "tests/theme-settings.mjs")
        for name in retired:
            obsolete = extension / name
            obsolete.parent.mkdir(parents=True, exist_ok=True)
            obsolete.write_text("// QA retired module\n")
        marker = extension / "user-preserved.txt"
        marker.write_text("QA unrelated file")
        legacy_ui = Path(env["XDG_CONFIG_HOME"]) / "zaiko/ui.json"
        legacy_ui.write_text('{"theme":"red","syncZhyprbola":true}')
        config_source.write_text("OPENAI_API_KEY=qa-replacement-must-not-win\n")
        run(install, env=env, cwd=base)
        check(installed_config.read_bytes() == fixture_bytes, "Reinstall overwrote existing config")
        check(all(not (extension / name).exists() for name in retired), "Reinstall retained retired theme modules")
        check(marker.read_text() == "QA unrelated file", "Cleanup removed unrelated files")
        check(legacy_ui.read_text() == '{"theme":"red","syncZhyprbola":true}',
              "Reinstall changed preserved legacy preferences")
        launcher = Path(env["ZAIKO_BIN_DIR"]) / "zaiko"
        check(launcher.is_file() and os.access(launcher, os.X_OK), "Launcher not installed executable")
        check((data / "zaiko-core").is_file(), "Core binary not installed")
        check((data / "launcher.py").is_file(), "Runtime launcher not installed")
        check((data / ".env.example").is_file(), "Public configuration example not installed")
        extension = Path(env["XDG_DATA_HOME"]) / "gnome-shell/extensions/zaiko@znnn.local"
        check((extension / "extension.js").is_file(), "GNOME extension not installed")
        for folder in (data, extension):
            for path in folder.rglob("*"):
                check(not path.is_symlink(), "Installed tree contains a source-dependent symlink")
        # Removing this QA-created source proves installed launch does not need it.
        shutil.rmtree(source)
        working = base / "unrelated working directory"
        working.mkdir()
        run([launcher, "--help"], env=env, cwd=working)
        run([launcher, "--version"], env=env, cwd=working)
        print("PASS isolated install, space-containing paths, config preservation, source-independent help")
        layout = working / "qa layout.json"
        layout.write_text(json.dumps({
            "launcher": str(launcher), "working": str(working), "synthetic_key": synthetic_key,
        }))
        result = run([
            "dbus-run-session", "--", sys.executable, Path(__file__).resolve(), "--session", layout,
        ], env=env, cwd=working, timeout=45)
        print(result.stdout.strip())
        print("NOT VERIFIED: actual GNOME UI, real app activation, and live provider APIs")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError, subprocess.TimeoutExpired) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
