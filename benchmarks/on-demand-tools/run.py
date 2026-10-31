"""Matched live pilot. Explicit --live performs six bounded inference runs.
Uses a private copy of the existing Handwork login, never modifies user settings,
and disables credential refresh. Results exclude auth files and private profiles.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import tempfile
import time

TASKS = [
    {'name': 'read_inventory', 'files': {'inventory.json': json.dumps([{'sku': 'a', 'quantity': 7, 'in_stock': True}, {'sku': 'b', 'quantity': 30, 'in_stock': False}, {'sku': 'c', 'quantity': 8, 'in_stock': True}])},
     'prompt': 'Read inventory.json. Sum quantity only for entries whose in_stock is true. Reply with the number only; do not change files.'},
    {'name': 'repair_clamp', 'files': {'src/clamp.cjs': 'exports.clamp = (x, low, high) => Math.min(low, Math.max(high, x));\n', 'test.cjs': "const assert = require('node:assert/strict'); const {clamp} = require('./src/clamp.cjs'); assert.equal(clamp(5,0,10),5); assert.equal(clamp(-2,0,10),0); assert.equal(clamp(12,0,10),10);\n"},
     'prompt': 'Fix src/clamp.cjs so clamp(x, low, high) returns x within inclusive bounds. Preserve the exported API. Run node test.cjs and report the result. Do not edit the tests.'},
    {'name': 'repair_pagination', 'files': {'src/page.cjs': 'exports.page = (items, offset, limit) => items.slice(offset, offset + limit - 1);\n', 'src/format.cjs': 'exports.label = x => String(x);\n', 'test.cjs': "const assert = require('node:assert/strict'); const {page} = require('./src/page.cjs'); assert.deepEqual(page([1,2,3,4,5],1,3),[2,3,4]); assert.deepEqual(page([1,2],0,0),[]);\n"},
     'prompt': 'The pagination function under src/ drops the last requested item. Find and fix the implementation, preserving the API. Offset and limit are nonnegative integers. Run node test.cjs. Do not edit the tests.'},
]


def verify(task, workspace, response):
    unchanged = all((workspace / name).read_text() == content for name, content in task['files'].items() if name == 'test.cjs' or task['name'] == 'read_inventory')
    if task['name'] == 'read_inventory':
        return unchanged and response.get('final_output', response.get('output', '')).strip() == '15'
    js = ("const a=require('node:assert/strict'),f=require('./src/clamp.cjs').clamp; for(let x=-20;x<=20;x++)a.equal(f(x,-3,8),Math.max(-3,Math.min(8,x))); a.equal(f(2,2,2),2);" if task['name'] == 'repair_clamp' else "const a=require('node:assert/strict'),f=require('./src/page.cjs').page;for(let n=0;n<8;n++)for(let o=0;o<10;o++)for(let l=0;l<10;l++){let v=Array.from({length:n},(_,i)=>i);a.deepEqual(f(v,o,l),v.slice(o,o+l));}")
    p = subprocess.run(['node', '-e', js], cwd=workspace, capture_output=True, timeout=10)
    return unchanged and p.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--live', action='store_true')
    args = ap.parse_args()
    if not args.live:
        raise SystemExit('Live inference requires --live and prior user authorization.')
    binary = args.binary.resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(Path(__file__), out / 'runner.py')
    auth = Path.home() / '.handwork/chatgpt-auth.json'
    auth_data = json.loads(auth.read_text())
    if auth_data.get('expires_at_ms', 0) < (time.time() + 15 * 60) * 1000:
        raise SystemExit('Existing login must remain valid through the run; refresh is disabled.')
    state = {'model': 'gpt-6.1-sol', 'effort': 'medium', 'provider': 'codex', 'runs': 6, 'timeout_seconds_per_run': 120, 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'permission_mode': 'auto', 'tasks': TASKS, 'method': 'Same binary, HANDWORK_ON_DEMAND_TOOLS=0/1; alternating pair order; clean profile/workspace per attempt. Both main-agent usage and durable session-ledger usage (including automatic reviews) are retained; cached input is already included. Ledger totals require checking billing coverage, pending records and incidents. Startup payload token estimates are measured separately. One attempt per arm per task is a pilot, not quality parity evidence.'}
    (out / 'state.json').write_text(json.dumps(state, indent=2))
    rows = []
    for index, task in enumerate(TASKS):
        for variant in (['eager', 'on_demand'] if index % 2 == 0 else ['on_demand', 'eager']):
            with tempfile.TemporaryDirectory(prefix='handwork-demand-live-') as tmp:
                home = Path(tmp)
                profile = home / '.handwork'
                profile.mkdir(mode=0o700)
                shutil.copyfile(auth, profile / 'chatgpt-auth.json')
                (profile / 'chatgpt-auth.json').chmod(0o600)
                (profile / 'settings.json').write_text(json.dumps({'provider': 'codex', 'models': {'codex': 'gpt-6.1-sol'}, 'effort': 'medium', 'fast_mode': False, 'credential_source': 'chatgpt_subscription'}))
                workspace = home / 'workspace'
                workspace.mkdir()
                for name, content in task['files'].items():
                    target = workspace / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content)
                # The verifier must reject the broken code before any model gets a turn.
                if task['name'] != 'read_inventory':
                    assert not verify(task, workspace, {}), 'Broken fixture passed verifier'
                env = {'PATH': os.environ['PATH'], 'HOME': str(home), 'USER': 'benchmark', 'TERM': 'dumb', 'SHELL': '/bin/zsh', 'HANDWORK_AUTH_READ_ONLY': '1', 'HANDWORK_ON_DEMAND_TOOLS': '1' if variant == 'on_demand' else '0', 'HANDWORK_TRACE_LOG': str(home / 'trace.log'), 'HANDWORK_TRACE_SCOPES': 'agent'}
                start = time.monotonic()
                process = subprocess.Popen([str(binary), 'ask', '--json', task['prompt'] + ' Work only in this workspace; do not delegate.'], cwd=workspace, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
                timed_out = False
                try:
                    stdout, stderr = process.communicate(timeout=120)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        stdout, stderr = process.communicate(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        stdout, stderr = process.communicate()
                elapsed = time.monotonic() - start
                try:
                    response = json.loads(stdout.strip())
                except ValueError:
                    response = {'error': 'NoCompleteJsonResponse'}
                ledgers = []
                for sidecar in profile.glob('sessions/**/usage-v2.json'):
                    envelope = json.loads(sidecar.read_text())
                    ledgers.append(envelope['snapshot'])
                ledger_complete = bool(ledgers) and all(s.get('billing') == 'complete' and not s.get('pending') and not s.get('incidents') for s in ledgers)
                ledger_input = sum(s.get('input_tokens', 0) for s in ledgers) if ledgers else None
                ledger_output = sum(s.get('output_tokens', 0) for s in ledgers) if ledgers else None
                usage = response.get('usage', {})
                values = [usage.get('input_tokens'), usage.get('output_tokens')]
                success = not timed_out and process.returncode == 0 and verify(task, workspace, response)
                row = {'task': task['name'], 'variant': variant, 'seconds': round(elapsed, 3), 'success': success, 'timed_out': timed_out, 'exit_code': process.returncode, 'input_tokens': values[0], 'output_tokens': values[1], 'total_tokens': sum(values) if all(isinstance(v, int) for v in values) else None, 'usage_details': response.get('usage_details'), 'steps': response.get('steps'), 'tools': [t.get('name') for t in response.get('tool_calls', [])], 'error': response.get('error')}
                row['session_ledger_input_tokens'] = ledger_input
                row['session_ledger_output_tokens'] = ledger_output
                row['session_ledger_total_tokens'] = ledger_input + ledger_output if ledger_complete else None
                row['session_ledger_coverage_complete'] = ledger_complete
                row['session_ledger_billing_states'] = [s.get('billing') for s in ledgers]
                rows.append(row)
                prefix = f"{task['name']}-{variant}"
                (out / f'{prefix}-usage.json').write_text(json.dumps(ledgers, indent=2))
                (out / f'{prefix}.json').write_text(json.dumps(response, indent=2))
                # Trace is opt-in metadata only; do not persist authentication or the private profile.
                if (home / 'trace.log').exists():
                    shutil.copyfile(home / 'trace.log', out / f'{prefix}.trace')
                for name in task['files']:
                    if (workspace / name).exists() and name.startswith('src/'):
                        dest = out / prefix / name
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(workspace / name, dest)
                (out / 'attempts.json').write_text(json.dumps(rows, indent=2))
                print(json.dumps(row), flush=True)
                if response.get('error') in ('MissingCredentials', 'CredentialStorageUnavailable'):
                    raise SystemExit('Live comparison blocked by credentials; no further runs attempted.')
    summary = {}
    for variant in ['eager', 'on_demand']:
        r = [row for row in rows if row['variant'] == variant]
        summary[variant] = {'successes': sum(row['success'] for row in r), 'attempts': len(r), 'total_tokens': sum(row['total_tokens'] for row in r) if all(row['total_tokens'] is not None for row in r) else None, 'median_seconds': statistics.median(row['seconds'] for row in r), 'total_seconds': sum(row['seconds'] for row in r), 'session_ledger_total_tokens': sum(row['session_ledger_total_tokens'] for row in r) if all(row['session_ledger_total_tokens'] is not None for row in r) else None}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)

if __name__ == '__main__':
    main()
