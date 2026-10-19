#!/usr/bin/env python3
"""Append-only native Handwork refresh of the four original landing-page tasks."""
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'benchmarks/harness-efficiency'))
import run as fixtures
pilot = fixtures.pilot
sys.path.insert(0, str(ROOT / 'benchmarks/bullmq-recovery'))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


legacy = load('legacy_refresh_helpers', ROOT / 'benchmarks/claude-code/run.py')
sys.path.insert(0, str(ROOT / 'benchmarks/orchestration-study'))
accounting = load('refresh_request_accounting', ROOT / 'benchmarks/orchestration-study/accounting.py')
study = load('refresh_source_inventory', ROOT / 'benchmarks/orchestration-study/study.py')
model_proxy = load('refresh_model_proxy', ROOT / 'benchmarks/bullmq-recovery/model_proxy.py')
NODE = legacy.NODE
pilot.NODE = NODE
TASKS = ('pagination', 'search', 'tenant-cache', 'bullmq')
PROFILE = {'provider': 'codex', 'models': {'codex': pilot.MODEL}, 'effort': 'low',
           'fast_mode': False, 'credential_source': 'chatgpt_subscription',
           'yolo_acknowledged': True, 'session_titles': False}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_new(path, value):
    with Path(path).open('x') as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write('\n')


def schedule():
    return [{'task': task, 'attempt': attempt, 'id': f'{task}-{attempt}-handwork'}
            for attempt in range(1, 6) for task in TASKS]


@contextlib.contextmanager
def profile_home(folder, personal):
    """Keep the original store untouched; remove the temporary credential on every exit."""
    task_home = folder / 'profile'
    store = task_home / '.handwork'
    store.mkdir(parents=True, mode=0o700)
    task_home.chmod(0o700)
    source = Path.home() / '.handwork/chatgpt-auth.json'
    session = json.loads(source.read_text())
    if session.get('expires_at_ms', 0) < (time.time() + 1860) * 1000:
        raise RuntimeError('Native login must remain valid beyond the attempt budget')
    credential = store / 'chatgpt-auth.json'
    try:
        # This private execution-only copy never enters the evidence directory.
        with credential.open('xb') as stream:
            credential.chmod(0o600)
            stream.write(source.read_bytes())
        write_new(store / 'settings.json', PROFILE)
        if personal:
            for name in ('AGENTS.md', 'skills'):
                origin = Path.home() / '.handwork' / name
                if origin.is_dir():
                    shutil.copytree(origin, store / name)
                elif origin.is_file():
                    shutil.copy2(origin, store / name)
        yield task_home
    finally:
        credential.unlink(missing_ok=True)


def environment(task_home, proxy_port=None, redis_port=None):
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(('HANDWORK_', 'OPENAI_', 'ANTHROPIC_', 'OPENCODE_', 'CODEX_', 'CLAUDE_'))}
    env.update(HOME=str(task_home), PATH=str(Path(NODE).parent) + ':' + os.environ['PATH'],
               NO_COLOR='1', TERM='xterm-256color', GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL='/dev/null', HANDWORK_AUTH_READ_ONLY='1',
               HANDWORK_TRACE_STDERR='1', HANDWORK_TRACE_SCOPES='agent,subagent')
    for name in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'):
        env.pop(name, None)
    if proxy_port:
        env.update(HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL=f'http://127.0.0.1:{proxy_port}/backend-api/codex/responses',
                   HANDWORK_E2E_OPENAI_CODEX_MODELS_URL=f'http://127.0.0.1:{proxy_port}/backend-api/codex/models')
    if redis_port:
        env.update(REDIS_HOST='127.0.0.1', REDIS_PORT=str(redis_port), BULLMQ_TEST_PREFIX='bull')
    return env


def isolation(base, folder, verifier, task_home, proxy_port=None, redis_port=None):
    home = Path.home()
    denied = [ROOT, ROOT.parent / 'handwork-site', home / '.handwork', home / '.agents',
              home / '.codex', home / '.claude', home / '.claw', home / '.config/opencode']
    denied += [p for p in base.iterdir() if p.resolve() not in {folder.resolve(), (base / 'bin').resolve()}]
    denied += [p for p in Path('/private/tmp').glob('handwork-*') if p.resolve() != base.resolve()]
    policy = '(version 1)(allow default)' + ''.join(
        '(deny file-read* file-write* (subpath ' + json.dumps(str(p)) + '))' for p in sorted(set(denied)))
    policy += '(deny file-write* (subpath ' + json.dumps(str(task_home / '.handwork/chatgpt-auth.json')) + '))'
    policy += '(deny file-write* (subpath ' + json.dumps(str(task_home / '.handwork/settings.json')) + '))'
    policy += '(deny network-inbound)'
    if proxy_port:
        policy += '(deny network-outbound)'
        for port in (proxy_port, redis_port):
            if port:
                policy += f'(allow network-outbound (remote ip "localhost:{port}"))'
    else:
        policy += '(deny network-outbound (remote ip "localhost:*"))'
    repo = folder / 'repo'
    link = repo / 'verifier-link'
    link.symlink_to(verifier)
    try:
        code = '''import os,sys,subprocess
for p in sys.argv[1:4]:
 try:open(p).read()
 except PermissionError:pass
 else:raise AssertionError('Private path readable')
for p in sys.argv[4:]:
 try:open(p,'ab')
 except PermissionError:pass
 else:raise AssertionError('Protected profile writable')
print('ISOLATION_OK')'''
        probe = pilot.command(['/usr/bin/sandbox-exec', '-p', policy, sys.executable, '-c', code,
                               str(verifier), str(link), str(ROOT / 'src/builtins/tools.zig'),
                               str(task_home / '.handwork/chatgpt-auth.json'), str(task_home / '.handwork/settings.json')], repo)
        if probe.returncode != 0:
            raise RuntimeError(probe.stderr)
    finally:
        link.unlink()
    return policy


