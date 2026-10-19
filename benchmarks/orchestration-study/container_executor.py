"""Docker execution boundary for the frozen six-task study.

Only an attempt workspace is writable on the host. The native session file is
bind-mounted read-only, never copied. Oracles run later in a separate container
with no authentication or network. No Docker socket is exposed to either.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid
import delegation_case

from executor import (Blocked, ROOT, fixture_files, literal_assignments,
                      native_argv, next_attempt, validate_manifest_paths, verify_fixture)
from run import begin, contracts, load, record, report
from study import (FEATURES, PROTOCOL, TRACE, arm_env, digest, freeze, sha,
                   schedule, verify_manifest, write_new)


AUTH_TARGET = "/profile/.handwork/chatgpt-auth.json"
ENV = {"HOME": "/profile", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "HANDWORK_AUTH_READ_ONLY": "1",
       "TZ": "UTC", "TMPDIR": "/tmp", "NO_COLOR": "1", "TERM": "dumb",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
       "GIT_TERMINAL_PROMPT": "0", "npm_config_cache": "/tmp/npm",
       "npm_config_update_notifier": "false", "npm_config_audit": "false",
       "npm_config_fund": "false"}
LIMITS = ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
          "--pids-limit=256", "--memory=2g", "--cpus=2", "--ipc=private"]
PROFILE = {"provider": "codex", "models": {"codex": PROTOCOL["model"]},
           "effort": PROTOCOL["effort"], "fast_mode": False,
           "credential_source": "chatgpt_subscription", "yolo_acknowledged": True,
           "session_titles": False}


def execution_policy(feature):
    # --no-save disables the native subagent host. Both arms need the same
    # disposable session capability for the delegation ablation to be active.
    return {"save_session": feature == "BOUNDED_DELEGATION",
            "require_bounded_delegation_activation": feature == "BOUNDED_DELEGATION"}


def passwd_contents():
    # Host numeric ownership is needed for the workspace bind mount. The image
    # need not have that UID: native shell resolution uses getpwuid, not $SHELL.
    # This is synthetic public identity data, never a copy of the host passwd.
    root = "root:x:0:0:root:/root:/bin/bash\n" if os.getuid() != 0 else ""
    return root + f"handwork:x:{os.getuid()}:{os.getgid()}:Benchmark:/profile:/bin/bash\n"


def docker(args, timeout=30, check=True):
    result = subprocess.run(["docker", *map(str, args)], capture_output=True,
                            text=True, timeout=timeout)
    if check and result.returncode:
        # Never include native output or auth content in exceptions.
        raise Blocked("Docker operation failed: " + str(args[0]) + ": " + result.stderr[:1000])
    return result


def runtime(image):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise Blocked("executor image must be an immutable local sha256 image ID")
    info = json.loads(docker(["info", "--format", "{{json .}}"]).stdout)
    meta = json.loads(docker(["image", "inspect", image]).stdout)[0]
    if info["OSType"] != "linux" or meta["Os"] != "linux":
        raise Blocked("Linux Docker backend required")
    return {"image": meta["Id"], "architecture": meta["Architecture"],
            "server_version": info["ServerVersion"], "kernel": info["KernelVersion"],
            "limits": LIMITS, "uid": os.getuid(), "gid": os.getgid(),
            "environment": ENV, "synthetic_profile": PROFILE,
            "synthetic_passwd": passwd_contents(), "context_inventory": {
                "host_instructions": [], "host_settings": [], "host_skills": [],
                "fixture_context": "exact frozen fixture files; binary embeds system instructions"}}


def auth_path():
    path = Path.home() / ".handwork/chatgpt-auth.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Blocked("native Handwork login must exist as an owner-only regular file; run handwork auth login")
    # Inspect expiry only; never serialize, copy or print the session contents.
    try:
        expiry = load(path)["expires_at_ms"]
        valid = isinstance(expiry, int) and expiry > (time.time() + PROTOCOL["wall_budget_seconds"] + 60) * 1000
    except (ValueError, KeyError, TypeError):
        valid = False
    if not valid:
        raise Blocked("native login expires within the attempt budget; refresh it outside the benchmark")
    return path.resolve()


def mount(source, target, readonly=False):
    source = Path(source)
    if source.is_symlink() or not source.exists() or "," in str(source):
        raise Blocked("unsafe or missing mount source")
    return ["--mount", f"type=bind,source={source.resolve()},target={target}" + (",readonly" if readonly else "")]


def create_args(image, workspace, argv, controls=None, binary=None, auth=None, oracle=None, profile=None,
                identity=None):
    name = "handwork-study-" + uuid.uuid4().hex
    args = ["create", "--name", name, *LIMITS, "--user", f"{os.getuid()}:{os.getgid()}",
            "--network", "bridge" if auth else "none", "--workdir", "/workspace",
            "--tmpfs", f"/tmp:rw,nosuid,nodev,size=268435456,uid={os.getuid()},gid={os.getgid()},mode=1777",
            "--tmpfs", f"/profile:rw,nosuid,nodev,noexec,size=16777216,uid={os.getuid()},gid={os.getgid()},mode=700",
            "--tmpfs", f"/profile/.handwork:rw,nosuid,nodev,noexec,size=16777216,uid={os.getuid()},gid={os.getgid()},mode=700",
            *mount(workspace, "/workspace", readonly=oracle is not None)]
    if binary:
        args += mount(binary, "/opt/handwork", True)
    if auth:
        args += mount(auth, AUTH_TARGET, True)
    if profile:
        args += mount(profile, "/profile/.handwork/settings.json", True)
    if identity:
        args += mount(identity, "/etc/passwd", True)
    if oracle:
        args += mount(oracle, "/oracle/verify.mjs", True)
    env = arm_env(ENV, controls or {})
    args += ["--entrypoint", "/usr/bin/env", image, "-i"]
    args += [key + "=" + value for key, value in sorted(env.items())]
    return name, args + list(map(str, argv))


def run_container(image, workspace, argv, out, timeout=30, **kwargs):
    """Remove the entire PID namespace even after timeout, interruption or CLI failure."""
    identity = Path(str(out) + ".passwd")
    with identity.open("x", encoding="utf-8") as stream:
        identity.chmod(0o600)
        stream.write(passwd_contents())
    name, args = create_args(image, workspace, argv, identity=identity, **kwargs)
    start = time.monotonic()
    timed_out = False
    try:
        docker(args)
        with Path(str(out) + ".stdout").open("xb") as stdout, Path(str(out) + ".stderr").open("xb") as stderr:
            os.chmod(stdout.name, 0o600)
            os.chmod(stderr.name, 0o600)
            process = subprocess.Popen(["docker", "start", "--attach", name],
                                       stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
            finally:
                if process.poll() is None:
                    docker(["kill", name], check=False)
                    process.kill()
                process.wait(timeout=10)
        state = json.loads(docker(["inspect", "--format", "{{json .State}}", name]).stdout)
    finally:
        removed = docker(["rm", "--force", name], check=False)
        remaining = docker(["ps", "--all", "--quiet", "--filter", "name=^/" + name + "$"]).stdout.strip()
        if remaining or (removed.returncode and "No such container" not in removed.stderr):
            raise Blocked("container cleanup failed; stop before another attempt")
    return {"exit_code": state["ExitCode"], "timeout": timed_out,
            "duration_s": time.monotonic() - start, "oom_killed": state["OOMKilled"],
            "cleanup_scope": "removed container PID namespace including detached descendants"}


def materialize(files, destination):
    destination.mkdir(mode=0o700)
    for name, body in files.items():
        path = Path(name)
        if path.is_absolute() or ".." in path.parts:
            raise Blocked("fixture path escapes workspace")
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)


def protected(workspace):
    result = {}
    for path in workspace.rglob("*"):
        relative = path.relative_to(workspace)
        if path.is_symlink():
            raise Blocked("workspace symlink is not allowed in verification")
        if path.is_file() and (relative.parts[0] in ("tests", "test", ".handwork") or
                               path.name in ("package.json", "package-lock.json", "README.md")):
            result[relative.as_posix()] = sha(path)
    return result


def checks(image, workspace, oracle, task, out):
    target = "/workspace/src/pagination.ts" if task == "pagination" else "/workspace"
    private = run_container(image, workspace, ["node", "/oracle/verify.mjs", target],
                            Path(str(out) + ".private"), oracle=oracle)
    existing = run_container(image, workspace, ["npm", "test"], Path(str(out) + ".existing"))
    try:
        values = load(Path(str(out) + ".private.stdout"))
        passed = bool(values) and all(row.get("pass") is True for row in values)
    except (ValueError, TypeError, AttributeError):
        passed = False
    return {"private": private, "existing": existing,
            "private_checks_pass": private["exit_code"] == 0 and not private["timeout"] and passed,
            "existing_tests_pass": existing["exit_code"] == 0 and not existing["timeout"]}


def apply_gold(task, workspace):
    """Materialize legacy known-correct controls without importing legacy auth code."""
    definitions = literal_assignments(ROOT / "benchmarks/harness-efficiency/tasks.py")["TASKS"]
    if task in definitions:
        for name, body in definitions[task]["gold"].items():
            (workspace / name).write_text(body)
    elif task == "pagination":
        path = workspace / "src/pagination.ts"
        path.write_text(path.read_text().replace("start + pageSize - 1", "start + pageSize"))
    elif task == "search":
        path = workspace / "src/search/controller.ts"
        source = path.read_text().replace("  const listeners =", "  let requestVersion = 0;\n  const listeners =")
        source = source.replace("    async search(query) {", "    async search(query) {\n      const version = ++requestVersion;")
        source = source.replace("        update({ results });", "        if (version !== requestVersion) return;\n        update({ results });")
        source = source.replace("      } catch (error) {", "      } catch (error) {\n        if (version !== requestVersion) return;")
        path.write_text(source.replace("        update({ loading: false });", "        if (version === requestVersion) update({ loading: false });"))
    else:
        # Results may live inside this repository. Give the control its own Git
        # root, otherwise git apply discovers the parent and silently skips the
        # fixture-relative paths. Never inherit host Git configuration or hooks.
        env = dict(ENV, PATH=os.environ["PATH"], GIT_TEMPLATE_DIR="/dev/null")
        subprocess.run(["git", "init", "-q"], cwd=workspace, env=env,
                       check=True, capture_output=True)
        subprocess.run(["git", "apply", str(ROOT / "benchmarks/tenant-cache/results/1-1-handwork.diff")],
                       cwd=workspace, env=env, check=True, capture_output=True)


def isolation_probes(image, workspace, binary, auth, oracle, out, profile=None):
    """Behavioral probes use the same creation path and mounts as native execution."""
    sibling = out / "sibling-secret"
    sibling.write_text("denial-canary")
    targets = [str(oracle), str(sibling), str(ROOT / "AGENTS.md"),
               str(Path.home() / ".handwork/settings.json"), "/var/run/docker.sock"]
    # Missing host paths and symlink traversal must both be denied. Opening the
    # mounted login writable must fail without modifying or reading its contents.
    link = workspace / "denial-link"
    link.symlink_to(oracle)
    code = """import os,pwd,sys
