#!/usr/bin/env python3
"""Retain a separate, complete five-attempt authorization/cache cohort."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('cache_refresh_helpers', Path(__file__).with_name('run.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    prior = r.ROOT / 'benchmarks/orchestration-results/2026-10-19-landing-refresh-v2'
    previous = json.loads((prior / 'state.json').read_text())
    preserved = {str(p): r.sha(p) for root in (prior, r.ROOT.parent / 'handwork-site/public/benchmarks')
                 for p in root.rglob('*') if p.is_file()}
    r.write_new(out / 'preserved-before.json', preserved)
    base = Path(tempfile.mkdtemp(prefix='handwork-auth-cache-', dir='/private/tmp'))
    (base / 'bin').mkdir()
    binary = base / 'bin/handwork'
    shutil.copy2(r.ROOT / 'zig-out/bin/handwork', binary)
    assert r.sha(binary) == previous['binary_sha256'], 'Use the same frozen executable'
    task = r.fixtures.prepare(base, 'tenant-cache')
    r.fixtures.controls(task, out)
    original = r.ROOT / 'benchmarks/fair-comparison/results-2026-09-19-v2'
    actual = {'files': {str(p.relative_to(task['fixture'])): r.sha(p)
                        for p in Path(task['fixture']).rglob('*') if p.is_file() and '.git' not in p.parts},
              'verifier': r.sha(task['verifier'])}
    assert actual == json.loads((original / 'fixture-hashes.json').read_text())['tenant-cache']
    assert task['prompt'] == next(t['prompt'] for t in previous['tasks'] if t['task'] == 'tenant-cache')
    state = dict(previous, created=time.strftime('%Y-%m-%dT%H:%M:%S%z'), base=str(base),
                 tasks=[task], binary=str(binary), budgets={'tenant-cache': 600},
                 schedule=[{'task': 'tenant-cache', 'attempt': n, 'id': f'tenant-cache-{n}-handwork'}
                           for n in range(1, 6)],
                 prior_cohort=str(prior), reason='Separate full cohort to obtain complete request accounting; all prior outcomes retained',
                 sleep_policy='Parent runner launched under caffeinate -i; lid must remain open')
    r.write_new(out / 'state.json', state)
    sources = r.study.source_files(r.ROOT)
    for p in (r.ROOT / 'benchmarks/landing-refresh').glob('*.py'):
        sources[str(p.relative_to(r.ROOT))] = r.sha(p)
    for module in (r.fixtures, r.pilot, r.legacy, r.accounting):
        p = Path(module.__file__)
        sources[str(p.relative_to(r.ROOT))] = r.sha(p)
    r.write_new(out / 'source-hashes.json', sources)
    for name in sources:
        target = out / 'frozen-source' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(r.ROOT / name, target)
    host = [Path.home() / '.handwork' / name for name in ('settings.json', 'chatgpt-auth.json')]
    host_hashes = {str(p): r.sha(p) for p in host}
    r.write_new(out / 'host-profile-before.json', host_hashes)
    records = []
    try:
        folder = base / 'preflight'
        repo = folder / 'repo'
        repo.mkdir(parents=True)
        r.fixtures.must(['git', 'init', '-q'], repo)
        (repo / 'probe.txt').write_text('before\n')
        with r.profile_home(folder, True) as home:
            policy = r.isolation(base, folder, Path(task['verifier']), home)
            prompt = 'Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
            result = r.pilot.measured(r.pilot.args_for('handwork', {'handwork': str(binary)}, prompt),
                                      repo, r.environment(home), out / 'preflight', 180, policy)
            result.update(r.parse(out / 'preflight'))
            result['pass'] = bool(result['completed'] and result['exit_code'] == 0 and result['accounting']['eligible']
                                  and (repo / 'probe.txt').read_text() == 'after\n'
                                  and r.pilot.native_probe_succeeded('handwork', out / 'preflight'))
            r.write_new(out / 'preflight.json', result)
            print('PREFLIGHT ' + str(result['pass']), flush=True)
            assert result['pass'], 'Retain failed preflight without starting scored work'
        for scheduled in state['schedule']:
            name = scheduled['id']
            folder, repo = r.pilot.workspace(task, name)
            with r.profile_home(folder, True) as home:
                policy = r.isolation(base, folder, Path(task['verifier']), home)
                before = r.fixtures.protected(repo)
                assert r.sha(binary) == state['binary_sha256']
                assert {str(p): r.sha(p) for p in host} == host_hashes
                r.write_new(out / (name + '.start.json'), dict(scheduled, started=time.time()))
                (out / (name + '.sandbox.sb')).write_text(policy)
                print('START ' + name, flush=True)
                result = r.pilot.measured(r.pilot.args_for('handwork', {'handwork': str(binary)}, task['prompt']),
                                          repo, r.environment(home), out / name, 600, policy)
                try:
                    result.update(r.parse(out / name))
                except Exception as error:
                    result.update(completed=False, input_tokens=None, output_tokens=None, tool_calls=None,
                                  model_requests=None, accounting_error=str(error))
                result.update(task='tenant-cache', harness='handwork', attempt=scheduled['attempt'],
                              workspace=str(repo), log=name)
                r.write_new(out / (name + '.ungraded.json'), result)
            (out / (name + '.diff')).write_text(r.fixtures.must(['git', 'diff', '--binary'], repo).stdout)
            result.update(r.legacy.small_grade(task, repo, out, name, before))
            result['success'] = bool(result['completed'] and not result['timeout'] and result['exit_code'] == 0
                                     and result['protected_files_unchanged'] and result['no_dependencies']
                                     and result['existing_tests_pass'] and result['verifier_pass'])
            r.write_new(out / (name + '.json'), result)
            records.append(result)
            r.pilot.write_json(out / 'attempts.json', records)
            r.summarize(records, out)
            print('DONE ' + json.dumps({k: result.get(k) for k in ('attempt', 'success', 'duration_s', 'input_tokens', 'output_tokens', 'tool_calls')}), flush=True)
    finally:
        after = {str(p): r.sha(p) for p in host}
        r.write_new(out / 'host-profile-after.json', after)
        assert after == host_hashes, 'Host profile changed'
    assert all(r.sha(p) == digest for p, digest in preserved.items()), 'Prior results changed'
    assert all(r.sha(r.ROOT / name) == digest for name, digest in sources.items()), 'Source drift'
    assert not list(base.rglob('chatgpt-auth.json')), 'Temporary credential was not removed'
    r.write_new(out / 'integrity.json', {'prior_files_preserved': len(preserved), 'sources_unchanged': len(sources),
                                       'temporary_credentials_removed': True, 'host_profile_unchanged': True,
                                       'binary_unchanged': r.sha(binary) == state['binary_sha256']})
    print('COMPLETE ' + str(out), flush=True)


if __name__ == '__main__':
    main()
