"""Offline study contracts. No authentication, settings writes, or model execution."""
import hashlib
import json
import math
import statistics
import subprocess
from pathlib import Path

from accounting import PURPOSES
import delegation_case

TASKS = ("pagination", "search", "tenant-cache", "queue", "ledger", "stream")
FEATURES = ("COMPACT_SCHEMAS", "VERIFY_COMPLETION", "TASK_EVIDENCE", "BOUNDED_DELEGATION")
BUDGETS = ("MAX_CHILDREN", "MAX_REQUESTS", "MAX_TOKENS")
PREFIX = "HANDWORK_EXPERIMENT_"
TRACE = {"HANDWORK_TRACE_STDERR": "1", "HANDWORK_TRACE_SCOPES": "agent,subagent"}
PROTOCOL = {"version": 2, "pairs_per_task": 2, "model": "gpt-6-astra", "effort": "low",
            "wall_budget_seconds": 600, "per_task_time_ratio_max": 1.05,
            "aggregate_improvement_min": 0.05, "candidate_all_correct": True,
            "per_task_input_output_increase_allowed": False,
            "classification": "descriptive pilot, not statistical significance"}
REFERENCE_SHA = "88e2dc2fb48d41825f6b9e21410e68cdd1017b94dd0dbf602b3e48bdda5b418e"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_new(path, value):
    """Exclusive creation prevents accidental replacement of any prior attempt."""
    with Path(path).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True, allow_nan=False)
        stream.write("\n")


def source_files(repo):
    """Hash working contents, not HEAD alone, including untracked runtime/schema sources."""
    roots = ["src", ".agents", "AGENTS.md", "README.md", "build.zig", "build.zig.zon", "package.json", "package-lock.json",
             "benchmarks/orchestration-study", "benchmarks/harness-efficiency/run.py",
             "benchmarks/harness-efficiency/report.py", "benchmarks/harness-efficiency/tasks.py",
             "benchmarks/harness-efficiency/results-final/state.json",
             "benchmarks/fixed-budget/pilot.py", "benchmarks/async-search/benchmark.py",
             "benchmarks/async-search/verify.mjs", "benchmarks/async-search/fixture",
             "benchmarks/tenant-cache/fixture", "benchmarks/tenant-cache/results/state.json",
             "benchmarks/tool-batching/verify-tenant.mjs"]
    paths = set()
    for name in roots:
        path = repo / name
        if not path.exists():
            raise ValueError("missing source input: " + name)
        candidates = path.rglob("*") if path.is_dir() else [path]
        for candidate in candidates:
            relative = candidate.relative_to(repo)
            if any(part in ("__pycache__", ".git", "node_modules") for part in relative.parts):
                continue
            if candidate.is_symlink():
                raise ValueError("source symlink requires explicit materialization: " + str(relative))
            if candidate.is_file():
                paths.add(relative.as_posix())
    return {name: sha(repo / name) for name in sorted(paths)}


def controls(feature, value=None):
    if feature not in FEATURES + BUDGETS:
        raise ValueError("unknown ablation")
    if feature in FEATURES:
        if value is not None:
            raise ValueError("boolean ablations do not accept a budget")
        return {PREFIX + feature: "1"}
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("budget must be a positive integer")
    return {PREFIX + feature: str(value)}


def arm_env(inherited, candidate_controls):
    env = {k: v for k, v in inherited.items()
           if not k.startswith((PREFIX, "HANDWORK_TRACE"))}
    # Pin the original baseline after bounded delegation became the product default.
    env[PREFIX + "BOUNDED_DELEGATION"] = "0"
    env.update(TRACE)
    env.update(candidate_controls)
    return env


def schedule():
    result = []
    for attempt in (1, 2):
        for index, task in enumerate(TASKS):
            arms = ("baseline", "candidate") if (attempt + index) % 2 else ("candidate", "baseline")
            for arm in arms:
                result.append({"id": f"{task}-{attempt}-{arm}", "task": task,
                               "pair": attempt, "arm": arm})
    return result


def freeze(repo, binary, config, feature, value=None, *, supplemental=False):
    repo, binary = Path(repo).resolve(), Path(binary).resolve()
    if not binary.is_file():
        raise ValueError("fresh instrumented binary required")
    if sha(binary) == REFERENCE_SHA:
        raise ValueError("original reference lacks uniform accounting; use a fresh binary")
    data = {"protocol": PROTOCOL, "repo": str(repo), "binary": str(binary),
            "binary_sha256": sha(binary), "source_hashes": source_files(repo),
            "configuration": config, "configuration_sha256": digest(config),
            "candidate_controls": controls(feature, value), "baseline_controls": {},
            "trace": TRACE, "schedule": schedule(), "reference_sha256": REFERENCE_SHA,
            "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(),
            "live_blocker": "No audited isolated native subscription execution route is wired. "
                            "Parent must execute externally without host auth/settings staging."}
    if supplemental:
        data["study_kind"] = delegation_case.KIND
        data["configuration"] = delegation_case.configure(config)
        data["configuration_sha256"] = digest(data["configuration"])
        data["schedule"] = delegation_case.schedule()
        delegation_case.verify(data)
    data["manifest_sha256"] = digest(data)
    return data


