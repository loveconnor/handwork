import json,statistics,sys
from pathlib import Path
out=Path(sys.argv[1]);rows=json.loads((out/'attempts.json').read_text());s=json.loads((out/'state.json').read_text());summary=json.loads((out/'summary.json').read_text())
complete=len(rows)==15 and all(v['attempts']==5 for v in summary.values())
lines=['# BullMQ worker recovery results','',('Complete series.' if complete else 'INCOMPLETE SERIES. Do not present as a five-attempt result.'),'',f"Repository: BullMQ {s['version']}, upstream revision `{s['upstream_commit']}`. This is a private injected regression, not an upstream bug report.",'',f"Model: {s['model']}, reasoning {s['effort']}. Five planned attempts per agent, 1,800-second budget per attempt. Started {s['created']}.",'','| Agent | Complete fixes | Median successful time | Mean input tokens | Mean output tokens | Mean tool calls | Median peak agent RSS |','|---|---:|---:|---:|---:|---:|---:|']
for h,v in summary.items():
 def f(k,places=1):return f'{v[k]:,.{places}f}' if v[k] is not None else 'unavailable'
 lines.append(f"| {h} | {v['successes']}/{v['attempts']} | {f('median_success_seconds')} s | {f('mean_input_tokens')} | {f('mean_output_tokens')} | {f('mean_tool_calls')} | {f('median_peak_mib')} MiB |")
lines+=['','## Paired successful attempts','']
for a,b in [('handwork','opencode'),('handwork','codex')]:
 pairs=[]
 for i in range(1,6):
  x=next((r for r in rows if r['harness']==a and r['attempt']==i and r['success']),None);y=next((r for r in rows if r['harness']==b and r['attempt']==i and r['success']),None)
  if x and y:pairs.append((x['duration_s'],y['duration_s']))
 if pairs:
  change=(sum(x for x,y in pairs)/sum(y for x,y in pairs)-1)*100
  lines.append(f'- {a} versus {b}: {len(pairs)} pairs; total agent time difference {change:+.1f}%.')
 else:lines.append(f'- {a} versus {b}: no paired successes.')
lines+=['','## Individual outcomes','','| Round | Agent | Agent time | Independent checks | Existing suite | Complete fix |','|---:|---|---:|---:|---|---|']
for r in rows:lines.append(f"| {r['attempt']} | {r['harness']} | {r['duration_s']:.1f} s | {sum(c['pass'] for c in r['checks'])}/10 | {'pass' if r['existing_tests_pass'] else 'fail'} | {'pass' if r['success'] else 'fail'} |")
lines+=['','## Controls and protocol','','Unmodified BullMQ passed 10/10 independent checks and 268 existing tests across seven selected files. The injected regression failed six stale-owner checks while passing crash recovery and retry controls. Independent checks use separate worker processes, real Redis lock expiry, and IPC-driven state transitions. This does not cover every BullMQ adapter or integration suite.','','Agents used a fresh broken repository without upstream history and preinstalled dependencies. Binaries, prompts, fixtures, evaluator and budgets were frozen before scoring. Agent order rotates across rounds. Personal instructions, skills, MCP settings and histories are blocked. Native system prompts and tool designs differ.','','Network access is limited to local Redis and a model-only proxy. The proxy permits model-service domains, not source-code hosts. Handwork uses its existing loopback endpoint overrides through the proxy; OpenCode and Codex use HTTPS tunneling. This introduces transport overhead and is not identical to an unrestricted production environment. Proxy audit logs contain destinations only.','','Each candidate is rebuilt from source in a fresh checkout with trusted dependencies, then graded independently. A complete fix requires successful completion within budget, protected files preserved, a clean build, all 10 independent checks, and the selected existing suite. Every scored outcome is retained.','','Time includes the agent and its own tools/tests, but excludes setup and independent post-run grading. Token/tool means include failures. Memory is sampled local agent RSS, excluding tools/tests, Redis, proxy, and hosted inference. Tool-call definitions differ between harnesses.','','This is one locally authored task in a real repository, not a public benchmark score or general ranking. The evaluator has not received independent human review. The repository was not used in prior Handwork tuning; model familiarity with public code cannot be ruled out. No harness tuning occurs during this scored series.','','## Frozen executable hashes','']
for h,b in s['binaries'].items():lines.append(f"- {h}: `{b['sha256']}`")
(out/'REPORT.md').write_text('\n'.join(lines)+'\n');print(out/'REPORT.md')
