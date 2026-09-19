"""Audit a completed series without rerunning or changing any attempts."""

import hashlib
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


out = Path(sys.argv[1]).resolve()
state = json.loads((out / "state.json").read_text())
rows = json.loads((out / "attempts.json").read_text())
summary = json.loads((out / "summary.json").read_text())
agents = ["handwork", "opencode", "codex"]
expected = {(i, h) for i in range(1, 6) for h in agents}
assert len(rows) == 15
assert {(r["attempt"], r["harness"]) for r in rows} == expected

for name, binary in state["binaries"].items():
    assert digest(Path(binary["path"])) == binary["sha256"], name
for name in ["run.py", "model_proxy.py", "actor.cjs", "verify.cjs",
             "prompt.txt", "prepare.py", "fixture.json"]:
    assert digest(out / name) == digest(out.parent / name), name
for name, key in [("verify.cjs", "verifier_sha256"), ("actor.cjs", "actor_sha256")]:
    assert digest(out / name) == state[key], name
    assert digest(Path(state["base"]) / "private" / name) == state[key], name
for name, sha in state["seed_source_sha256"].items():
    assert digest(Path(state["fixture"]) / name) == sha, name

for row in rows:
    name = row["log"]
    ungraded = json.loads((out / (name + ".ungraded.json")).read_text())
    assert all(row[k] == v for k, v in ungraded.items()), name
    checks = json.loads((out / (name + ".verify.stdout")).read_text())
    assert checks == row["checks"], name
    should_pass = bool(
        row["completed"] and not row["timeout"] and row["exit_code"] == 0
        and row["protected_files_unchanged"] and row["build_pass"]
        and row["existing_tests_pass"] and len(checks) == 10
        and all(c["pass"] for c in checks)
    )
    assert row["success"] == should_pass, name
    if row["existing_tests_pass"]:
        log = (out / (name + ".existing.stdout")).read_text()
        assert re.search(r"Tests\s+268 passed \(268\)", log), name
        assert re.search(r"Test Files\s+7 passed \(7\)", log), name
    assert state["orders"][row["attempt"] - 1][row["position"] - 1] == row["harness"]

for agent in agents:
    group = [r for r in rows if r["harness"] == agent]
    successful = [r for r in group if r["success"]]
    calculated = {
        "attempts": len(group),
        "successes": len(successful),
        "median_success_seconds": statistics.median(r["duration_s"] for r in successful)
        if successful else None,
        "median_peak_mib": statistics.median(r["peak_rss_bytes"]["harness"] / 1048576 for r in group),
    }
    for key in ["input_tokens", "output_tokens", "tool_calls", "model_requests"]:
        calculated["mean_" + key] = statistics.mean(r[key] for r in group) if all(
            r.get(key) is not None for r in group
        ) else None
    assert calculated == summary[agent], agent

events = [json.loads(line) for line in (out / "network-audit.jsonl").read_text().splitlines()]
allowed_hosts = {"chatgpt.com", "api.openai.com", "auth.openai.com", "ab.chatgpt.com"}
allowed_paths = {"/backend-api/codex/models", "/backend-api/codex/responses"}
for event in events:
    if event["kind"] == "connect":
        assert event["target"] in allowed_hosts, event
    elif event["kind"] in {"GET", "POST"}:
        assert event["target"] in allowed_paths, event
    else:
        assert event["kind"] == "denied", event

audit = {
    "passed": True,
    "attempts": len(rows),
    "successes": sum(r["success"] for r in rows),
    "checks": ["unique complete series", "frozen binary and fixture hashes",
               "ungraded outcomes preserved", "independent check evidence",
               "268-test regression evidence", "preset run order",
               "summary recalculation", "model-only proxy destinations"],
    "network_destinations": [
        {"kind": kind, "target": target, "count": count}
        for (kind, target), count in sorted(Counter(
            (e["kind"], e["target"]) for e in events
        ).items())
    ],
}
(out / "audit.json").write_text(json.dumps(audit, indent=2) + "\n")
print(json.dumps({k: audit[k] for k in ["passed", "attempts", "successes"]}))
