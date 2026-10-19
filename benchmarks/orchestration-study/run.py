#!/usr/bin/env python3
"""Freeze, journal and evaluate external paired executions. Never calls a model."""
import argparse
import hashlib
import importlib.metadata
import json
import re
import shutil
import subprocess
import sys
import delegation_case
from pathlib import Path

from accounting import reconcile
from study import (FEATURES, BUDGETS, PROTOCOL, TASKS, TRACE, controls, digest,
                   evaluate, freeze, sha, verify_manifest, write_new)

ROOT = Path(__file__).resolve().parents[2]


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key: " + key)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def contracts(repo):
    """Preserve exact legacy task contracts, without importing its execution code."""
    state = load(repo / "benchmarks/harness-efficiency/results-final/state.json")
    if state["model"] != PROTOCOL["model"] or state["effort"] != PROTOCOL["effort"]:
        raise ValueError("legacy model/effort differs from declared protocol")
    tasks = {task["task"]: {key: task[key] for key in
                           ("prompt", "fixture_hashes", "verifier_sha256")}
             for task in state["tasks"]}
    if set(tasks) != set(TASKS):
        raise ValueError("legacy six-task contract changed")
    return {"model": state["model"], "effort": state["effort"], "tasks": tasks,
            "legacy_state_sha256": sha(repo / "benchmarks/harness-efficiency/results-final/state.json")}


def begin(directory, attempt_id):
    manifest = load(directory / "manifest.json")
    verify_manifest(manifest)
    row = next((r for r in manifest["schedule"] if r["id"] == attempt_id), None)
    if row is None:
        raise ValueError("attempt is outside frozen schedule")
    earlier = manifest["schedule"][:manifest["schedule"].index(row)]
    if any(not (directory / "attempts" / (r["id"] + ".json")).exists() for r in earlier):
        raise ValueError("serial counterbalanced schedule requires earlier attempts first")
    if any(not load(directory / "attempts" / (r["id"] + ".json"))["accounting"]["eligible"] for r in earlier):
        raise ValueError("usage unavailable; stop rather than repeat unusable measurements")
    write_new(directory / "starts" / (attempt_id + ".json"),
              dict(row, manifest_sha256=manifest["manifest_sha256"]))
    return row


def record(directory, attempt_id, bundle_path, trace_path, stdout_path):
    manifest = load(directory / "manifest.json")
    verify_manifest(manifest)
    if attempt_id not in {row["id"] for row in manifest["schedule"]}:
        raise ValueError("attempt is outside frozen schedule")
    start = load(directory / "starts" / (attempt_id + ".json"))
    if start["manifest_sha256"] != manifest["manifest_sha256"]:
        raise ValueError("start manifest mismatch")
    # Snapshot supplied evidence before parsing, so later caller edits cannot change it.
    artifact_dir = directory / "artifacts" / attempt_id
    artifact_dir.mkdir(parents=True, mode=0o700, exist_ok=False)
    snapshots = {}
    for name, source in (("bundle", bundle_path), ("trace", trace_path), ("stdout", stdout_path)):
        destination = artifact_dir / name
        with Path(source).open("rb") as src, destination.open("xb") as dest:
            destination.chmod(0o600)
            shutil.copyfileobj(src, dest)
        snapshots[name] = destination
    bundle = load(snapshots["bundle"])
    trace_text = snapshots["trace"].read_text()
    accounting = reconcile(trace_text)
    output = load(snapshots["stdout"])
    expected_controls = manifest["candidate_controls"] if start["arm"] == "candidate" else {}
    problems = []
    if manifest["configuration"].get("execution", {}).get("require_bounded_delegation_activation"):
        problems.extend(bounded_delegation_problems(trace_text, start["arm"]))
    child_evidence = None
    if manifest.get("study_kind") == delegation_case.KIND:
        child_evidence = delegation_case.evidence(trace_text, start["arm"])
        problems.extend(child_evidence["problems"])
    contract = manifest["configuration"]["tasks"][start["task"]]
    expected = {"manifest_sha256": manifest["manifest_sha256"],
                "initial_fixture_hashes": contract["fixture_hashes"],
                "verifier_sha256": contract["verifier_sha256"],
                "prompt_sha256": hashlib.sha256(contract["prompt"].encode()).hexdigest(),
                "binary_sha256": manifest["binary_sha256"], "trace": TRACE,
                "controls": expected_controls,
                "task_contract_sha256": digest(manifest["configuration"]["tasks"][start["task"]])}
    for key, value in expected.items():
        if bundle.get(key) != value:
            problems.append("execution evidence mismatch: " + key)
    for key in ("fresh_workspace", "fresh_session", "protected_files_unchanged",
                "no_dependencies", "existing_tests_pass", "private_checks_pass",
                "broken_control_rejected", "known_correct_control_passed",
                "host_profile_write_denied", "context_hashes_verified"):
        if bundle.get(key) is not True:
            problems.append("missing or failed execution check: " + key)
    if bundle.get("exit_code") != 0 or isinstance(bundle.get("exit_code"), bool) or bundle.get("timeout") is not False:
        problems.append("execution failed or timed out")
    if not isinstance(output, dict) or output.get("exit_code") != 0 or not output.get("final_output") or output.get("model") != PROTOCOL["model"]:
        problems.append("native completion/model unavailable")
    # Do not sum CLI usage, which excludes child requests, into trace totals.
    row = dict(start, duration_s=bundle.get("duration_s"), accounting=accounting,
               success=not problems and accounting["eligible"], problems=problems,
               evidence={name + "_sha256": sha(path) for name, path in snapshots.items()},
               evidence_kind="external executor attestation; not independently rerun by collector")
    if child_evidence is not None:
        row["delegation_evidence"] = child_evidence
    write_new(directory / "attempts" / (attempt_id + ".json"), row)
    return row


