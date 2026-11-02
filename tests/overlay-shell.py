#!/usr/bin/env python3
"""Render/test character UI in an isolated GNOME compositor; no live AI calls."""

import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


PROJECT = Path(__file__).resolve().parents[1]


def main():
    for program in ('gnome-shell', 'dbus-run-session', 'gsettings'):
        if not shutil.which(program):
            raise RuntimeError(f'Missing desktop test dependency: {program}')
    root = Path(tempfile.mkdtemp(prefix='zaiko-overlay-qa-'))
    print(f'Desktop QA artifacts: {root}', flush=True)
    for name in ('home', 'data', 'config', 'cache', 'state', 'runtime'):
        (root / name).mkdir(mode=0o700)
    # Old preferences must have no effect on the fixed-style extension.
    (root / 'config/zaiko').mkdir()
    (root / 'config/zaiko/ui.json').write_text('{"theme":"red","syncZhyprbola":true}')
    (root / 'config/zhyprbola').mkdir()
    (root / 'config/zhyprbola/theme').write_text('white-sky')
    extension = root / 'data/gnome-shell/extensions/zaiko@znnn.local'
    shutil.copytree(PROJECT / 'gnome-extension', extension)
    script = (extension / 'extension.js').read_text().replace(
        'export default class ZaikoExtension', 'class ZaikoExtension', 1)
    script += '\n' + (PROJECT / 'tests/overlay-fixture.js').read_text()
    (extension / 'extension.js').write_text(script)
    env = os.environ.copy()
    env.update({
        'HOME': str(root / 'home'), 'XDG_DATA_HOME': str(root / 'data'),
        'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_CACHE_HOME': str(root / 'cache'),
        'XDG_STATE_HOME': str(root / 'state'), 'XDG_RUNTIME_DIR': str(root / 'runtime'),
        'XDG_SESSION_TYPE': 'wayland', 'GSETTINGS_BACKEND': 'dconf', 'NO_AT_BRIDGE': '1',
    })
    for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'SESSION_MANAGER', 'DBUS_SESSION_BUS_ADDRESS',
                 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'):
        env.pop(name, None)
    runner = root / 'run.sh'
    runner.write_text('''#!/bin/sh
set -e
gsettings set org.gnome.shell enabled-extensions "['zaiko@znnn.local']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.desktop.interface font-name 'Sans 11'
exec gnome-shell --headless --virtual-monitor=1440x1000 --wayland-display=zaiko-qa --no-x11
''')
    result_path = root / 'home/qa-result.json'
    with (root / 'shell.log').open('w') as log:
        process = subprocess.Popen(['dbus-run-session', '--', 'sh', str(runner)],
                                   env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            deadline = time.monotonic() + 70
            while time.monotonic() < deadline:
                if result_path.exists():
                    result = json.loads(result_path.read_text())
                    if not result['ok']:
                        raise RuntimeError(json.dumps(result, ensure_ascii=False))
                    errors = re.findall(r'JS ERROR:[^\n]*(?:\n[^\n]+)*',
                                        (root / 'shell.log').read_text())
                    if any('/extensions/zaiko@znnn.local/' in error for error in errors):
                        raise RuntimeError(f'Uncaught UI exception; see {root}/shell.log')
                    print(f"PASS {result['checked']}")
                    print('NOT VERIFIED: physical Thai IME or live provider APIs')
                    return
                if process.poll() is not None:
                    raise RuntimeError(f'GNOME exited with status {process.returncode}; see {root}/shell.log')
                time.sleep(0.1)
            raise RuntimeError(f'Desktop QA timed out; see {root}/shell.log')
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