def verify_manifest(manifest):
    payload = dict(manifest)
    expected = payload.pop("manifest_sha256")
    if digest(payload) != expected:
        raise ValueError("manifest digest mismatch")
    if manifest["protocol"] != PROTOCOL:
        raise ValueError("protocol mismatch")
    if manifest.get("study_kind") == delegation_case.KIND:
        delegation_case.verify(manifest)
    elif "study_kind" in manifest or manifest["schedule"] != schedule():
        raise ValueError("protocol or schedule mismatch")
    if manifest["configuration_sha256"] != digest(manifest["configuration"]):
        raise ValueError("configuration digest mismatch")
    if sha(manifest["binary"]) != manifest["binary_sha256"]:
        raise ValueError("binary drift")
    if source_files(Path(manifest["repo"])) != manifest["source_hashes"]:
        raise ValueError("source/fixture/schema drift")
    for name, expected_hash in manifest["configuration"].get("context_hashes", {}).items():
        if sha(name) != expected_hash:
            raise ValueError("instruction/skill context drift")


def purpose_totals(records):
    return {purpose: {key: sum(row["accounting"]["purpose_usage"][purpose][key] for row in records)
                      for key in ("input", "output", "cached", "uncached", "admitted_requests")}
            for purpose in PURPOSES}


def evaluate(manifest, records):
    """Keep legacy correctness/scoring separate from this study's promotion decision."""
    expected = {row["id"] for row in manifest["schedule"]}
    ids = [row.get("id") for row in records]
    reasons = []
    if len(set(ids)) != len(ids) or set(ids) != expected:
        reasons.append("incomplete, duplicate, or unexpected attempts")
    if any(not row.get("accounting", {}).get("eligible") for row in records):
        reasons.append("usage unavailable or inconsistent")
    if any(not isinstance(row.get("accounting", {}).get("purpose_usage"), dict)
           or set(row["accounting"]["purpose_usage"]) != set(PURPOSES) for row in records):
        reasons.append("purpose breakdown unavailable")
    if any(row.get("success") is not True for row in records):
        reasons.append("correctness failure or incomplete attempt")
    if reasons:
        return {"promote": False, "reasons": reasons, "classification": PROTOCOL["classification"]}
    by_id = {r["id"]: r for r in records}
    task_metrics = {}
    aggregate = {arm: {"seconds": 0, "input": 0,
                       "purpose_usage": purpose_totals([row for row in records if row["arm"] == arm])}
                 for arm in ("baseline", "candidate")}
    for task in (("queue",) if manifest.get("study_kind") == delegation_case.KIND else TASKS):
        arms = {arm: [by_id[f"{task}-{pair}-{arm}"] for pair in (1, 2)]
                for arm in ("baseline", "candidate")}
        invalid_duration = False
        for rows in arms.values():
            for row in rows:
                duration = row.get("duration_s")
                if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0 or duration > 600:
                    reasons.append(task + ": invalid duration")
                    invalid_duration = True
        if invalid_duration:
            continue
        values = {}
        for arm, rows in arms.items():
            values[arm] = {"median_seconds": statistics.median(r["duration_s"] for r in rows),
                           "purpose_usage": purpose_totals(rows),
                           **{key: sum(r["accounting"]["usage"][key] for r in rows)
                              for key in ("input", "output", "cached", "uncached")}}
            aggregate[arm]["seconds"] += sum(r["duration_s"] for r in rows)
            aggregate[arm]["input"] += values[arm]["input"]
        base, candidate = values["baseline"], values["candidate"]
        if candidate["median_seconds"] > base["median_seconds"] * 1.05:
            reasons.append(task + ": median time regressed >5%")
        for key in ("input", "output"):
            if candidate[key] > base[key]:
                reasons.append(task + ": " + key + " increased")
        task_metrics[task] = values
    improvements = {}
    for key in ("seconds", "input"):
        base = aggregate["baseline"][key]
        improvements[key] = (base - aggregate["candidate"][key]) / base if base else None
    if not any(value is not None and value >= 0.05 - 1e-12 for value in improvements.values()):
        reasons.append("neither aggregate time nor input improved >=5%")
    return {"promote": not reasons, "reasons": reasons, "tasks": task_metrics,
            "aggregate": aggregate, "improvement_fractions": improvements,
            "classification": (delegation_case.CLASSIFICATION if manifest.get("study_kind") == delegation_case.KIND
                               else PROTOCOL["classification"])}
