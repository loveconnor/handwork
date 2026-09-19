#!/usr/bin/env python3
import json,statistics,sys
from pathlib import Path
out=Path(sys.argv[1]);runs=json.loads((out/'attempts.json').read_text());state=json.loads((out/'state.json').read_text())
lines=['# Handwork tool batching: paired benchmark','',f"Model: {state['model']}; reasoning: {state['effort']}; native Handwork; {state['build']}. Fresh isolated workspaces, alternating baseline/optimized order, three fixtures. Both binaries include the same pre-existing workspace changes.",'','This experiment measures multi-file reads, multi-pattern literal search, overlapping search-context deduplication, and replacement prompt/tool descriptions. Independent actions, including edits to different files, can share a model response; mutations still use the existing per-file tool and approval path. This experiment does not include a cross-file mutation tool or a code execution runtime.','', '| Task | Success baseline → optimized | Mean calls | Mean input tokens | Mean output tokens | Median successful seconds |','|---|---:|---:|---:|---:|---:|']
summary={}
for task in sorted({r['task'] for r in runs}):
 pairs={v:[r for r in runs if r['task']==task and r['variant']==v] for v in ['baseline','optimized']}
 if not all(pairs.values()):continue
 a,b=pairs.values()
 avg=lambda rows,k:statistics.mean(r[k] for r in rows)
 med=lambda rows:statistics.median(r['duration_s'] for r in rows if r['success']) if any(r['success'] for r in rows) else None
 arrow=lambda k,dec=1:f'{avg(a,k):,.{dec}f} → {avg(b,k):,.{dec}f}'
 successes=lambda rows:f'{sum(r["success"] for r in rows)}/{len(rows)}'
 times=f'{med(a):.1f} → {med(b):.1f}' if med(a)!=None and med(b)!=None else 'Unavailable'
 lines.append(f'| {task} | {successes(a)} → {successes(b)} | {arrow("tool_calls")} | {arrow("input_tokens",0)} | {arrow("output_tokens",0)} | {times} |')
 summary[task]={'correctness_pass':all(r['success'] for r in b) and len(a)==len(b), 'calls_lower':avg(b,'tool_calls')<avg(a,'tool_calls'),'input_no_increase':avg(b,'input_tokens')<=avg(a,'input_tokens'),'output_no_increase':avg(b,'output_tokens')<=avg(a,'output_tokens')}
a=[r for r in runs if r['variant']=='baseline'];b=[r for r in runs if r['variant']=='optimized']
if a and b:
    aggregate={key:{'baseline':statistics.mean(r[key] for r in a),'optimized':statistics.mean(r[key] for r in b)} for key in ('tool_calls','input_tokens','output_tokens','model_requests')}
    for values in aggregate.values():values['change_percent']=(values['optimized']/values['baseline']-1)*100
    (out/'aggregate.json').write_text(json.dumps(aggregate,indent=2)+'\n')
    lines+=['', 'Equal-weight aggregate across all attempts: '+', '.join(f"{key} {values['change_percent']:+.1f}%" for key,values in aggregate.items())+'. Task-level token regressions remain failures even when the aggregate improves.']
lines+=['', '| Task | Mean model requests | Mean native operations, expanding read batches | Median peak harness MiB |', '|---|---:|---:|---:|']
for task in sorted({r['task'] for r in runs}):
    a=[r for r in runs if r['task']==task and r['variant']=='baseline']
    b=[r for r in runs if r['task']==task and r['variant']=='optimized']
    if not a or not b:continue
    pair=lambda key:f'{statistics.mean(r[key] for r in a):.1f} → {statistics.mean(r[key] for r in b):.1f}'
    ram=lambda rows:statistics.median(r['peak_rss_bytes']['harness']/1048576 for r in rows)
    lines.append(f'| {task} | {pair("model_requests")} | {pair("native_operations_excluding_shell_contents")} | {ram(a):.1f} → {ram(b):.1f} |')
lines+=['','## Acceptance checks','', 'Input and output are separate constraints; lower combined cost does not compensate for increasing either. Token means include every attempt, including failures. Cached input remains input; reasoning output is not subtracted.','']
for task,gates in summary.items():lines.append(f'- {task}: '+', '.join(f'{k}={v}' for k,v in gates.items()))
lines+=['','## Interpretation and limits','','Native tool-call counts include one call for a batch. Underlying file reads are separately expanded from batch diagnostics in `native_operations_excluding_shell_contents`; shell commands can still contain multiple operations. `model_requests` counts provider-admission trace events, so fewer tool calls must not be equated with the same reduction in inference round trips.','','This is a small paired pilot, not evidence of a general quality or latency guarantee. The benchmark settings, user prompt, verifier, compiler optimization and model are fixed within each pair. Existing tests and private behavior checks must both pass. The tenant-cache verifier was reconstructed because the original temporary verifier no longer exists; it is validated against a broken and a historical known-correct control. Historical benchmark numbers are not used as the baseline.','','No builds or unit tests run concurrently with scored agent attempts. Raw outputs, stderr, memory samples, diffs, final source/test snapshots and per-attempt checks are retained. Credentials are staged only for execution and restored afterward.']
(out/'REPORT.md').write_text('\n'.join(lines)+'\n');(out/'acceptance.json').write_text(json.dumps(summary,indent=2)+'\n');print('\n'.join(lines[:12]))
