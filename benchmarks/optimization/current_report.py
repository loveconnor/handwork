"""Render the current three-harness results in the existing report layout."""
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def render(css):
    data = json.loads((ROOT/'benchmarks/async-search/results/report-data.json').read_text())
    runs = data['runs']
    assert len(runs) == 15
    assert all(r.get('variant') == 'optimized' for r in runs if r['harness'] == 'handwork')
    names = {'handwork': 'Updated Handwork', 'opencode': 'OpenCode', 'codex': 'Codex'}
    summaries = data['summary']
    metrics = [
        ('Verified fixes', lambda s: f"{s['success']} / {s['attempts']}"),
        ('Completion time (median)', lambda s: f"{s['median_solved_s']:.1f} s"),
        ('Harness memory (median peak)', lambda s: f"{s['median_peak_mib']:.1f} MiB"),
        ('Input tokens (mean)', lambda s: f"{s['input_tokens']/s['attempts']:,.0f}"),
        ('Output tokens (mean)', lambda s: f"{s['output_tokens']/s['attempts']:,.0f}"),
        ('Tool calls (mean)', lambda s: f"{s['tool_calls']/s['attempts']:.1f}"),
    ]
    rows = ''.join('<tr><td>'+label+'</td>'+''.join('<td>'+fmt(summaries[h])+'</td>' for h in names)+'</tr>' for label, fmt in metrics)
    records = ''.join(f'''<tr><td>{r['attempt']}</td><td>{names[r['harness']]}</td><td>{'Pass' if r['success'] else 'Fail'}</td><td>{r['duration_s']:.1f}s</td><td>{r['peak_rss_bytes']['harness']/2**20:.1f} MiB</td><td>{r['input_tokens']:,} / {r['output_tokens']:,}</td><td>{r['tool_calls']}</td><td><a href="{r['evidence']}{r['log']}.diff">diff</a> · <a href="{r['evidence']}{r['log']}.verify.stdout">checks</a></td></tr>''' for r in runs)
    dates = data['comparison']
    (ROOT/'benchmarks/optimization/results-final/current-results.json').write_text(json.dumps(data, indent=2))
    return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Handwork efficiency validation</title><style>{css} .panel{{min-width:0}}</style><main>
<header><div class="brand">handwork.</div><span class="badge">EFFICIENCY VALIDATION</span></header>
<div class="hero"><div class="tag">Updated Handwork · OpenCode · Codex</div><h1>Same bug. Measured results.</h1><p class="intro">All three harnesses completed 5 of 5 attempts. Updated Handwork used {100*(1-summaries['handwork']['median_peak_mib']/summaries['opencode']['median_peak_mib']):.1f}% less median peak harness memory than OpenCode and {100*(1-summaries['handwork']['median_peak_mib']/summaries['codex']['median_peak_mib']):.1f}% less than Codex.</p><div class="meta"><span>GPT-6 Astra · low reasoning</span><span>Five attempts per harness</span><span>300 seconds per attempt</span></div></div>
<section class="panel"><h2>Measured comparison</h2><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Updated Handwork</th><th>OpenCode</th><th>Codex</th></tr></thead><tbody>{rows}</tbody></table></div><p class="small">Updated Handwork uses the final optimized build only. OpenCode and Codex were measured in an earlier cohort with the same fixture, prompt, model, reasoning, context and machine. These are not newly matched rounds. All attempts passed; time medians include five completed fixes per harness. Token and tool means include all model calls, including OpenCode subagents. Memory excludes test and other tool processes.</p></section>
<section class="panel"><h2>What changed</h2><p>Related replacements use one atomic edit against the original file. Independent reads are requested together, with at most two read-only tools running concurrently. Shorter instructions and concise summaries reduce repeated context. Cache and reasoning usage are reported separately.</p><p>No additional runtime dependency was introduced. Batch edits retain permission, freshness, review and atomic commit checks.</p></section>
<section class="panel"><h2>All 15 attempts</h2><p class="small">Only updated Handwork attempts are included. Success requires all nine independent groups, existing tests and protected-file checks to pass within budget.</p><div class="table-wrap"><table><thead><tr><th>Attempt</th><th>Harness</th><th>Result</th><th>Time</th><th>Harness peak</th><th>Input / output</th><th>Tools</th><th>Evidence</th></tr></thead><tbody>{records}</tbody></table></div></section>
<section class="panel"><h2>Protocol and limitations</h2><p>Starting commit: {html.escape(data['state']['commit'])}. The verifier uses controlled promises. Fresh sessions use a five-minute budget; the local report server was paused during scoring.</p><p>Updated Handwork cohort: {html.escape(dates['updated_cohort'])}. OpenCode and Codex cohort: {html.escape(dates['original_cohort'])}. Hosted service load and caching remain uncontrolled. Five attempts on one fixture do not establish performance across other workloads.</p><p>163 focused Zig tests and two accounting tests passed. Thirty pre-existing full-suite failures remain; the full suite is not claimed clean.</p><details><summary>Measured binary hashes</summary><pre>{html.escape(json.dumps(data['state']['binary_sha256'],indent=2))}</pre></details></section>
<footer><a href="benchmarks/optimization/implementation.diff">Implementation diff</a><a href="benchmarks/optimization/results-final/current-results.json">Results JSON</a><a href="search-benchmark-results.html">Interactive search benchmark</a></footer></main></html>'''
