#!/usr/bin/env python3
"""Fail-closed native executor entry point. Never stage authentication.

Usage: executor.py DIRECTORY --out NEW_DIRECTORY [--execute]

The current frozen contract has no environment snapshot or kernel descendant
containment contract. Consequently --execute returns an inspectable blocker,
not a collector start or an execution attestation. Process groups alone cannot
contain a child that calls setsid(). The bounded runner below is for trusted
fixture commands, NOT a security boundary for model-generated commands.
"""
import argparse
import ast
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from run import load
from study import (BUDGETS, FEATURES, PREFIX, PROTOCOL, TRACE, arm_env, controls,
                   digest, sha, verify_manifest, write_new)


ROOT = Path(__file__).resolve().parents[2]


class Blocked(ValueError):
    """A prerequisite failed before any model process was launched."""


def next_attempt(directory, manifest):
    """Never skip, resume, or repeat an interrupted or ineligible attempt."""
    schedule = manifest["schedule"]
    ids = {row["id"] for row in schedule}
    for name in ("starts", "attempts"):
        folder = directory / name
        if folder.is_symlink() or not folder.is_dir():
            raise Blocked("missing or symlinked journal: " + name)
        if any(p.name not in {i + ".json" for i in ids} for p in folder.iterdir()):
            raise Blocked("unexpected journal entry: " + name)
    pending = None
    for row in schedule:
        start = directory / "starts" / (row["id"] + ".json")
        terminal = directory / "attempts" / start.name
        if start.is_symlink() or terminal.is_symlink():
            raise Blocked("symlinked attempt journal")
        if terminal.exists():
            if pending is not None or not start.exists():
                raise Blocked("out-of-order attempt journal")
            for path in (start, terminal):
                saved = load(path)
                if any(saved.get(k) != v for k, v in row.items()):
                    raise Blocked("attempt identity mismatch: " + row["id"])
                if saved.get("manifest_sha256") != manifest["manifest_sha256"]:
                    raise Blocked("attempt manifest mismatch: " + row["id"])
            if load(terminal).get("accounting", {}).get("eligible") is not True:
                raise Blocked("usage unavailable; no further attempts permitted")
        elif start.exists():
            raise Blocked("interrupted attempt requires external review: " + row["id"])
        elif pending is None:
            pending = row
    if pending is None:
        raise Blocked("frozen schedule is complete")
    return pending


def native_argv(binary, prompt, *, save_session=False):
    # '--' prevents a task beginning with '-' from becoming a CLI option.
    return [str(binary), "ask", "--full-access", "--json",
            *([] if save_session else ["--no-save"]), "--no-color", "--", prompt]


def native_env(inherited, controls, temporary):
    """Use only declared non-secret inputs, never the ambient credential env."""
    allowed = ("HOME", "PATH", "LANG", "LC_ALL", "TZ")
    clean = {k: inherited[k] for k in allowed if k in inherited}
    clean.update(TMPDIR=str(temporary), NO_COLOR="1", TERM="dumb",
                 GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null",
                 GIT_TERMINAL_PROMPT="0", npm_config_update_notifier="false",
                 npm_config_audit="false", npm_config_fund="false")
    return arm_env(clean, controls)


def literal_assignments(path):
    """Read fixture constants without importing any legacy executable code.

    In particular pilot.handwork_auth/credentials and legacy main/import-time
    statements are never compiled, imported, or called. Only ast.literal_eval
    is used. Reject unsupported targets instead of executing Python expressions.
    """
    values = {}
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, TypeError):
            continue
        if isinstance(target, ast.Name):
            values[target.id] = value
        elif (isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name)
              and target.value.id in values):
            values[target.value.id][ast.literal_eval(target.slice)] = value
    return values


