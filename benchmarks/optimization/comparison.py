"""Shared cross-cohort comparison, computed from retained attempt records."""
import html
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def render():
    original = ROOT / 'benchmarks/async-search/results'
    updated = ROOT / 'benchmarks/optimization/results-final'
    old_state = json.loads((original / 'state.json').read_text())
    new_state = json.loads((updated / 'state.json').read_text())
    for key in ('commit', 'model', 'reasoning', 'context', 'prompt_sha256', 'machine'):
        assert old_state[key] == new_state[key], f'Comparison control differs: {key}'
    old_runs = json.loads((original / 'attempts.json').read_text())
    new_runs = json.loads((updated / 'attempts.json').read_text())
    cohorts = [
        ('Updated Handwork', [r for r in new_runs if r['variant'] == 'optimized']),
        ('OpenCode', [r for r in old_runs if r['harness'] == 'opencode']),
        ('Codex', [r for r in old_runs if r['harness'] == 'codex']),
    ]
    stats = []
    for name, runs in cohorts:
        assert len(runs) == 5
        stats.append({
            'name': name, 'success': sum(r['success'] for r in runs),
            'time': statistics.median(r['duration_s'] for r in runs if r['success']),
            'memory': statistics.median(r['peak_rss_bytes']['harness'] / 2**20 for r in runs),
            **{k: statistics.mean(r[k] for r in runs) for k in ('input_tokens', 'output_tokens', 'tool_calls')},
        })
    # This published cohort has all successes; avoid implying matched scoring if it changes.
    assert all(s['success'] == 5 for s in stats)
    metrics = [('Verified fixes', 'success', ' / 5', 0),
               ('Completion time (median)', 'time', ' s', 1),
               ('Harness memory (median peak)', 'memory', ' MiB', 1),
               ('Input tokens (mean)', 'input_tokens', '', 0),
               ('Output tokens (mean)', 'output_tokens', '', 0),
               ('Tool calls (mean)', 'tool_calls', '', 1)]
    rows = ''.join('<tr><td>' + label + '</td>' + ''.join(
        f'<td>{s[key]:,.{digits}f}{unit}</td>' for s in stats) + '</tr>'
        for label, key, unit, digits in metrics)
    t, o, c = stats
    less = lambda key, other: 100 * (1 - t[key] / other[key])
    dates = f"Updated Handwork cohort: {html.escape(new_state['created'])}. Earlier three-harness cohort: {html.escape(old_state['created'])}."
    return f'''<section class="panel" id="updated-comparison"><h2>Updated Handwork versus OpenCode and Codex</h2>
<p>All three completed 5 of 5 attempts. Updated Handwork used {less('memory', o):.1f}% less harness memory than OpenCode and {less('memory', c):.1f}% less than Codex.</p>
<div class="table-wrap"><table aria-label="Updated three-harness comparison"><thead><tr><th>Metric</th><th>Updated Handwork</th><th>OpenCode</th><th>Codex</th></tr></thead><tbody>{rows}</tbody></table></div>
<p>Against OpenCode, updated Handwork finished {less('time', o):.1f}% faster, with fewer input tokens, output tokens and tool calls. Against Codex, it used {less('input_tokens', c):.1f}% fewer input tokens but took {-less('time', c):.1f}% longer, produced {-less('output_tokens', c):.1f}% more output tokens and used {t['tool_calls']/c['tool_calls']:.2f}× as many tool calls.</p>
<p class="small">These are separate run cohorts, not a new jointly rotated three-harness benchmark. The starting commit, user prompt, model, reasoning setting, context limit and machine match. Hosted service load and caching remain uncontrolled. All attempts succeeded; time medians therefore include all five completed fixes per harness. Token and tool figures are per-attempt means across all calls; OpenCode includes its subagents. Memory excludes test and other tool processes.</p>
<p class="small">{dates}</p>
<p class="small"><a href="benchmarks/optimization/results-final/report-data.json">Updated Handwork evidence</a> · <a href="benchmarks/async-search/results/report-data.json">Earlier OpenCode and Codex evidence</a></p></section>'''
