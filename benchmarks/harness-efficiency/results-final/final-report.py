#!/usr/bin/env python3
"""Report all attempts without mixing development and held-out results."""
import json,statistics,sys
from pathlib import Path

def generate(directory):
    rows=json.loads((directory/'attempts.json').read_text());state=json.loads((directory/'state.json').read_text())
    lines=['# Handwork harness efficiency: paired results','',f"Model: {state['model']}; effort: {state['effort']}; {state['attempts']} attempts per variant per task; 600-second wall budget.",'','Both variants are native ReleaseFast builds. Runs are serial and alternate variant order. Every attempt is retained. These are small local fixtures, not public leaderboard scores.','']
    aggregate={}
    for split in ('development','held_out'):
        selected=[r for r in rows if r['split']==split]
        if not selected:continue
        lines += ['## '+split.replace('_',' ').title(),'','| Task | Passed baseline → candidate | Median successful seconds | Mean input tokens | Mean output tokens | Mean model requests | Median agent MiB |','|---|---:|---:|---:|---:|---:|---:|']
        aggregate[split]={}
        for task in sorted({r['task'] for r in selected}):
            pair={v:[r for r in selected if r['task']==task and r['variant']==v] for v in ('baseline','optimized')}
            def field(key,success_only=False,median=False):
                values=[]
                for v,rs in pair.items():
                    rs=[r for r in rs if r['success']] if success_only else rs
                    xs=[(r['peak_rss_bytes']['harness']/1048576 if key=='rss' else r[key]) for r in rs]
                    values.append(f'{(statistics.median(xs) if median else statistics.mean(xs)):.1f}' if xs and all(x is not None for x in xs) else 'n/a')
                return ' → '.join(values)
            passes=' → '.join(f"{sum(r['success'] for r in rs)}/{len(rs)}" for rs in pair.values())
            lines.append(f"| {task} | {passes} | {field('duration_s',True,True)} | {field('input_tokens')} | {field('output_tokens')} | {field('model_requests')} | {field('rss',median=True)} |")
        for v in ('baseline','optimized'):
            rs=[r for r in selected if r['variant']==v]
            aggregate[split][v]={'attempts':len(rs),'successes':sum(r['success'] for r in rs),**{key:sum(r[key] for r in rs) for key in ('input_tokens','output_tokens','cached_input_tokens','model_requests','tool_calls','duration_s')}}
        base,cand=(aggregate[split][v] for v in ('baseline','optimized'))
        changes={k:(cand[k]/base[k]-1)*100 if base[k] else None for k in ('duration_s','input_tokens','output_tokens','model_requests','tool_calls')}
        aggregate[split]['changes_percent']=changes
        aggregate[split]['target_met']=bool(changes['duration_s'] is not None and changes['duration_s']<=-20 and cand['successes']==cand['attempts'] and cand['input_tokens']<=base['input_tokens'] and cand['output_tokens']<=base['output_tokens'])
        lines += ['', 'Across all attempts in this split: '+', '.join(f'{k} {v:+.1f}%' for k,v in changes.items() if v is not None)+'.','']
    candidate=[r for r in rows if r['variant']=='optimized'];compositions=[c for r in candidate for c in r.get('request_composition',[])]
    lines+=['## Diagnostics','',f"Candidate request-composition events: {len(compositions)}. Duplicate-result bytes removed across request projections: {sum(r.get('duplicate_saved_bytes',0) for r in candidate)}. Repeated-failure hints: {sum(r.get('recovery_hints',0) for r in candidate)}.",'']
    if compositions:
        lines+=['Mean bytes per candidate request (diagnostic categories, not tokens):','']
        for k in ('instruction_bytes','conversation_bytes','tool_result_bytes','tool_argument_bytes','replay_bytes','schema_json_bytes','wire_bytes'):
            lines.append(f'- {k}: {statistics.mean(c[k] for c in compositions):,.0f}')
    lines+=['','## Integrity and limits','','- Existing tests, private behavioral checks, protected files, and time budget all count toward success. All token totals include failed attempts.','- Broken/known-correct control outcomes are saved beside the results. Fixture and verifier hashes and frozen executable hashes are recorded in state.json.','- Development and held-out tasks are reported separately. No runtime tuning follows held-out results.','- Two pairs per task cannot establish a general speed advantage. Completion times include inference and network variability. The six tasks do not cover large repositories, multiple languages, or multi-hour sessions.','- Byte accounting is not provider tokenization; input includes cache hits. Memory measures local agent RSS, excluding hosted inference; tool/test subprocess memory is recorded separately.','- No dollar-cost comparison, competitor rerun, official SWE-bench/Terminal-Bench score, or 20% speed guarantee is claimed. Docker preflight was unavailable.','- Both variants inherit the existing personal Handwork context and load the unslop skill; this is not a pristine-profile evaluation. Available global context hashes were sampled during the run in observed-global-context-hashes.json; a later match does not prove no earlier changes. The sandbox reports inaccessible compatibility skill roots for both variants.',
        '- Candidate-only detailed tracing adds measurement overhead. Both variants enable the existing agent trace stream.','']
    lines += ['## Acceptance target', '', 'Target: at least 20% lower total completion time for the equally repeated task mix, all candidate attempts correct, and neither input nor output tokens increasing. This descriptive pilot threshold is not a significance test.', '']
    for split,data in aggregate.items():lines.append(f"- {split}: {'met' if data['target_met'] else 'not met'}.")
    lines += ['', 'Per-task regression checks use all-attempt token means and matched-success timing:', '']
    for task in sorted({r['task'] for r in rows}):
        b=[r for r in rows if r['task']==task and r['variant']=='baseline'];c=[r for r in rows if r['task']==task and r['variant']=='optimized']
        if not b or not c:continue
        warnings=[]
        for key in ('input_tokens','output_tokens'):
            if statistics.mean(r[key] for r in c)>statistics.mean(r[key] for r in b):warnings.append(key+' increased')
        paired=[(x,y) for x in b for y in c if x['attempt']==y['attempt'] and x['success'] and y['success']]
        if paired and statistics.median(y['duration_s'] for x,y in paired)>statistics.median(x['duration_s'] for x,y in paired):warnings.append('matched-success median time increased')
        if any(not r['success'] for r in c):warnings.append('candidate correctness failure')
        lines.append('- '+task+': '+('; '.join(warnings) if warnings else 'no observed regression on these checks')+'.')
    lines.append('')
    failures=[(r['task'],r['variant'],r['attempt']) for r in rows if not r['success']]
    lines += ['Failed attempts: '+(repr(failures) if failures else 'none')+'.','']
    (directory/'REPORT.md').write_text('\n'.join(lines));(directory/'aggregate.json').write_text(json.dumps(aggregate,indent=2)+'\n')
    return aggregate
if __name__=='__main__':print(json.dumps(generate(Path(sys.argv[1])),indent=2))
