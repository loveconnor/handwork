#!/usr/bin/env python3
"""Restore the pinned BullMQ seed into a new output directory; retain controls."""
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
out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=False)
out.chmod(0o700)
base = Path(tempfile.mkdtemp(prefix='handwork-landing-seed-', dir='/private/tmp'))
(out / 'base.json').write_text(json.dumps({'base': str(base)}))
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
path = out / 'bullmq-state.json'
path.write_text(json.dumps(state, indent=2) + '\n')
print('PREPARED', path, flush=True)

# Revalidate the original broken and known-correct behaviors before any scoring.
import importlib.util
spec = importlib.util.spec_from_file_location('legacy_claude_helpers', ROOT / 'benchmarks/claude-code/run.py')
legacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(legacy)
port = legacy.bull.redis_start(base)
control_env = legacy.environment(0)
control_env.update(REDIS_HOST='127.0.0.1', REDIS_PORT=str(port), BULLMQ_TEST_PREFIX='bull')
def control(label):
    result = subprocess.run([legacy.NODE, str(private / 'verify.cjs'), str(fixture), str(port)], cwd=fixture, env=control_env, capture_output=True, text=True, timeout=120)
    (out / (label + '.stdout')).write_text(result.stdout)
    (out / (label + '.stderr')).write_text(result.stderr)
    return result.returncode, json.loads(result.stdout)
try:
    code, broken = control('bullmq-control-broken')
    assert code == 1 and len(broken) == 10 and sum(not c['pass'] for c in broken) == 6
    for name, _, _ in changes:
        (fixture / name).write_bytes(subprocess.check_output(['git', 'show', recorded['upstream_commit'] + ':' + name], cwd=upstream))
    run(['npm', 'run', 'build'], fixture)
    code, correct = control('bullmq-control-correct')
    assert code == 0 and len(correct) == 10 and all(c['pass'] for c in correct)
    with (out / 'bullmq-control-existing.log').open('w') as log:
        subprocess.run([legacy.NODE, 'node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', *legacy.bull.SUITE], cwd=fixture, env=control_env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=600)
    (out / 'bullmq-controls.json').write_text(json.dumps({'broken': broken, 'known_correct': correct}, indent=2) + '\n')
    print('BULLMQ CONTROLS PASSED', flush=True)
finally:
    run(['git', 'reset', '--hard', state['commit']], fixture)
    run(['npm', 'run', 'build'], fixture)
    legacy.bull.redis_stop(port)