identity=pwd.getpwuid(os.getuid())
assert identity.pw_shell=='/bin/bash' and identity.pw_dir=='/profile'
assert identity.pw_gid==os.getgid()
for p in sys.argv[1:]:
 try: os.open(p,os.O_RDONLY)
 except OSError: pass
 else: raise SystemExit('host path readable')
try: os.open('/profile/.handwork/chatgpt-auth.json',os.O_WRONLY)
except OSError: pass
else: raise SystemExit('login writable')
try: os.open('/etc/passwd',os.O_WRONLY)
except OSError: pass
else: raise SystemExit('identity writable')
print('DENIAL_PROBES_OK')
"""
    try:
        denied = run_container(image, workspace, ["python3", "-c", code, *targets, "/workspace/denial-link"],
                               out / "denial", binary=binary, auth=auth, profile=profile)
    finally:
        link.unlink()
    if denied["exit_code"] != 0 or denied["timeout"]:
        raise Blocked("host profile/private verifier/sibling denial probes failed")
    # setsid escapes process groups but must not escape PID-namespace teardown.
    detach = """import os,time
if os.fork()==0:
 os.setsid()
 if os.fork()==0:
  print('DETACHED_READY',flush=True)
  time.sleep(2);open('/workspace/escaped-descendant','w').write('escaped')
 os._exit(0)
