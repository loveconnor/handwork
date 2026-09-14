"""Offline npm updater probe. Run after zig build: python3 tests/e2e/npm-update.py."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

binary = Path(__file__).resolve().parents[2] / "zig-out/bin/handwork"
with tempfile.TemporaryDirectory(prefix="handwork-npm-update-") as tmp:
    root = Path(tmp).resolve()
    prefix = root / "node installation"
    installed = prefix / "lib/node_modules/handwork/zig-out/bin/handwork"
    installed.parent.mkdir(parents=True)
    shutil.copy2(binary, installed)
    npm = prefix / "bin/npm"
    npm.parent.mkdir()
    npm.write_text('''#!/bin/sh
printf '%s\\n' "$@" >> "$NPM_LOG"
if [ "$1" = view ]; then
    printf '%s\\n' "$NPM_VERSION"
    exit "${NPM_FETCH_EXIT:-0}"
fi
exit "${NPM_INSTALL_EXIT:-0}"
''')
    npm.chmod(0o755)
    home = root / "home"
    home.mkdir()
    log = root / "npm.log"
    env = {k: v for k, v in os.environ.items() if not k.startswith("HANDWORK_")}
    env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), NPM_LOG=str(log))

    for version, fetch_exit, install_exit, expected in [
        ("999.0.0", "0", "0", "upgraded"),
        ("0.0.1", "0", "0", "up_to_date"),
        ("invalid", "0", "0", "error"),
        ("999.0.0", "1", "0", "error"),
        ("999.0.0", "0", "1", "error"),
    ]:
        log.write_text("")
        env.update(NPM_VERSION=version, NPM_FETCH_EXIT=fetch_exit, NPM_INSTALL_EXIT=install_exit)
        result = subprocess.run([str(installed), "update", "--json"], env=env, capture_output=True, text=True)
        data = json.loads(result.stdout)
        assert (result.returncode == 0) == (expected != "error"), (result, data)
        assert "error" in data if expected == "error" else data["status"] == expected, data
        args = log.read_text().splitlines()
        should_install = version == "999.0.0" and fetch_exit == "0"
        assert ("install" in args) == should_install, args
        if should_install:
            assert args[args.index("--prefix") + 1] == str(prefix), args
            assert "handwork@999.0.0" in args, args

    result = subprocess.run([str(binary), "update", "--json"], env=env, capture_output=True, text=True)
    assert result.returncode != 0 and "not a global npm installation" in json.loads(result.stdout)["error"], result
    help_result = subprocess.run([str(binary), "update", "--help"], env=env, capture_output=True, text=True)
    assert help_result.returncode == 0, help_result
print("npm update: newer/older versions, malformed metadata, fetch/install failures, prefix, source-build guard, and help passed")
