#!/usr/bin/env python3
"""Append-only Claude Code series using the existing fixtures and independent graders."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'benchmarks/harness-efficiency'))
import run as fixtures
pilot = fixtures.pilot
MODEL = 'claude-opus-5-5'
NODE = '/Users/connorlove/.vite-plus/js_runtime/node/24.21.0/bin/node'
pilot.NODE = NODE


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(ROOT / 'benchmarks/bullmq-recovery'))
bull = load('bullmq_runner', ROOT / 'benchmarks/bullmq-recovery/run.py')
proxy_module = load('claude_proxy', ROOT / 'benchmarks/bullmq-recovery/model_proxy.py')
proxy_module.ALLOWED = {'api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'platform.claude.com'}


def environment(port):
    env = {k: v for k, v in os.environ.items() if not k.startswith(('HANDWORK_', 'OPENCODE_', 'OPENAI_', 'ANTHROPIC_', 'CLAUDE_'))}
    env.update(PATH=str(Path(NODE).parent) + ':' + env['PATH'], NO_COLOR='1',
               GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
               HTTPS_PROXY=f'http://127.0.0.1:{port}', HTTP_PROXY=f'http://127.0.0.1:{port}',
               https_proxy=f'http://127.0.0.1:{port}', http_proxy=f'http://127.0.0.1:{port}',
               NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    return env


def command(binary, prompt):
    return [binary, '-p', prompt, '--model', MODEL, '--effort', 'medium', '--safe-mode',
            '--strict-mcp-config', '--no-session-persistence', '--dangerously-skip-permissions',
            '--tools', 'Read,Edit,Write,Bash,Glob,Grep', '--output-format', 'stream-json', '--verbose']


def parse(log):
    events = [json.loads(line) for line in Path(str(log) + '.stdout').read_text().splitlines() if line.startswith('{')]
    result = next((e for e in reversed(events) if e.get('type') == 'result'), None)
    if result is None:
        return dict(completed=False, input_tokens=None, output_tokens=None, tool_calls=None, model_requests=None)
    models = result.get('modelUsage', {})
    if set(models) != {MODEL}:
        raise RuntimeError(f'Unexpected model usage: {list(models)}')
    usage = result['usage']
    calls = {b['id'] for e in events if e.get('type') == 'assistant' for b in e.get('message', {}).get('content', []) if b.get('type') == 'tool_use'}
    messages = {e['message']['id'] for e in events if e.get('type') == 'assistant' and e.get('message', {}).get('id')}
    return dict(completed=result.get('subtype') == 'success' and not result.get('is_error'),
                input_tokens=sum(usage.get(k, 0) for k in ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']),
                output_tokens=usage.get('output_tokens'), cached_input_tokens=usage.get('cache_read_input_tokens'),
                tool_calls=len(calls), model_requests=len(messages), model_usage=models,
                permission_denials=result.get('permission_denials', []),
                token_basis='Client-reported aggregate usage, including cache creation and cache reads',
                request_count_basis='Unique assistant message IDs; transport retries not separately exposed')


def isolation(base, folder, verifier, proxy_port, redis_port=None):
    home = Path.home()
    denied = [ROOT, ROOT.parent / 'handwork-site', home / '.agents', home / '.codex', home / '.handwork', home / '.config/opencode']
    denied += [home / '.claude' / x for x in ['projects', 'skills', 'plugins', 'agents', 'commands', 'todos', 'tasks']]
    denied += [p for p in base.iterdir() if p.resolve() not in {folder.resolve(), (base / 'bin').resolve()}]
    denied += [p for p in Path('/private/tmp').glob('handwork-*') if p.resolve() != base.resolve()]
    profile = '(version 1)(allow default)' + ''.join('(deny file-read* file-write* (subpath ' + json.dumps(str(p)) + '))' for p in sorted(set(denied)))
    profile += '(deny network-inbound)(deny network-outbound)'
    for port in [proxy_port, redis_port]:
        if port:
            profile += f'(allow network-outbound (remote ip "localhost:{port}"))'
    repo = folder / 'repo'
    link = repo / 'verifier-link'
    link.symlink_to(verifier)
    try:
        code = 'import sys,socket\nfor p in sys.argv[1:]:\n try:open(p).read()\n except PermissionError:pass\n else:raise AssertionError("Private file readable: "+p)\ns=socket.socket();s.settimeout(2)\ntry:s.connect(("140.82.112.3",443))\nexcept PermissionError:pass\nelse:raise AssertionError("Upstream network accessible")'
        fixtures.must(['/usr/bin/sandbox-exec', '-p', profile, sys.executable, '-c', code, str(verifier), str(link), str(ROOT / 'src/builtins/tools.zig')], repo)
    finally:
        link.unlink()
    return profile


def summarize(records, out):
    summary = {}
    for task in sorted({r['task'] for r in records}):
        rows = [r for r in records if r['task'] == task]
        good = [r for r in rows if r['success']]
        summary[task] = {'attempts': len(rows), 'successes': len(good),
            'median_success_seconds': statistics.median(r['duration_s'] for r in good) if good else None,
            'median_peak_mib': statistics.median(r['peak_rss_bytes']['harness'] / 2**20 for r in rows),
            **{'mean_' + key: statistics.mean(r[key] for r in rows) if all(r.get(key) is not None for r in rows) else None for key in ['input_tokens', 'output_tokens', 'tool_calls', 'model_requests']}}
    pilot.write_json(out / 'summary.json', summary)


def small_grade(s, repo, out, name, before):
    after = fixtures.protected(repo)
    protected = all(after.get(k) == v for k, v in before.items()) if s['task'] == 'tenant-cache' else after == before
    checked = pilot.measured(fixtures.verify(s, repo), repo, environment(0), out / (name + '.verify'), 30)
    existing = pilot.measured(['npm', 'test'], repo, environment(0), out / (name + '.existing'), 60)
    try:
        checks = json.loads((out / (name + '.verify.stdout')).read_text())
    except ValueError:
        checks = []
    return dict(protected_files_unchanged=protected, no_dependencies=not (repo / 'node_modules').exists(),
                checks=checks, existing_tests_pass=existing['exit_code'] == 0 and not existing['timeout'],
                verifier_pass=checked['exit_code'] == 0 and bool(checks) and all(c['pass'] for c in checks))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--tasks', nargs='+', default=['pagination', 'search', 'tenant-cache'], choices=['pagination', 'search', 'tenant-cache', 'bullmq'])
    ap.add_argument('--bullmq-state', type=Path)
    args = ap.parse_args()
    out = args.out.resolve()
    assert not out.exists(), 'Never overwrite results'
    out.mkdir(parents=True)
    base = Path(tempfile.mkdtemp(prefix='handwork-claude-', dir='/private/tmp'))
    (base / 'bin').mkdir()
    binary = str(Path(shutil.which('claude')).resolve())
    proxy = proxy_module.start(out / 'network-audit.jsonl')
    port = proxy.server_address[1]
    tasks = []
    old = json.loads((ROOT / 'benchmarks/fair-comparison/results-2026-09-19-v2/fixture-hashes.json').read_text())
    for task in args.tasks:
        if task == 'bullmq':
            s = json.loads(args.bullmq_state.read_text())
            s['task'] = 'bullmq'
            s['base'] = str(base)
            s['verifier'] = str(Path(s['fixture']).parent / 'verify.cjs')
            # Copy frozen seed into the new private tree; workspaces clone this copy.
            private = base / 'private/bullmq'
            private.mkdir(parents=True)
            fixtures.must(['/bin/cp', '-cR', s['fixture'], str(private / 'fixture')], base)
            for file in ['verify.cjs', 'actor.cjs']:
                shutil.copy2(Path(s['fixture']).parent / file, private / file)
            s.update(fixture=str(private / 'fixture'), verifier=str(private / 'verify.cjs'), prompt=(ROOT / 'benchmarks/bullmq-recovery/prompt.txt').read_text())
        else:
            s = fixtures.prepare(base, task)
            fixtures.controls(s, out)
            actual = {'files': {str(p.relative_to(s['fixture'])): fixtures.sha(p) for p in Path(s['fixture']).rglob('*') if p.is_file() and '.git' not in p.parts}, 'verifier': fixtures.sha(Path(s['verifier']))}
            assert actual == old[task], f'{task} fixture differs from recorded comparison'
        tasks.append(s)
    state = dict(model=MODEL, effort='medium', attempts_per_task=5, base=str(base), tasks=tasks,
                 claude_version=subprocess.check_output([binary, '--version'], text=True).strip(),
                 binary=binary, binary_sha256=fixtures.sha(Path(binary)), machine=platform.platform(),
                 profile='Safe mode, six native tools, no MCP, plugins, skills, personal context or persisted sessions; model-only egress',
                 budgets={s['task']: 1800 if s['task'] == 'bullmq' else 600 for s in tasks})
    pilot.write_json(out / 'state.json', state)
    shutil.copy2(__file__, out / 'runner.py')
    # A separate native tool probe must pass before scoring.
    folder = base / 'preflight'; repo = folder / 'repo'; repo.mkdir(parents=True)
    (repo / 'probe.txt').write_text('before\n')
    prompt = 'Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
    sb = isolation(base, folder, Path(tasks[0]['verifier']), port)
    r = pilot.measured(command(binary, prompt), repo, environment(port), out / 'preflight', 180, sb)
    r.update(parse(out / 'preflight'))
    r['pass'] = r['exit_code'] == 0 and r['completed'] and (repo / 'probe.txt').read_text() == 'after\n' and 'PROBE_OK' in (out / 'preflight.stdout').read_text() and r['tool_calls'] >= 3
    pilot.write_json(out / 'preflight.json', r)
    print('PREFLIGHT ' + json.dumps(r), flush=True)
    assert r['pass'], 'Native preflight failed'
    records = []
    for attempt in range(1, 6):
        for s in tasks:
            name = f'{s["task"]}-{attempt}-claude'
            folder, repo = bull.workspace(s, name) if s['task'] == 'bullmq' else pilot.workspace(s, name)
            redis_port = bull.redis_start(folder) if s['task'] == 'bullmq' else None
            try:
                env = environment(port)
                if redis_port:
                    env.update(REDIS_HOST='127.0.0.1', REDIS_PORT=str(redis_port), BULLMQ_TEST_PREFIX='bull')
                    fixtures.must(['npm', 'run', 'build'], repo)
                sb = isolation(base, folder, Path(s['verifier']), port, redis_port)
                (out / (name + '.sandbox.sb')).write_text(sb)
                before = bull.protected(repo) if redis_port else fixtures.protected(repo)
                assert fixtures.sha(Path(binary)) == state['binary_sha256'], 'Executable changed during series'
                print('START ' + name, flush=True)
                r = pilot.measured(command(binary, s['prompt']), repo, env, out / name, state['budgets'][s['task']], sb)
                r.update(parse(out / name))
                r.update(task=s['task'], harness='claude', attempt=attempt, workspace=str(repo), log=name)
                pilot.write_json(out / (name + '.ungraded.json'), r)
                (out / (name + '.diff')).write_text(fixtures.must(['git', 'diff', '--binary'], repo).stdout)
                if redis_port:
                    r.update(grade_bull(s, repo, out, name, before))
                else:
                    r.update(small_grade(s, repo, out, name, before))
                r['success'] = bool(r['completed'] and not r['timeout'] and r['exit_code'] == 0 and r['protected_files_unchanged'] and r['no_dependencies'] and r['existing_tests_pass'] and r['verifier_pass'])
                records.append(r)
                pilot.write_json(out / 'attempts.json', records)
                summarize(records, out)
                print('DONE ' + json.dumps({k: r.get(k) for k in ['task', 'attempt', 'success', 'duration_s', 'input_tokens', 'output_tokens', 'tool_calls']}), flush=True)
            finally:
                if redis_port:
                    bull.redis_stop(redis_port)
    proxy.shutdown()
    print('COMPLETE ' + str(out), flush=True)


def grade_bull(s, repo, out, name, before):
    protected = all(bull.protected(repo).get(k) == v for k, v in before.items())
    folder, grade = bull.workspace(s, 'grade-' + name)
    shutil.rmtree(grade / 'src')
    shutil.copytree(repo / 'src', grade / 'src', symlinks=True)
    assert not any(p.is_symlink() for p in (grade / 'src').rglob('*')), 'Unexpected source symlink'
    port = bull.redis_start(folder)
    env = environment(0)
    env.update(REDIS_HOST='127.0.0.1', REDIS_PORT=str(port), BULLMQ_TEST_PREFIX='bull')
    try:
        built = pilot.measured(['npm', 'run', 'build'], grade, env, out / (name + '.build'), 180)
        checks = []; existing_pass = False; verifier_pass = False
        if built['exit_code'] == 0 and not built['timeout']:
            checked = pilot.measured([NODE, s['verifier'], str(grade), str(port)], grade, env, out / (name + '.verify'), 120)
            try:
                checks = json.loads((out / (name + '.verify.stdout')).read_text())
            except ValueError:
                pass
            existing = pilot.measured([NODE, 'node_modules/vitest/vitest.mjs', 'run', '--no-file-parallelism', *bull.SUITE], grade, env, out / (name + '.existing'), 600)
            existing_pass = existing['exit_code'] == 0 and not existing['timeout']
            verifier_pass = checked['exit_code'] == 0 and len(checks) == 10 and all(c['pass'] for c in checks)
        return dict(protected_files_unchanged=protected, no_dependencies=True, checks=checks,
                    existing_tests_pass=existing_pass, verifier_pass=verifier_pass, build_pass=built['exit_code'] == 0)
    finally:
        bull.redis_stop(port)


if __name__ == '__main__':
    main()