time.sleep(10)
"""
    detached = run_container(image, workspace, ["python3", "-c", detach], out / "detached", timeout=1,
                             binary=binary, auth=auth, profile=profile)
    time.sleep(2)
    ready = "DETACHED_READY" in (out / "detached.stdout").read_text()
    if not ready or not detached["timeout"] or (workspace / "escaped-descendant").exists():
        raise Blocked("detached descendant survived containment cleanup")
    return {"denial": denied, "detached_timeout": detached,
            "host_profile_write_denied": True, "private_and_sibling_read_denied": True}


def prepare(directory, binary, image, feature, *, supplemental=False):
    binary = binary.resolve(strict=True)
    with binary.open("rb") as stream:
        header = stream.read(20)
    if header[:4] != b"\x7fELF":
        raise Blocked("container executor requires a freshly built Linux ELF binary")
    configuration = contracts(ROOT)
    configuration.update(context_hashes={}, executor=runtime(image), execution=execution_policy(feature),
                         executor_environment_sha256=digest(arm_env(ENV, {})))
    # Freeze control sources as well as the six immutable task contracts.
    configuration["known_correct_sources"] = {
        str(path.relative_to(ROOT)): sha(path) for path in
        (ROOT / "benchmarks/tenant-cache/results/1-1-handwork.diff",)}
    manifest = freeze(ROOT, binary, configuration, feature, supplemental=supplemental)
    manifest.pop("manifest_sha256")
    manifest["live_blocker"] = None
    manifest["manifest_sha256"] = digest(manifest)
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ("starts", "attempts", "execution"):
        (directory / name).mkdir(mode=0o700)
    write_new(directory / "manifest.json", manifest)
    return manifest


def execute_next(directory):
    manifest = load(directory / "manifest.json")
    validate_manifest_paths(manifest)
    verify_manifest(manifest)
    config = manifest["configuration"]
    if config["model"] != PROTOCOL["model"] or config["effort"] != PROTOCOL["effort"]:
        raise Blocked("configuration model/effort mismatch")
    if manifest["trace"] != TRACE or manifest["baseline_controls"] != {}:
        raise Blocked("trace/baseline mismatch")
    feature = next((name for name in FEATURES
                    if manifest["candidate_controls"] == {"HANDWORK_EXPERIMENT_" + name: "1"}), None)
    if feature is None or config.get("execution") != execution_policy(feature):
        raise Blocked("frozen session/activation policy mismatch; prepare a new study")
    backend = config["executor"]
    image = backend["image"]
    if runtime(image) != backend or config["executor_environment_sha256"] != digest(arm_env(ENV, {})):
        raise Blocked("frozen execution environment drift")
    for name, expected in config["known_correct_sources"].items():
        if sha(ROOT / name) != expected:
            raise Blocked("known-correct control drift")
    auth = auth_path()
    row = next_attempt(directory, manifest)
    files, verifier, prompt = fixture_files(ROOT, row["task"])
    contract = (config["original_queue_contract"] if manifest.get("study_kind") == delegation_case.KIND
                else config["tasks"][row["task"]])
    hashes = verify_fixture(files, verifier, prompt, contract)
    prompt = config["tasks"][row["task"]]["prompt"]
    out = directory / "execution" / row["id"]
    out.mkdir(mode=0o700, exist_ok=False)
    oracle = out / "verify.mjs"
    oracle.write_bytes(verifier)
    profile = out / "settings.json"
    write_new(profile, PROFILE)
    workspace = out / "workspace"
    materialize(files, workspace)
    before = protected(workspace)
    evidence = isolation_probes(image, workspace, manifest["binary"], auth, oracle, out, profile)
    broken = checks(image, workspace, oracle, row["task"], out / "broken")
    if broken["private_checks_pass"] or not broken["existing_tests_pass"]:
        raise Blocked("broken fixture control failed")
    gold = out / "gold"
    materialize(files, gold)
    apply_gold(row["task"], gold)
    correct = checks(image, gold, oracle, row["task"], out / "gold")
    if not correct["private_checks_pass"] or not correct["existing_tests_pass"]:
        raise Blocked("known-correct fixture control failed")
    evidence.update(broken=broken, known_correct=correct)
    write_new(out / "preflight.json", evidence)
    # A Git repository is fixture infrastructure, never inherited user context.
    for args in (["git", "init", "-q"], ["git", "add", "."],
                 ["git", "-c", "user.name=Benchmark", "-c", "user.email=benchmark@localhost",
                  "commit", "-qm", "Frozen benchmark fixture"]):
        subprocess.run(args, cwd=workspace, check=True, capture_output=True,
                       env=dict(ENV, PATH=os.environ["PATH"], GIT_TEMPLATE_DIR="/dev/null"))
    selected = manifest["candidate_controls"] if row["arm"] == "candidate" else {}
    begin(directory, row["id"])
    print("START " + row["id"], flush=True)
    measured = run_container(image, workspace, native_argv("/opt/handwork", prompt,
                             save_session=config["execution"]["save_session"]), out / "native",
                             timeout=PROTOCOL["wall_budget_seconds"], controls=selected,
                             binary=manifest["binary"], auth=auth, profile=profile)
    # Verify only after the model container and every descendant are gone.
    try:
        after = protected(workspace)
        unchanged = (all(after.get(k) == v for k, v in before.items())
                     if row["task"] == "tenant-cache" else before == after)
        verified = checks(image, workspace, oracle, row["task"], out / "final")
    except Blocked:
        unchanged = False
        verified = {"private_checks_pass": False, "existing_tests_pass": False}
    write_new(out / "verification.json", verified)
    bundle = dict(measured, manifest_sha256=manifest["manifest_sha256"],
                  binary_sha256=manifest["binary_sha256"], initial_fixture_hashes=hashes,
                  verifier_sha256=sha(oracle), prompt_sha256=digest_text(prompt),
                  task_contract_sha256=digest(config["tasks"][row["task"]]),
                  trace=TRACE, controls=selected, fresh_workspace=True, fresh_session=True,
                  protected_files_unchanged=unchanged,
                  no_dependencies=not any(p.name == "node_modules" for p in workspace.rglob("*")),
                  existing_tests_pass=verified["existing_tests_pass"],
                  private_checks_pass=verified["private_checks_pass"],
                  broken_control_rejected=True, known_correct_control_passed=True,
                  host_profile_write_denied=True, context_hashes_verified=True)
    write_new(out / "bundle.json", bundle)
    result = record(directory, row["id"], out / "bundle.json", out / "native.stderr", out / "native.stdout")
    print("DONE " + json.dumps({k: result[k] for k in ("id", "success", "duration_s", "accounting", "problems")}), flush=True)
    return result


def digest_text(value):
    import hashlib
    return hashlib.sha256(value.encode()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    preparation = commands.add_parser("prepare")
    preparation.add_argument("directory", type=Path)
    preparation.add_argument("--binary", type=Path, required=True)
    preparation.add_argument("--image", required=True)
    preparation.add_argument("--feature", choices=FEATURES, required=True)
    preparation.add_argument("--delegation-case", action="store_true",
                             help="separate four-attempt queue-derived delegation regression")
    run = commands.add_parser("run")
    run.add_argument("directory", type=Path)
    run.add_argument("--all", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "prepare":
        manifest = prepare(args.directory.resolve(), args.binary, args.image, args.feature,
                           supplemental=args.delegation_case)
        print(json.dumps({"manifest_sha256": manifest["manifest_sha256"]}))
        return 0
    lock_path = Path("/tmp") / f"handwork-orchestration-{os.getuid()}.lock"
    lock = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            result = execute_next(args.directory.resolve())
            if not result["accounting"]["eligible"]:
                return 1
            if any("bounded delegation unavailable" in problem for problem in result["problems"]):
                return 2
            if not args.all or len(list((args.directory / "attempts").glob("*.json"))) == len(load(args.directory / "manifest.json")["schedule"]):
                break
    finally:
        os.close(lock)
    print(json.dumps(report(args.directory.resolve()), indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print("Container study blocked: " + str(error), flush=True)
        raise SystemExit(2)