def fixture_files(repo, task):
    """Materialize the six existing contracts without legacy imports or setup I/O."""
    pilot = literal_assignments(repo / "benchmarks/fixed-budget/pilot.py")
    tasks = literal_assignments(repo / "benchmarks/harness-efficiency/tasks.py")
    if task in tasks["TASKS"]:
        definition = tasks["TASKS"][task]
        files = {k: v.encode() for k, v in definition["files"].items()}
        files["README.md"] = ("# Behavioral contract\n\n" + definition["description"]
                              + "\n\nRun npm test. No dependencies.\n").encode()
        verifier = tasks["PREAMBLE"] + definition["verify"] + tasks["TAIL"]
        prompt, testdir = tasks["COMMON"], "tests"
    elif task == "pagination":
        files = {"src/pagination.ts": pilot["SOURCE"].encode(),
                 "test/pagination.test.ts": pilot["EXISTING"].encode()}
        verifier, prompt, testdir = pilot["VERIFY"], pilot["PROMPT"], "test"
    elif task in ("search", "tenant-cache"):
        root = repo / "benchmarks" / ("async-search" if task == "search" else task)
        files = {}
        for path in sorted((root / "fixture").rglob("*")):
            if any(p in (".git", "node_modules") for p in path.parts):
                continue
            if path.is_symlink():
                raise Blocked("fixture symlink: " + str(path))
            if path.is_file():
                files[path.relative_to(root / "fixture").as_posix()] = path.read_bytes()
        verifier_path = (root / "verify.mjs" if task == "search" else
                         repo / "benchmarks/tool-batching/verify-tenant.mjs")
        verifier = verifier_path.read_text()
        prompt = (literal_assignments(root / "benchmark.py")["PROMPT"] if task == "search"
                  else load(root / "results/state.json")["prompt"])
        testdir = "tests"
        if task == "search":
            files["README.md"] = ("# Search application\nNode 24 runs TypeScript directly. Run npm test; no dependencies.\n"
                                   "src/api/search.ts adapts HTTP; src/search/controller.ts owns state; "
                                   "src/ui/search-view.ts renders it.\n").encode()
    else:
        raise Blocked("unknown fixture: " + task)
    settings = {"provider": "codex", "models": {"codex": PROTOCOL["model"]},
                "effort": PROTOCOL["effort"], "fast_mode": False}
    files[".handwork/settings.json"] = (json.dumps(settings, indent=2) + "\n").encode()
    if "package.json" not in files:
        extension = "js" if task in tasks["TASKS"] else "ts"
        package = {"private": True, "type": "module",
                   "scripts": {"test": f"node --test {testdir}/*.test.{extension}"}}
        files["package.json"] = (json.dumps(package, indent=2) + "\n").encode()
    return files, verifier.encode(), prompt


def verify_fixture(files, verifier, prompt, contract):
    hashes = {name: hashlib.sha256(body).hexdigest() for name, body in files.items()}
    if hashes != contract["fixture_hashes"]:
        raise Blocked("initial fixture hashes differ from frozen contract")
    if hashlib.sha256(verifier).hexdigest() != contract["verifier_sha256"]:
        raise Blocked("private verifier differs from frozen contract")
    if prompt != contract["prompt"]:
        raise Blocked("task prompt differs from frozen contract")
    return hashes


