#!/usr/bin/env python3
"""Verify the restored broken and known-correct controls before scoring."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
spec = importlib.util.spec_from_file_location('claude_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec); spec.loader.exec_module(runner)
s = json.loads(Path(__file__).with_name('bullmq-state-2026-10-04.json').read_text())
repo = Path(s['fixture']); folder = repo.parent.parent
out = Path(__file__).with_name('bullmq-controls-2026-10-04.json')
port = runner.bull.redis_start(folder)
env = runner.environment(0); env.update(REDIS_HOST='127.0.0.1', REDIS_PORT=str(port))
changes = [('src/commands/includes/removeLock.lua', 'if lockToken then', 'if lockToken == token then'), ('src/commands/extendLock-2.lua', 'if rcall("EXISTS", KEYS[1]) == 1 then', 'if rcall("GET", KEYS[1]) == ARGV[1] then'), ('src/commands/extendLocks-1.lua', 'if currentToken then', 'if currentToken == token then')]
def verify():
    r = subprocess.run([runner.NODE, str(repo.parent / 'verify.cjs'), str(repo), str(port)], cwd=repo, env=env, text=True, capture_output=True, timeout=120)
    return r.returncode, json.loads(r.stdout)
try:
    code, broken = verify(); assert code == 1 and sum(not c['pass'] for c in broken) >= 6
    for name, old, new in changes:
        p = repo / name
        source = subprocess.check_output(['git', 'show', s['upstream_commit'] + ':' + name], cwd=folder / 'upstream')
        p.write_bytes(source)
    subprocess.run(['npm', 'run', 'build'], cwd=repo, env=env, check=True, stdout=subprocess.DEVNULL, timeout=180)
    code, correct = verify(); assert code == 0 and len(correct) == 10 and all(c['pass'] for c in correct)
    out.write_text(json.dumps({'broken': broken, 'known_correct': correct}, indent=2) + '\n')
    print('CONTROLS PASSED', flush=True)
finally:
    subprocess.run(['git', 'reset', '--hard', s['commit']], cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['npm', 'run', 'build'], cwd=repo, env=env, check=True, stdout=subprocess.DEVNULL, timeout=180)
    runner.bull.redis_stop(port)