def bounded_delegation_problems(trace, arm):
    events = re.findall(r"event=bounded_delegation subagent_id=0 enabled=(true|false) "
                        r"available=(true|false) guidance_bytes=(\d+) child_policy_bytes=(\d+) "
                        r"prompt_profile=(original|parent|child) prompt_saved_bytes=(\d+)\b", trace)
    enabled = "true" if arm == "candidate" else "false"
    if not events or any(flag != enabled or available != "true" or
                         int(size) != 0 or (int(policy) > 0) != (arm == "candidate") or
                         profile != ("parent" if arm == "candidate" else "original") or
                         (int(saved) > 0) != (arm == "candidate")
                         for flag, available, size, policy, profile, saved in events):
        return ["bounded delegation unavailable or activation evidence missing/mismatched"]
    return []


def report(directory):
    manifest = load(directory / "manifest.json")
    verify_manifest(manifest)
    records = [load(p) for p in sorted((directory / "attempts").glob("*.json"))]
    result = evaluate(manifest, records)
    for row in records:
        if row.get("id") not in {item["id"] for item in manifest["schedule"]}:
            raise ValueError("record is outside frozen schedule")
        for name in ("bundle", "trace", "stdout"):
            path = directory / "artifacts" / row["id"] / name
            if not path.is_file() or sha(path) != row.get("evidence", {}).get(name + "_sha256"):
                result["promote"] = False
                result["reasons"].append("missing or changed artifact: " + row["id"] + "/" + name)
    result["attempts"] = records
    result["started_without_terminal"] = [p.stem for p in sorted((directory / "starts").glob("*.json"))
                                          if not (directory / "attempts" / p.name).exists()]
    if result["started_without_terminal"]:
        result["promote"] = False
        result["reasons"].append("interrupted attempts retained")
    return result


def preflight(repo):
    tools = {name: shutil.which(name) for name in ("zig", "docker", "harbor", "node", "npm")}
    result = {"tools": tools, "model_calls": 0, "build_performed": False}
    try:
        result["harbor_version"] = importlib.metadata.version("harbor")
    except importlib.metadata.PackageNotFoundError:
        result["harbor_version"] = None
    if tools["docker"]:
        try:
            check = subprocess.run([tools["docker"], "info", "--format", "{{.ServerVersion}} {{.Architecture}} {{.OSType}}"],
                                   capture_output=True, text=True, timeout=10)
            result["docker_info"] = {"exit_code": check.returncode, "server": check.stdout.strip()}
        except subprocess.TimeoutExpired:
            result["docker_info"] = {"exit_code": None, "blocker": "Docker info timed out"}
    binaries = []
    for root in (repo / "zig-out/bin", repo / "prebuilds"):
        for path in sorted(root.rglob("handwork*")):
            if path.is_file():
                with path.open("rb") as stream:
                    elf = stream.read(4) == b"\x7fELF"
                binaries.append({"path": str(path), "elf": elf, "sha256": sha(path)})
    result["binaries"] = binaries
    result["live_blocker"] = "No audited isolated native subscription route is wired; no model process launched."
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    freeze_cmd = commands.add_parser("freeze")
    freeze_cmd.add_argument("--binary", required=True, type=Path)
    freeze_cmd.add_argument("--out", required=True, type=Path)
    freeze_cmd.add_argument("--feature", choices=FEATURES + BUDGETS, required=True)
    freeze_cmd.add_argument("--value", type=int)
    freeze_cmd.add_argument("--context-file", type=Path, action="append", default=[],
                            help="Explicit non-secret instruction/skill file to hash, never credentials/settings")
    for name in ("verify", "start", "record", "report"):
        command = commands.add_parser(name)
        command.add_argument("directory", type=Path)
        if name in ("start", "record"):
            command.add_argument("attempt_id")
        if name == "record":
            for field in ("bundle", "trace", "stdout"):
                command.add_argument("--" + field, type=Path, required=True)
    commands.add_parser("preflight")
    args = parser.parse_args(argv)
    if args.command == "freeze":
        config = contracts(ROOT)
        if any(p.suffix.lower() != ".md" for p in args.context_file):
            raise ValueError("context inputs must be explicit instruction/skill Markdown, never auth/settings")
        config["context_hashes"] = {str(p.resolve()): sha(p) for p in args.context_file}
        manifest = freeze(ROOT, args.binary, config, args.feature, args.value)
        args.out.mkdir(parents=True, mode=0o700, exist_ok=False)
        (args.out / "starts").mkdir()
        (args.out / "attempts").mkdir()
        write_new(args.out / "manifest.json", manifest)
        print(json.dumps({"manifest_sha256": manifest["manifest_sha256"], "live_blocker": manifest["live_blocker"]}))
    elif args.command == "verify":
        verify_manifest(load(args.directory / "manifest.json"))
        print("Frozen inputs match")
    elif args.command == "start":
        print(json.dumps(begin(args.directory, args.attempt_id)))
    elif args.command == "record":
        row = record(args.directory, args.attempt_id, args.bundle, args.trace, args.stdout)
        print(json.dumps(row))
        return 0 if row["success"] else 1
    elif args.command == "report":
        result = report(args.directory)
        print(json.dumps(result, indent=2, allow_nan=False))
        return 0 if result["promote"] else 1
    else:
        print(json.dumps(preflight(ROOT), indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("Study blocked: " + str(error), file=sys.stderr)
        sys.exit(2)