def bounded_command(argv, cwd, env, stdout, stderr, timeout):
    """Run a trusted offline fixture command, closing its process group on exit.

    This deliberately does not claim containment of detached descendants. Logs
    use exclusive files rather than unbounded in-memory PIPE buffers. Elapsed
    time includes SIGKILL and reaping the leader, on success as well as timeout.
    """
    if not isinstance(timeout, (float, int)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be positive and finite")
    if isinstance(argv, (str, bytes)) or not argv:
        raise ValueError("command must be a nonempty argv, never shell text")
    start = time.monotonic()
    timed_out = False
    with Path(stdout).open("xb") as out, Path(stderr).open("xb") as err:
        os.chmod(stdout, 0o600)
        os.chmod(stderr, 0o600)
        process = subprocess.Popen(list(map(str, argv)), cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                   start_new_session=True, close_fds=True)
        try:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired as error:
                raise Blocked("process group cleanup failed; external intervention required") from error
    return {"exit_code": process.returncode, "timeout": timed_out,
            "duration_s": time.monotonic() - start,
            "cleanup_scope": "process group only; detached descendants not contained"}


def validate_manifest_paths(manifest):
    """Reject profile/credential paths before the collector hashes any input."""
    if Path(manifest["repo"]).resolve() != ROOT:
        raise Blocked("manifest repository is not this checkout")
    binary = Path(manifest["binary"])
    resolved = binary.resolve(strict=True)
    if (binary.is_symlink() or (resolved.name != "handwork" and not resolved.name.startswith("handwork-"))
            or resolved.suffix or any(part in (".handwork", ".codex", ".config") for part in resolved.parts)):
        raise Blocked("binary must be a native handwork file, never a profile or settings input")
    for name in manifest["configuration"].get("context_hashes", {}):
        context = Path(name)
        resolved = context.resolve(strict=True)
        if (context.suffix.lower() != ".md" or context.is_symlink() or not resolved.is_relative_to(ROOT)
                or any(part in (".handwork", ".codex", ".config") for part in resolved.relative_to(ROOT).parts)):
            raise Blocked("context must be checkout Markdown, never host profile/settings content")


def inspect(directory, inherited):
    manifest_path = directory / "manifest.json"
    if manifest_path.is_symlink():
        raise Blocked("manifest must not be a symlink")
    manifest = load(manifest_path)
    validate_manifest_paths(manifest)
    verify_manifest(manifest)
    row = next_attempt(directory, manifest)
    repo = Path(manifest["repo"])
    config = manifest["configuration"]
    if config["model"] != PROTOCOL["model"] or config["effort"] != PROTOCOL["effort"]:
        raise Blocked("configuration model/effort mismatch")
    if manifest.get("trace") != TRACE or manifest.get("baseline_controls") != {}:
        raise Blocked("trace or baseline controls mismatch")
    files, verifier, prompt = fixture_files(repo, row["task"])
    contract = config["tasks"][row["task"]]
    hashes = verify_fixture(files, verifier, prompt, contract)
    candidate = manifest["candidate_controls"]
    valid = [controls(feature) for feature in FEATURES]
    for feature in BUDGETS:
        value = candidate.get(PREFIX + feature)
        if isinstance(value, str) and value.isascii() and value.isdecimal() and int(value) > 0:
            valid.append(controls(feature, int(value)))
    if candidate not in valid:
        raise Blocked("invalid frozen candidate controls")
    selected_controls = candidate if row["arm"] == "candidate" else {}
    # No output directory is substituted into the measurement environment until
    # the collector defines how per-attempt paths are normalized and frozen.
    environment = native_env(inherited, selected_controls, "<fresh-attempt-tmp>")
    blockers = []
    if config.get("executor_environment_sha256") != digest(environment):
        blockers.append("Frozen manifest lacks a matching executor_environment_sha256 with normalized per-attempt paths. "
                        "Freeze the executor's sanitized environment in the collector contract before execution.")
    blockers.append("No audited kernel descendant-containment backend is available in this executor. "
                    "A process group can be escaped with setsid; sandbox-exec path denials do not prevent that. "
                    "Provide and independently verify a containment backend before any native model launch.")
    blockers.append("Host-profile write denial and private verifier/benchmark/sibling read-denial probes have not run. "
                    "Flags and a sandbox profile alone are not execution evidence.")
    return {"kind": "executor-blocker", "attempt": row,
            "manifest_sha256": manifest["manifest_sha256"],
            "binary_sha256": sha(manifest["binary"]), "source_hashes_verified": True,
            "initial_fixture_hashes": hashes, "verifier_sha256": hashlib.sha256(verifier).hexdigest(),
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "task_contract_sha256": digest(contract), "controls": selected_controls, "trace": TRACE,
            "environment_sha256": digest(environment), "wall_budget_seconds": PROTOCOL["wall_budget_seconds"],
            "model_calls": 0, "attempt_started": False, "blockers": blockers}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--out", required=True, type=Path, help="New private evidence directory")
    parser.add_argument("--execute", action="store_true", help="Opt in, subject to all safety gates")
    args = parser.parse_args(argv)
    # Never overwrite evidence or mutate the collector journals on a blocker.
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        result = inspect(args.directory.resolve(), os.environ)
    except (ValueError, OSError, KeyError, TypeError, SyntaxError) as error:
        result = {"kind": "executor-blocker", "model_calls": 0, "attempt_started": False,
                  "blockers": [str(error)]}
    result["execution_requested"] = args.execute
    write_new(args.out / "blocker.json", result)
    (args.out / "blocker.json").chmod(0o600)
    print(json.dumps(result, indent=2))
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print("Executor blocked: " + str(error), file=sys.stderr)
        sys.exit(2)
