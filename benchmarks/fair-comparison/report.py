#!/usr/bin/env python3
import json,sys
from pathlib import Path
out=Path(sys.argv[1]);state=json.loads((out/'state.json').read_text());summary=json.loads((out/'summary.json').read_text());records=json.loads((out/'attempts.json').read_text())
assert len(records)==45,'Only publish a complete series'
assert all(v['attempts']==5 for group in summary.values() for v in group.values())
lines=['# Fresh five-attempt harness comparison','',f"Run started: {state['created']}. Model: {state['model']}; reasoning: {state['effort']}. Five attempts per agent per task; 600-second limit per attempt.",'','All three agents were rerun in the same series. Runs were serial with rotated agent order, fresh workspaces, and fresh sessions. Executables were frozen before preflight. No scored outcomes were discarded or replaced.','', '| Task | Agent | Complete fixes | Median successful time | Mean tool calls | Mean input tokens | Mean output tokens | Median peak agent RSS |','|---|---|---:|---:|---:|---:|---:|---:|']
for task,agents in summary.items():
 for agent,v in agents.items():
  def fmt(k,places=1):return f'{v[k]:,.{places}f}' if v[k] is not None else 'unavailable'
  lines.append(f"| {task} | {agent} | {v['successes']}/5 | {fmt('median_success_seconds')} s | {fmt('mean_tool_calls')} | {fmt('mean_input_tokens')} | {fmt('mean_output_tokens')} | {fmt('median_peak_mib')} MiB |")
lines += ['','## Method and limitations','','Success requires completion within the time limit, a zero exit status, all independent behavioral checks and existing tests passing, protected files preserved, and no installed task dependencies. Broken and known-correct fixture controls and separate tool-access preflights passed before scoring. The sandbox blocks private checks, benchmark sources, prior benchmark workspaces, and loopback network access.','','Time includes model inference, network latency, and tools. Time is the median across successful attempts; token and tool counts are means across every attempt, including failures. RSS is sampled peak local agent memory, excluding hosted inference and separately classified test/tool processes. Tool-call definitions differ between harnesses; a shell command or code-mode call may contain several operations. Tokens are client-reported, include cache hits, and include saved descendant activity where available. No dollar-cost comparison is claimed.','','These are five-attempt pilots on three small local TypeScript fixtures, not a general agent ranking or a public leaderboard. Prompts, model, budgets, fixtures, and scoring match, but harness instructions and native tools differ. Handwork inherits existing personal context; Codex ignores user rules; OpenCode runs in pure mode. This is not a pristine common profile.','','The earlier two-attempt Handwork series and historical competitor results are separate measurements and are not mixed into this report.','','## Frozen executable hashes','']
for h,b in state['binaries'].items():lines.append(f"- {h}: `{b['sha256']}`")
lines+=['','## Failures','']
failures=[r for r in records if not r['success']]
if not failures:lines.append('None. All 45 scored attempts passed.')
for r in failures:lines.append(f"- {r['task']} / {r['harness']} / attempt {r['attempt']}: timeout={r['timeout']}, exit={r['exit_code']}, protected files={r['protected_files_unchanged']}, existing tests={r['existing_tests_pass']}; failed checks: "+', '.join(c.get('name','unnamed') for c in r['checks'] if not c['pass']))
(out/'REPORT.md').write_text('\n'.join(lines)+'\n')
print(out/'REPORT.md')
