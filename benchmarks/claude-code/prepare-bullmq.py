#!/usr/bin/env python3
"""Restore the recorded BullMQ seed without changing previous benchmark artifacts."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys
import hashlib
ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / 'benchmarks/bullmq-recovery'
recorded = json.loads((HERE / 'fixture.json').read_text())
base = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='handwork-claude-bullmq-seed-', dir='/private/tmp'))
env = dict(os.environ, PATH='/Users/connorlove/.vite-plus/js_runtime/node/24.21.0/bin:' + os.environ['PATH'])
def run(args, cwd=base):
    subprocess.run(args, cwd=cwd, env=env, check=True)
upstream = base / 'upstream'
if not upstream.exists():
    run(['git', 'clone', '--quiet', '--filter=blob:none', '--no-checkout', recorded['upstream'], str(upstream)])
run(['git', 'checkout', '--quiet', recorded['upstream_commit']], upstream)
run(['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'], upstream)
private = base / 'private'; private.mkdir()
fixture = private / 'fixture'
shutil.copytree(upstream, fixture, ignore=shutil.ignore_patterns('.git', 'node_modules', 'dist', 'rawScripts'))
run(['/bin/cp', '-cR', str(upstream / 'node_modules'), str(fixture / 'node_modules')])
shutil.rmtree(fixture / 'src/scripts', ignore_errors=True)
changes = [('src/commands/includes/removeLock.lua', 'if lockToken == token then', 'if lockToken then'), ('src/commands/extendLock-2.lua', 'if rcall("GET", KEYS[1]) == ARGV[1] then', 'if rcall("EXISTS", KEYS[1]) == 1 then'), ('src/commands/extendLocks-1.lua', 'if currentToken == token then', 'if currentToken then')]
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for name, old, new in changes:
    p = fixture / name; source = p.read_text(); assert source.count(old) == 1
    p.write_text(source.replace(old, new))
    assert sha(p) == recorded['seed_source_sha256'][name]
for name in ['verify.cjs', 'actor.cjs']:
    shutil.copy2(HERE / name, private / name)
    assert sha(private / name) == recorded['verifier_sha256' if name == 'verify.cjs' else 'actor_sha256']
run(['npm', 'run', 'build'], fixture)
for args in [['git', 'init', '-q'], ['git', 'add', '.'], ['git', '-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@localhost', 'commit', '-qm', 'Recorded broken seed']]:
    run(args, fixture)
state = dict(recorded, base=str(base), fixture=str(fixture), commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=fixture, text=True).strip())
path = ROOT / 'benchmarks/claude-code/bullmq-state-2026-10-04.json'
path.write_text(json.dumps(state, indent=2) + '\n')
print('PREPARED', path, flush=True)