def parse(log):
    result = pilot.parse('handwork', log)
    trace = Path(str(log) + '.stderr').read_text()
    reconciled = accounting.reconcile(trace)
    result['accounting'] = reconciled
    result['model_requests'] = reconciled['admitted_requests']
    if reconciled['eligible']:
        usage = reconciled['usage']
        if (result['input_tokens'], result['output_tokens']) != (usage['input'], usage['output']):
            raise RuntimeError('Native JSON and request accounting disagree')
    else:
        result.update(input_tokens=None, output_tokens=None, cached_input_tokens=None)
    if result.get('reported_model') != pilot.MODEL:
        result['completed'] = False
        result['configuration_error'] = 'Unexpected or unavailable reported model'
    if re.search(r'subagent_id=[1-9]', trace):
        raise RuntimeError('Original no-save protocol unexpectedly admitted a child')
    if 'enabled=true' not in next((line for line in trace.splitlines() if 'event=bounded_delegation ' in line), ''):
        raise RuntimeError('Current bounded default was not active')
    return result


def summarize(records, out):
    legacy.summarize(records, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()
    out = args.out.resolve()
    if (out / 'state.json').exists():
        raise RuntimeError('Never overwrite or restart an existing series')
    seed = json.loads((out / 'bullmq-state.json').read_text())
    base = Path(tempfile.mkdtemp(prefix='handwork-landing-run-', dir='/private/tmp'))
    (base / 'bin').mkdir()
    binary = base / 'bin/handwork'
    shutil.copy2(ROOT / 'zig-out/bin/handwork', binary)
    binary_hash = sha(binary)
    tasks = []
    old = json.loads((ROOT / 'benchmarks/fair-comparison/results-2026-09-19-v2/fixture-hashes.json').read_text())
    old_state = json.loads((ROOT / 'benchmarks/fair-comparison/results-2026-09-19-v2/state.json').read_text())
    for task in TASKS[:-1]:
        s = fixtures.prepare(base, task)
        fixtures.controls(s, out)
        actual = {'files': {str(p.relative_to(s['fixture'])): sha(p) for p in Path(s['fixture']).rglob('*')
                            if p.is_file() and '.git' not in p.parts}, 'verifier': sha(s['verifier'])}
        assert actual == old[task], task + ' differs from the recorded fixture'
        assert s['prompt'] == next(t['prompt'] for t in old_state['tasks'] if t['task'] == task)
        tasks.append(s)
    private = base / 'private/bullmq'
    private.mkdir(parents=True)
    fixtures.must(['/bin/cp', '-cR', seed['fixture'], str(private / 'fixture')], base)
    for name in ('verify.cjs', 'actor.cjs'):
        shutil.copy2(Path(seed['fixture']).parent / name, private / name)
    tasks.append(dict(seed, base=str(base), fixture=str(private / 'fixture'), task='bullmq',
                      verifier=str(private / 'verify.cjs'), prompt=(ROOT / 'benchmarks/bullmq-recovery/prompt.txt').read_text()))
    state = dict(created=time.strftime('%Y-%m-%dT%H:%M:%S%z'), base=str(base), tasks=tasks,
                 binary=str(binary), binary_sha256=binary_hash, build='ReleaseFast', model=pilot.MODEL,
                 effort='low', context=pilot.CONTEXT, schedule=schedule(), profile=PROFILE,
                 budgets={s['task']: 1800 if s['task'] == 'bullmq' else 600 for s in tasks},
                 machine=platform.platform(), node=subprocess.check_output([NODE, '--version'], text=True).strip(),
                 macos=subprocess.check_output(['sw_vers', '-productVersion'], text=True).strip(),
                 chip=subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
                 memory_bytes=int(subprocess.check_output(['sysctl', '-n', 'hw.memsize'], text=True)),
                 session_policy='Original --no-save, no persistent child host',
                 personal_context='Current Handwork managed skills for small tasks; blocked for BullMQ',
                 auth_policy='Private temporary native-session copy, read-only refresh policy and sandbox write denial; removed after each attempt; host profile unchanged')
    host_files = [Path.home() / '.handwork' / name for name in ('settings.json', 'chatgpt-auth.json')]
    host_hashes = {str(p): sha(p) for p in host_files}
    write_new(out / 'state.json', state)
    write_new(out / 'host-profile-before.json', host_hashes)
    sources = study.source_files(ROOT)
    for path in (ROOT / 'benchmarks/landing-refresh').glob('*.py'):
        sources[str(path.relative_to(ROOT))] = sha(path)
    for path in [Path(legacy.__file__), ROOT / 'benchmarks/bullmq-recovery/run.py',
                 ROOT / 'benchmarks/bullmq-recovery/model_proxy.py']:
        sources[str(path.relative_to(ROOT))] = sha(path)
    write_new(out / 'source-hashes.json', sources)
    for name in sources:
        target = out / 'frozen-source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    for name, source in [('runner.py', Path(__file__)), ('fixtures.py', Path(fixtures.__file__)),
                         ('pilot.py', Path(pilot.__file__)), ('grade_helpers.py', Path(legacy.__file__))]:
        shutil.copy2(source, out / name)
    proxy = model_proxy.start(out / 'network-audit.jsonl')
    records = []
    try:
        # Exercise each distinct execution profile before any scored work.
        for label, personal in [('small', True), ('bullmq', False)]:
            folder = base / ('preflight-' + label)
            repo = folder / 'repo'
            repo.mkdir(parents=True)
            fixtures.must(['git', 'init', '-q'], repo)
            (repo / 'probe.txt').write_text('before\n')
            with profile_home(folder, personal) as task_home:
                port = None if personal else proxy.server_address[1]
                policy = isolation(base, folder, Path(tasks[0]['verifier']), task_home, port)
                prompt = 'Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
                r = pilot.measured(pilot.args_for('handwork', {'handwork': str(binary)}, prompt), repo,
                                   environment(task_home, port), out / ('preflight-' + label), 180, policy)
                r.update(parse(out / ('preflight-' + label)))
                r['pass'] = bool(r['completed'] and r['exit_code'] == 0 and r['accounting']['eligible']
                                 and (repo / 'probe.txt').read_text() == 'after\n'
                                 and pilot.native_probe_succeeded('handwork', out / ('preflight-' + label)))
                write_new(out / ('preflight-' + label + '.json'), r)
                print('PREFLIGHT ' + label + ' ' + str(r['pass']), flush=True)
                if not r['pass']:
                    raise RuntimeError('Native preflight failed; retain evidence without starting scored attempts')
        for scheduled in state['schedule']:
            s = next(s for s in tasks if s['task'] == scheduled['task'])
            name = scheduled['id']
            is_bull = s['task'] == 'bullmq'
            folder, repo = legacy.bull.workspace(s, name) if is_bull else pilot.workspace(s, name)
            redis_port = legacy.bull.redis_start(folder) if is_bull else None
            try:
                with profile_home(folder, not is_bull) as task_home:
                    port = proxy.server_address[1] if is_bull else None
                    env = environment(task_home, port, redis_port)
                    if is_bull:
                        fixtures.must(['npm', 'run', 'build'], repo)
                    policy = isolation(base, folder, Path(s['verifier']), task_home, port, redis_port)
                    before = legacy.bull.protected(repo) if is_bull else fixtures.protected(repo)
                    assert sha(binary) == binary_hash, 'Executable drift'
                    assert {str(p): sha(p) for p in host_files} == host_hashes, 'Host profile drift'
                    write_new(out / (name + '.start.json'), dict(scheduled, started=time.time()))
                    (out / (name + '.sandbox.sb')).write_text(policy)
                    print('START ' + name, flush=True)
                    r = pilot.measured(pilot.args_for('handwork', {'handwork': str(binary)}, s['prompt']), repo,
                                       env, out / name, state['budgets'][s['task']], policy)
                    try:
                        r.update(parse(out / name))
                    except Exception as error:
                        r.update(completed=False, input_tokens=None, output_tokens=None, tool_calls=None,
                                 model_requests=None, accounting_error=str(error))
                    r.update(task=s['task'], harness='handwork', attempt=scheduled['attempt'],
                             workspace=str(repo), log=name)
                    write_new(out / (name + '.ungraded.json'), r)
                (out / (name + '.diff')).write_text(fixtures.must(['git', 'diff', '--binary'], repo).stdout)
                if is_bull:
                    r.update(legacy.grade_bull(s, repo, out, name, before))
                else:
                    r.update(legacy.small_grade(s, repo, out, name, before))
                r['success'] = bool(r['completed'] and not r['timeout'] and r['exit_code'] == 0
                                    and r['protected_files_unchanged'] and r['no_dependencies']
                                    and r['existing_tests_pass'] and r['verifier_pass'])
                write_new(out / (name + '.json'), r)
                records.append(r)
                pilot.write_json(out / 'attempts.json', records)
                summarize(records, out)
                print('DONE ' + json.dumps({k: r.get(k) for k in ['task', 'attempt', 'success', 'duration_s', 'input_tokens', 'output_tokens', 'tool_calls']}), flush=True)
            finally:
                if redis_port:
                    legacy.bull.redis_stop(redis_port)
    finally:
        proxy.shutdown()
        after = {str(p): sha(p) for p in host_files}
        write_new(out / 'host-profile-after.json', after)
        assert after == host_hashes, 'Host settings or credentials changed'
    print('COMPLETE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
