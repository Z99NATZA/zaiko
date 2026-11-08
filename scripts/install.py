#!/usr/bin/env python3
"""Install only Zaiko's files for the current user and preserve local keys."""

import argparse
import ast
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

PROJECT = Path(__file__).resolve().parent.parent
UUID = "zaiko@znnn.local"


def absolute_directory(value, label):
    path = Path(value)
    if not path.is_absolute() or path == Path("/"):
        raise ValueError(f"{label} must be an absolute directory other than /.")
    return path


def atomic_copy(source, destination, mode=0o644):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".zaiko-", dir=destination.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            with source.open("rb") as original:
                shutil.copyfileobj(original, target)
            os.fchmod(target.fileno(), mode)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def enable_extension():
    environment = dict(os.environ, LC_ALL="C")
    result = subprocess.run(["gnome-extensions", "enable", UUID],
                            capture_output=True, env=environment, timeout=15, check=False)
    if result.returncode == 0:
        print("Zaiko extension enabled.")
        return
    # GNOME may discover a newly installed UUID only after the next login.
    current = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"],
                             capture_output=True, text=True, timeout=5, check=False)
    if current.returncode == 0:
        raw = current.stdout.strip()
        if raw.startswith("@as "):
            raw = raw[4:]
        enabled = ast.literal_eval(raw)
        if isinstance(enabled, list) and UUID not in enabled:
            enabled.append(UUID)
            subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", repr(enabled)],
                           capture_output=True, timeout=5, check=True)
    print("GNOME may require logging out and back in to discover the new extension.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, help="Install an already built zaiko-core.")
    parser.add_argument("--config-source", type=Path, help="Initial .env source; existing configuration is preserved.")
    parser.add_argument("--no-enable", action="store_true", help="Install files without changing GNOME settings.")
    options = parser.parse_args()
    home = Path.home()
    data = absolute_directory(os.environ.get("XDG_DATA_HOME", str(home / ".local/share")), "XDG_DATA_HOME")
    config = absolute_directory(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")), "XDG_CONFIG_HOME")
    binaries = absolute_directory(os.environ.get("ZAIKO_BIN_DIR", str(home / ".local/bin")), "ZAIKO_BIN_DIR")
    runtime = data / "zaiko"
    extension = data / "gnome-shell/extensions" / UUID
    config_file = config / "zaiko/.env"
    source = options.config_source or PROJECT / ".env"
    if not source.is_file():
        if options.config_source is not None:
            raise ValueError("The explicit configuration source does not exist.")
        source = PROJECT / ".env.example"
    binary = options.binary
    if binary is None:
        subprocess.run(["cargo", "build", "--release", "--locked"], cwd=PROJECT, check=True)
        binary = PROJECT / "target/release/zaiko-core"
    if not binary.is_file():
        raise ValueError("The core binary does not exist.")
    if not (PROJECT / "gnome-extension/metadata.json").is_file():
        raise ValueError("The GNOME extension is not present.")
    # Prepare runtime, assets and launcher without writing into other projects.
    atomic_copy(binary, runtime / "zaiko-core", 0o755)
    atomic_copy(PROJECT / "scripts/launcher.py", runtime / "launcher.py", 0o755)
    atomic_copy(PROJECT / ".env.example", runtime / ".env.example")
    for item in (PROJECT / "gnome-extension").rglob("*"):
        if item.is_file():
            atomic_copy(item, extension / item.relative_to(PROJECT / "gnome-extension"))
    # Remove only retired Zaiko-owned code; user configuration is preserved.
    retired_art = [f"assets/aiko/aiko-{mood}.png" for mood in ("happy", "neutral", "sad", "shy", "surprised")]
    for obsolete in ("themes.js", "themeSettings.js", "tests/themes.test.mjs", "tests/theme-settings.mjs",
                     *retired_art):
        (extension / obsolete).unlink(missing_ok=True)
    config_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        fd = os.open(config_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print("Existing Zaiko configuration preserved.")
    else:
        with os.fdopen(fd, "wb") as output, source.open("rb") as original:
            shutil.copyfileobj(original, output)
        print("Initial Zaiko configuration installed with private permissions.")
    binaries.mkdir(parents=True, exist_ok=True)
    wrapper = f"#!/bin/sh\nexec python3 {shlex.quote(str(runtime / 'launcher.py'))} \"$@\"\n"
    executable = binaries / "zaiko"
    executable.write_text(wrapper)
    executable.chmod(0o755)
    applications = data / "applications"
    applications.mkdir(parents=True, exist_ok=True)
    desktop_executable = str(executable)
    for character in ('\\', '"', '`', '$'):
        desktop_executable = desktop_executable.replace(character, '\\' + character)
    (applications / "org.zaiko.Companion.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=Zaiko\n"
        "Comment=AI desktop companion\n"
        f'Exec="{desktop_executable}"\n'
        "Icon=face-smile-symbolic\nTerminal=false\nCategories=Utility;\n"
    )
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(applications)], capture_output=True, check=False)
    if not options.no_enable:
        enable_extension()
    print(f"Installed: {executable}")
    print(f"Configuration: {config_file}")
    print("Run 'zaiko' to start, 'zaiko restart' after configuration changes, and 'zaiko stop' to quit.")
    if str(binaries) not in os.environ.get("PATH", "").split(os.pathsep):
        print(f"Add {binaries} to your PATH, or use the absolute launcher path above.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"zaiko install: {error}", file=sys.stderr)
        sys.exit(1)
