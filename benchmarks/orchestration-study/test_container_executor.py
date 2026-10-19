"""Contract tests for the Docker boundary; real-engine probes are saved separately."""
import os
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import container_executor as c
import delegation_case
from run import bounded_delegation_problems


class ContainerExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / "workspace"
        self.workspace.mkdir()
        self.binary = self.base / "handwork"
        self.binary.write_bytes(b"binary")
        self.auth = self.base / "native-session"
        self.auth.write_bytes(b"do not read")

    def test_model_boundary_has_only_required_mounts_and_no_inherited_environment(self):
        identity = self.base / "passwd"
        identity.write_text(c.passwd_contents())
        with patch.dict(os.environ, {"OPENAI_API_KEY": "must-not-copy", "NODE_OPTIONS": "bad"}):
            name, args = c.create_args("sha256:" + "a" * 64, self.workspace,
                                      ["/opt/handwork", "--", "$(bad)"],
                                      binary=self.binary, auth=self.auth, identity=identity)
        mounts = [args[i + 1] for i, item in enumerate(args) if item == "--mount"]
        self.assertEqual(len(mounts), 4)
        self.assertTrue(any("target=/etc/passwd,readonly" in m for m in mounts))
        self.assertTrue(any("target=" + c.AUTH_TARGET + ",readonly" in m for m in mounts))
        self.assertTrue(any("target=/opt/handwork,readonly" in m for m in mounts))
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertIn("--security-opt=no-new-privileges:true", args)
        self.assertNotIn("--privileged", args)
        self.assertNotIn("--pid=host", args)
        self.assertNotIn("OPENAI_API_KEY=must-not-copy", args)
        self.assertNotIn("NODE_OPTIONS=bad", args)
        self.assertEqual(args[-3:], ["/opt/handwork", "--", "$(bad)"])

    def test_synthetic_identity_preserves_numeric_uid_without_host_identity_data(self):
        with patch.object(c.os, "getuid", return_value=1234), patch.object(c.os, "getgid", return_value=5678):
            value = c.passwd_contents()
        self.assertEqual(value, "root:x:0:0:root:/root:/bin/bash\n"
                               "handwork:x:1234:5678:Benchmark:/profile:/bin/bash\n")
        with patch.object(c.os, "getuid", return_value=0), patch.object(c.os, "getgid", return_value=0):
            self.assertEqual(c.passwd_contents().count(":0:0:"), 1)

    def test_delegation_session_capability_is_identical_in_both_arms(self):
        policy = c.execution_policy("BOUNDED_DELEGATION")
        self.assertTrue(policy["require_bounded_delegation_activation"])
        for arm in ("baseline", "candidate"):
            argv = c.native_argv("/opt/handwork", "--prompt", save_session=policy["save_session"])
            self.assertNotIn("--no-save", argv)
            self.assertEqual(argv[-2:], ["--", "--prompt"])
        for feature in ("COMPACT_SCHEMAS", "VERIFY_COMPLETION", "TASK_EVIDENCE"):
            policy = c.execution_policy(feature)
            self.assertFalse(policy["require_bounded_delegation_activation"])
            self.assertIn("--no-save", c.native_argv("/opt/handwork", "prompt", save_session=policy["save_session"]))

    def test_delegation_activation_requires_root_capability_and_correct_arm(self):
        prefix = "event=bounded_delegation subagent_id=0 "
        baseline = prefix + "enabled=false available=true guidance_bytes=0 child_policy_bytes=0 prompt_profile=original prompt_saved_bytes=0"
        candidate = prefix + "enabled=true available=true guidance_bytes=0 child_policy_bytes=389 prompt_profile=parent prompt_saved_bytes=1800"
        self.assertEqual(bounded_delegation_problems(baseline, "baseline"), [])
        self.assertEqual(bounded_delegation_problems(candidate, "candidate"), [])
        for trace in ("", baseline, candidate.replace("available=true", "available=false"),
                      candidate.replace("child_policy_bytes=389", "child_policy_bytes=0"),
                      candidate.replace("guidance_bytes=0", "guidance_bytes=389"),
                      candidate.replace("subagent_id=0", "subagent_id=1"),
                      candidate.replace("prompt_profile=parent", "prompt_profile=child"),
                      candidate.replace("prompt_saved_bytes=1800", "prompt_saved_bytes=0"),
                      candidate + "\n" + baseline):
            self.assertTrue(bounded_delegation_problems(trace, "candidate"))
        self.assertTrue(bounded_delegation_problems(candidate, "baseline"))

    def test_oracle_has_no_network_authentication_or_writable_workspace(self):
        oracle = self.base / "oracle.mjs"
        oracle.write_text("private")
        _, args = c.create_args("image", self.workspace, ["node"], oracle=oracle)
        self.assertEqual(args[args.index("--network") + 1], "none")
        mounts = [args[i + 1] for i, item in enumerate(args) if item == "--mount"]
        self.assertEqual(len(mounts), 2)
        self.assertTrue(all(m.endswith(",readonly") for m in mounts))
        self.assertFalse(any(c.AUTH_TARGET in m for m in mounts))

    def test_mount_and_fixture_paths_reject_escape_and_symlinks(self):
        link = self.base / "link"
        link.symlink_to(self.binary)
        with self.assertRaises(c.Blocked):
            c.mount(link, "/opt/handwork")
        for name in ("../outside", "/outside"):
            with self.assertRaises(c.Blocked):
                c.materialize({name: b"bad"}, self.base / ("fixture" + str(len(name))))

    def test_protected_snapshot_rejects_symlink_even_outside_protected_paths(self):
        (self.workspace / "escape").symlink_to(self.auth)
        with self.assertRaises(c.Blocked):
            c.protected(self.workspace)

    def test_immutable_image_required_before_contacting_engine(self):
        with patch.object(c, "docker", side_effect=AssertionError("not reached")):
            for image in ("node:24", "latest", "sha256:abc"):
                with self.assertRaises(c.Blocked):
                    c.runtime(image)

    def test_tenant_gold_inside_another_repository_uses_its_own_git_root(self):
        parent = self.base / "parent"
        parent.mkdir()
        subprocess.run(["git", "init", "-q", str(parent)], check=True, capture_output=True)
        workspace = parent / "results" / "fixture"
        workspace.parent.mkdir()
        files, _, _ = c.fixture_files(c.ROOT, "tenant-cache")
        c.materialize(files, workspace)
        c.apply_gold("tenant-cache", workspace)
        self.assertTrue((workspace / ".git").is_dir())
        self.assertIn("projectListPrefix", (workspace / "src/cache/keys.ts").read_text())
        self.assertIn("requireMembership(db,userId,project.organizationId)",
                      (workspace / "src/services/project-service.ts").read_text())
        self.assertFalse((parent / "src").exists())

    def test_cleanup_on_timeout_and_keyboard_interrupt(self):
        for failure in (subprocess.TimeoutExpired("docker", 1), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                calls = []
                def engine(args, **kwargs):
                    calls.append(args)
                    if args[0] == "inspect":
                        return subprocess.CompletedProcess(args, 0, '{"ExitCode":137,"OOMKilled":false}', '')
                    return subprocess.CompletedProcess(args, 0, '', '')
                with patch.object(c, "docker", side_effect=engine), patch.object(c.subprocess, "Popen") as popen:
                    process = popen.return_value
                    process.wait.side_effect = [failure, 0]
                    process.poll.return_value = None
                    out = self.base / type(failure).__name__
                    if isinstance(failure, KeyboardInterrupt):
                        with self.assertRaises(KeyboardInterrupt):
                            c.run_container("image", self.workspace, ["never"], out)
                    else:
                        result = c.run_container("image", self.workspace, ["never"], out)
                        self.assertTrue(result["timeout"])
                self.assertTrue(any(args[:2] == ["rm", "--force"] for args in calls))
                process.kill.assert_called_once()


@unittest.skipUnless(os.environ.get("HANDWORK_DOCKER_TEST_IMAGE"), "requires an explicit Docker image ID")
class RealContainerTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_child_committed_previews_reach_only_the_opted_in_parent(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-child-edit-receipts-", dir="/private/tmp"))
        print("Child edit receipt evidence: " + str(out), flush=True)
        workspace = out / "workspace"
        (workspace / "src").mkdir(parents=True)
        (workspace / "src" / "owned.js").write_text("".join(f"export const value{i} = {i};\n" for i in range(12)))
        auth = out / "synthetic-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token", "refresh_token": "synthetic-refresh",
                           "account_id": "acct_fixture", "expires_at_ms": int((time.time() + 3600) * 1000)})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        script = r'''
import http.server,threading,json,os,subprocess
original=''.join('export const value'+str(i)+' = '+str(i)+';\n' for i in range(12))
edited=''.join('export const value'+str(i)+' = '+str(i+100)+';\n' for i in range(12))
class Fixture(http.server.BaseHTTPRequestHandler):
 requests=[]
 roots=0
 children=0
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  child=not any(t.get('name')=='subagent' for t in body.get('tools',[]))
  Fixture.requests.append({'child':child,'instructions':body.get('instructions',''),'outputs':[i.get('output','') for i in body.get('input',[]) if i.get('type')=='function_call_output']})
  call=None
  if child:
   Fixture.children+=1
   if Fixture.children==1:call=('read_file',{'path':'src/owned.js'})
   elif Fixture.children==2:call=('edit_file',{'path':'src/owned.js','old_string':original,'new_string':edited})
   else:assert Fixture.children==3
  else:
   Fixture.roots+=1
   if Fixture.roots==1:call=('subagent',{'request':{'action':'run','task':'Read src/owned.js and add 100 to each of its twelve exported constants using edit_file. Do not delegate. Reply CHILD_READY.'}})
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if call:
   key=str(len(Fixture.requests));item={'type':'function_call','id':'fc_'+key,'call_id':'call_'+key,'name':call[0],'arguments':json.dumps(call[1])}
   output=[item]
   for event in [{'type':'response.output_item.added','output_index':0,'item':dict(item,arguments='')},{'type':'response.function_call_arguments.delta','output_index':0,'item_id':item['id'],'delta':item['arguments']},{'type':'response.output_item.done','output_index':0,'item':item}]:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
  else:output=[{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'CHILD_READY' if child else 'READY'}]}]
  self.wfile.write(('data: '+json.dumps({'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':output,'usage':{'input_tokens':10,'output_tokens':1,'input_tokens_details':{'cached_tokens':0}}}})+'\n\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL='http://127.0.0.1:'+str(server.server_address[1])+'/responses')
rows=[]
for arm in ('baseline','candidate'):
 Fixture.requests=[];Fixture.roots=0;Fixture.children=0
 open('/workspace/src/owned.js','w').write(original)
 env.pop('HANDWORK_EXPERIMENT_BOUNDED_DELEGATION',None)
 if arm=='baseline':env['HANDWORK_EXPERIMENT_BOUNDED_DELEGATION']='0'
 result=subprocess.run(['/opt/handwork','ask','--full-access','--json','--no-color','--','Delegate the src/owned.js edit to one child and reply READY after it finishes.'],env=env,capture_output=True,text=True,timeout=25)
 rows.append({'arm':arm,'exit':result.returncode,'requests':Fixture.requests,'trace':result.stderr,'stdout':result.stdout,'file':open('/workspace/src/owned.js').read()})
server.shutdown()
print(json.dumps(rows))
'''
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "receipts", timeout=90,
                                 binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]), auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 0, (out / "receipts.stderr").read_text())
        for row in c.load(out / "receipts.stdout"):
            self.assertEqual(row["exit"], 0, row["stdout"])
            self.assertEqual(row["file"], "".join(f"export const value{i} = {i + 100};\n" for i in range(12)))
            parents = [r for r in row["requests"] if not r["child"]]
            parent_context = "\n".join(r["instructions"] + "\n" + "\n".join(r["outputs"]) for r in parents)
            self.assertEqual("Recorded child edits" in parent_context, row["arm"] == "candidate")
            self.assertEqual("export const value6 = 106;" in parent_context, row["arm"] == "candidate")
            self.assertEqual("full_redacted_snapshot" in parent_context, row["arm"] == "candidate")
            child_context = "\n".join(r["instructions"] for r in row["requests"] if r["child"])
            self.assertEqual("/workspace/src/AGENTS.md" in child_context, row["arm"] == "candidate")
            self.assertEqual("<project-instruction-lookups>" in child_context, row["arm"] == "candidate")
            self.assertEqual("event=child_edit_receipts " in row["trace"], row["arm"] == "candidate")
            self.assertEqual(json.loads(row["stdout"])["final_output"], "READY")
            from accounting import reconcile
            accounting = reconcile(row["trace"])
            self.assertTrue(accounting["eligible"], accounting)
            self.assertEqual(accounting["child_usage"]["input"], 30)

    def test_inline_node_probe_executes_stdin_and_preserves_assertion_failures(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-inline-node-probe-", dir="/private/tmp"))
        print("Inline Node probe evidence: " + str(out), flush=True)
        workspace = out / "workspace"
        (workspace / "tests").mkdir(parents=True)
        (workspace / "tests" / "probe.test.js").write_text("import 'node:assert/strict';\n")
        script = r'''
import json,subprocess
source="import assert from 'node:assert/strict'; assert.equal(2 + 2, 4); console.log('PROBE_EXECUTED');"
rows=[]
for argv,program in [(['node','--input-type=module'],source),(['node','--input-type=module','-e',source],''),(['node','--input-type=module'],source.replace('2 + 2, 4','2 + 2, 5')),(['node','--test','--input-type=module'],source)]:
 result=subprocess.run(argv,input=program,text=True,capture_output=True,timeout=10)
 rows.append({'argv':argv,'exit':result.returncode,'stdout':result.stdout,'stderr':result.stderr})
print(json.dumps(rows))
'''
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "probe")
        self.assertEqual(result["exit_code"], 0, (out / "probe.stderr").read_text())
        passed, evaluated, failed, invalid_runner = c.load(out / "probe.stdout")
        self.assertEqual(passed["exit"], 0)
        self.assertIn("PROBE_EXECUTED", passed["stdout"])
        self.assertEqual(evaluated["exit"], 0)
        self.assertIn("PROBE_EXECUTED", evaluated["stdout"])
        self.assertNotEqual(failed["exit"], 0)
        self.assertIn("ERR_ASSERTION", failed["stderr"])
        self.assertNotEqual(invalid_runner["exit"], 0)
        self.assertIn("ERR_INPUT_TYPE_NOT_ALLOWED", invalid_runner["stdout"] + invalid_runner["stderr"])

    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_bounded_reporting_is_child_only_by_default_with_opt_out(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-bounded-child-context-", dir="/private/tmp"))
        print("Bounded child context evidence: " + str(out), flush=True)
        workspace = out / "workspace"
        workspace.mkdir()
        auth = out / "synthetic-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token",
                           "refresh_token": "synthetic-refresh", "account_id": "acct_fixture",
                           "expires_at_ms": int((time.time() + 3600) * 1000)})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        script = r'''
import http.server,threading,json,os,subprocess,time,signal,types
class Fixture(http.server.BaseHTTPRequestHandler):
 requests=[]
 roots=0
 mode='baseline'
 release=threading.Event()
 child_started=threading.Event()
 child_released=False
 overlapped=False
 window_violation=False
 def log_message(self,*args):pass
 def stream_headers(self):
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
 def event(self,event):
  try:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
 def complete(self,output):
  self.stream_headers()
  if output[0]['type']=='function_call':
   item=output[0]
   for event in [{'type':'response.output_item.added','output_index':0,'item':dict(item,arguments='')},{'type':'response.function_call_arguments.delta','output_index':0,'item_id':item['id'],'delta':item['arguments']},{'type':'response.output_item.done','output_index':0,'item':item}]:self.event(event)
  self.event({'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':output,'usage':{'input_tokens':10,'output_tokens':1,'input_tokens_details':{'cached_tokens':0}}}})
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  child=not any(tool.get('name')=='subagent' for tool in body.get('tools',[]))
  mode=Fixture.mode
  Fixture.requests.append({'child':child,'instructions':body.get('instructions',''),'tool_names':[tool.get('name') for tool in body.get('tools',[])],'input_outputs':[item.get('output','') for item in body.get('input',[]) if item.get('type')=='function_call_output']})
  if child:
   Fixture.child_started.set()
   if mode=='candidate_failure':Fixture.release.wait(15)
   elif mode!='baseline':
    marker='/workspace/parent-progress'
    deadline=time.monotonic()+8
    while not os.path.exists(marker) and time.monotonic()<deadline:time.sleep(.01)
    Fixture.overlapped=os.path.exists(marker)
    assert Fixture.overlapped,'independent parent work did not run'
    if mode=='candidate_window':Fixture.release.wait(.6)
    elif mode=='candidate_cancel_wait':Fixture.release.wait(15)
   if Fixture.mode==mode:Fixture.child_released=True
   self.complete([{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'CHILD_READY'}]}]);return
  Fixture.roots+=1
  index=Fixture.roots
  if mode=='candidate_window' and index>=3 and not Fixture.child_released:Fixture.window_violation=True
  if index==2 and mode=='candidate_failure':
   assert Fixture.child_started.wait(5)
   self.stream_headers();self.event({'type':'response.failed','response':{'id':'resp_failed','status':'failed','error':{'type':'invalid_request_error','message':'synthetic parent rejection'}}});return
  if index==1:
   output=[{'type':'function_call','id':'fc_fixture','call_id':'call_fixture','name':'subagent','arguments':json.dumps({'request':{'action':'run','task':'Reply CHILD_READY. Do not use tools.'}})}]
  elif index==2 or (index==3 and mode in ('candidate_window','candidate_cancel_wait')):
   marker='parent-progress' if index==2 else 'parent-progress-2'
   output=[{'type':'function_call','id':'fc_parent_'+str(index),'call_id':'call_parent_'+str(index),'name':'shell','arguments':json.dumps({'action':'run','command':'printf parent > '+marker})}]
  else:output=[{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'READY'}]}]
  self.complete(output)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL='http://127.0.0.1:'+str(server.server_address[1])+'/responses')
rows=[]
for mode in ('baseline','candidate','candidate_window','candidate_cancel_wait','candidate_failure'):
 Fixture.requests=[];Fixture.roots=0;Fixture.mode=mode;Fixture.release=threading.Event();Fixture.child_started=threading.Event();Fixture.child_released=False;Fixture.overlapped=False;Fixture.window_violation=False
 for marker in ('/workspace/parent-progress','/workspace/parent-progress-2'):
  if os.path.exists(marker):os.unlink(marker)
 env.pop('HANDWORK_EXPERIMENT_BOUNDED_DELEGATION',None)
 if mode=='baseline':env['HANDWORK_EXPERIMENT_BOUNDED_DELEGATION']='0'
 argv=['/opt/handwork','ask','--full-access','--json','--no-color','--','Delegate the supplied bounded task to one child.']
 started=time.monotonic()
 if mode=='candidate_cancel_wait':
  process=subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  def interrupt():
   deadline=time.monotonic()+8
   while not os.path.exists('/workspace/parent-progress') and time.monotonic()<deadline:time.sleep(.01)
   time.sleep(.2)
   process.send_signal(signal.SIGINT)
  thread=threading.Thread(target=interrupt,daemon=True);thread.start()
  stdout,stderr=process.communicate(timeout=20);thread.join(timeout=1)
  result=types.SimpleNamespace(returncode=process.returncode,stdout=stdout,stderr=stderr)
 else:result=subprocess.run(argv,env=env,capture_output=True,text=True,timeout=25)
 elapsed=time.monotonic()-started
 Fixture.release.set()
 rows.append({'elapsed':elapsed,'mode':mode,'arm':'baseline' if mode=='baseline' else 'candidate','exit':result.returncode,'requests':Fixture.requests,'trace':result.stderr,'stdout':result.stdout,'overlapped':Fixture.overlapped,'parent_work':os.path.exists('/workspace/parent-progress'),'second_parent_work':os.path.exists('/workspace/parent-progress-2'),'window_violation':Fixture.window_violation,'root_requests':Fixture.roots})
server.shutdown()
print(json.dumps(rows))
'''
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "native", timeout=120,
                                 binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                 auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 0, (out / "native.stderr").read_text())
        for row in c.load(out / "native.stdout"):
            if row["mode"] in ("candidate_failure", "candidate_cancel_wait"):
                self.assertNotEqual(row["exit"], 0)
                self.assertLess(row["elapsed"], 10)
                if row["mode"] == "candidate_cancel_wait":
                    self.assertIn("event=bounded_parent_wait", row["trace"])
                self.assertIn("event=steering_wait_yielded", row["trace"])
                self.assertIn("event=steering_continuation_released", row["trace"])
                child_terminals = [line for line in row["trace"].splitlines()
                                   if "event=request_accounting" in line and "subagent_id=1 " in line]
                self.assertTrue(child_terminals, row["trace"])
                from accounting import reconcile
                self.assertFalse(reconcile(row["trace"])["eligible"])
                continue
            self.assertEqual(row["exit"], 0, row["stdout"])
            self.assertTrue(row["parent_work"])
            if row["mode"] == "candidate_window":
                self.assertFalse(row["window_violation"])
                self.assertTrue(row["second_parent_work"], "deferred parent work must still execute")
                self.assertEqual(row["root_requests"], 4)
                self.assertIn("event=bounded_parent_wait", row["trace"])
            self.assertEqual(row["overlapped"], row["arm"] == "candidate")
            if row["arm"] == "candidate":
                self.assertIn("event=steering_wait_yielded", row["trace"])
                self.assertEqual(row["trace"].count("event=steering_result_delivered"), 1)
            roots = [request for request in row["requests"] if not request["child"]]
            children = [request for request in row["requests"] if request["child"]]
            self.assertTrue(roots)
            if row["arm"] == "candidate":
                self.assertTrue(any("Batch independent owned edits now" in output
                                    for request in roots for output in request["input_outputs"]))
            self.assertEqual(len(children), 1)
            marker = "Work only on the assigned outcome and owned paths"
            self.assertTrue(all(marker not in request["instructions"] for request in roots))
            self.assertEqual(marker in children[0]["instructions"], row["arm"] == "candidate")
            self.assertNotIn("subagent", children[0]["tool_names"])
            from accounting import reconcile
            accounting = reconcile(row["trace"])
            self.assertTrue(accounting["eligible"], accounting)
            self.assertEqual(accounting["child_usage"]["input"], 10)
            self.assertEqual(delegation_case.evidence(row["trace"], row["arm"])["problems"], [])
            self.assertEqual(bounded_delegation_problems(row["trace"], row["arm"]), [])

    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_shell_completes_without_identity_repairs_or_polling_in_both_arms(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-native-shell-identity-", dir="/private/tmp"))
        print("Native shell identity evidence: " + str(out), flush=True)
        workspace = out / "workspace"
        workspace.mkdir()
        auth = out / "synthetic-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token",
                           "refresh_token": "synthetic-refresh", "account_id": "acct_fixture",
                           "expires_at_ms": int((time.time() + 3600) * 1000)})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        script = r'''
import http.server,threading,json,os,subprocess
class Fixture(http.server.BaseHTTPRequestHandler):
 requests=[]
 command={}
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  Fixture.requests.append(body)
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if len(Fixture.requests)==1:
   output=[{'type':'function_call','id':'fc_fixture','call_id':'call_fixture','name':'shell','arguments':json.dumps(Fixture.command)}]
   events=[{'type':'response.output_item.added','output_index':0,'item':dict(output[0],arguments='')},{'type':'response.function_call_arguments.delta','output_index':0,'item_id':'fc_fixture','delta':output[0]['arguments']},{'type':'response.output_item.done','output_index':0,'item':output[0]}]
   for event in events:self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode())
  else:
   output=[{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'READY'}]}]
  event={'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':output,'usage':{'input_tokens':10,'output_tokens':1,'input_tokens_details':{'cached_tokens':0}}}}
  self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL='http://127.0.0.1:'+str(server.server_address[1])+'/responses')
rows=[]
for arm in ('baseline','candidate'):
 env.pop('HANDWORK_EXPERIMENT_BOUNDED_DELEGATION',None)
 if arm=='baseline':env['HANDWORK_EXPERIMENT_BOUNDED_DELEGATION']='0'
 for profile in (None,'clean','user'):
  Fixture.requests=[];Fixture.command={'action':'run','command':'printf marker'}
  if profile is not None:Fixture.command['profile']=profile
  result=subprocess.run(['/opt/handwork','ask','--full-access','--json','--no-color','--','Run the requested command once.'],env=env,capture_output=True,text=True,timeout=60)
  outputs=[item['output'] for body in Fixture.requests[1:] for item in body.get('input',[]) if item.get('type')=='function_call_output']
  rows.append({'arm':arm,'profile':profile,'exit':result.returncode,'requests':len(Fixture.requests),'outputs':outputs,'trace':result.stderr,'stdout':result.stdout})
server.shutdown()
print(json.dumps(rows))
'''
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "native", timeout=120,
                                 binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                 auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 0, (out / "native.stderr").read_text())
        rows = c.load(out / "native.stdout")
        self.assertEqual(len(rows), 6)
        for row in rows:
            self.assertEqual(row["exit"], 0)
            self.assertEqual(row["requests"], 2)
            self.assertEqual(len(row["outputs"]), 1)
            snapshot = json.loads(row["outputs"][0])
            self.assertEqual(snapshot["backend"], "captured")
            self.assertEqual(snapshot["state"], "completed")
            self.assertEqual(snapshot["exit_code"], 0)
            self.assertEqual(snapshot["output_delta"], "marker")
            self.assertIsNone(snapshot["error"])
            self.assertEqual(bounded_delegation_problems(row["trace"], row["arm"]), [])

    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_delegation_activation_reaches_provider_only_with_session(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-delegation-activation-", dir="/private/tmp"))
        print("Delegation activation evidence: " + str(out), flush=True)
        workspace = out / "workspace"
        workspace.mkdir()
        auth = out / "synthetic-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token",
                           "refresh_token": "synthetic-refresh", "account_id": "acct_123",
                           "expires_at_ms": int((time.time() + 3600) * 1000)})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        script = r'''
import http.server,threading,json,os,subprocess
class Fixture(http.server.BaseHTTPRequestHandler):
 requests=[]
 def log_message(self,*args):pass
 def do_POST(self):
  Fixture.requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  event={'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':[{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'READY'}]}],'usage':{'input_tokens':10,'output_tokens':1,'input_tokens_details':{'cached_tokens':0}}}}
  self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL='http://127.0.0.1:'+str(server.server_address[1])+'/responses')
rows=[]
for arm,save in [('baseline',True),('candidate',True),('candidate_explicit',True),('candidate_no_save',False)]:
 env.pop('HANDWORK_EXPERIMENT_BOUNDED_DELEGATION',None)
 if arm=='baseline':env['HANDWORK_EXPERIMENT_BOUNDED_DELEGATION']='0'
 if arm=='candidate_explicit':env['HANDWORK_EXPERIMENT_BOUNDED_DELEGATION']='1'
 argv=['/opt/handwork','ask','--full-access','--json','--no-color']+([] if save else ['--no-save'])+['--','Reply READY. Do not use tools.']
 result=subprocess.run(argv,env=env,capture_output=True,text=True,timeout=20)
 assert result.returncode==0,(arm,result.stderr)
 request=Fixture.requests[-1]
 tools=[tool.get('name',tool.get('function',{}).get('name')) for tool in request['tools']]
 instructions=request.get('instructions','')
 rows.append({'arm':arm,'subagent_available':'subagent' in tools,'instructions':instructions,'tools':request['tools'],'input':request['input'],'guidance_in_instructions':'Work only on the assigned outcome and owned paths' in instructions,'trace':result.stderr,'final_output':json.loads(result.stdout)['final_output']})
server.shutdown()
assert len(Fixture.requests)==4,len(Fixture.requests)
print(json.dumps(rows))
'''
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "activation", timeout=90,
                                 binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                 auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 0, (out / "activation.stderr").read_text())
        baseline, candidate, explicit, no_save = c.load(out / "activation.stdout")
        self.assertEqual(candidate["instructions"], explicit["instructions"])
        self.assertEqual(candidate["tools"], explicit["tools"])
        self.assertEqual(bounded_delegation_problems(explicit["trace"], "candidate"), [])
        for row in (baseline, candidate):
            self.assertTrue(row["subagent_available"])
            self.assertEqual(bounded_delegation_problems(row["trace"], row["arm"]), [])
            self.assertEqual(row["final_output"], "READY")
        self.assertFalse(baseline["guidance_in_instructions"])
        self.assertFalse(candidate["guidance_in_instructions"])
        self.assertLess(len(candidate["instructions"]), len(baseline["instructions"]))
        # Preserve the complete default identity/security/permission/communication blocks.
        default = (c.ROOT / "src/builtins/system_prompt.md").read_text()
        identity = default.split("# Efficient execution\n")[0]
        authority = "# Workspace and permissions\n" + default.split("# Workspace and permissions\n", 1)[1]
        self.assertIn(identity, candidate["instructions"])
        self.assertIn(authority, candidate["instructions"])
        self.assertIn("# Bounded execution", candidate["instructions"])
        self.assertNotIn("<project-instruction-loading>", baseline["instructions"])
        self.assertIn("<project-instruction-loading>", candidate["instructions"])
        self.assertIn("does not disable workspace or target rule lookup", candidate["instructions"])
        self.assertIn("workspace is not below home", candidate["instructions"])
        self.assertIn("event=instruction_loading_context", candidate["trace"])
        self.assertNotIn("<project-instruction-lookups>", baseline["instructions"])
        self.assertIn("<project-instruction-lookups>", candidate["instructions"])
        self.assertIn("/workspace/AGENTS.md", candidate["instructions"])
        self.assertIn("event=instruction_missing_context", candidate["trace"])
        self.assertEqual(baseline["tools"], candidate["tools"])
        self.assertEqual(baseline["input"], candidate["input"])
        self.assertFalse(no_save["subagent_available"])
        self.assertTrue(bounded_delegation_problems(no_save["trace"], "candidate"))
        # A configured-disabled loader must never announce active coverage.
        disabled_profile = out / "settings-no-context.json"
        c.write_new(disabled_profile, dict(c.PROFILE, context=False))
        disabled = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                   ["python3", "-c", script], out / "activation-no-context", timeout=90,
                                   binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                   auth=auth, profile=disabled_profile)
        self.assertEqual(disabled["exit_code"], 0, (out / "activation-no-context.stderr").read_text())
        for row in c.load(out / "activation-no-context.stdout"):
            self.assertNotIn("<project-instruction-loading>", row["instructions"])
            self.assertNotIn("event=instruction_loading_context", row["trace"])
            self.assertNotIn("<project-instruction-lookups>", row["instructions"])
            self.assertNotIn("event=instruction_missing_context", row["trace"])

    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_recovers_nested_overload_and_retains_unknown_failed_usage(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-provider-recovery-verification-", dir="/private/tmp"))
        print("Provider recovery evidence: " + str(out), flush=True)
        files, _, _ = c.fixture_files(c.ROOT, "pagination")
        workspace = out / "workspace"
        c.materialize(files, workspace)
        auth = out / "synthetic-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token",
                           "refresh_token": "synthetic-refresh", "account_id": "acct_123",
                           "expires_at_ms": int((time.time() + 3600) * 1000)})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        script = """
import http.server,threading,json,os,subprocess
class Fixture(http.server.BaseHTTPRequestHandler):
 count=0
 def log_message(self,*args):pass
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  Fixture.count+=1
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if Fixture.count==1:
   event={'type':'error','error':{'type':'server_is_overloaded','code':None,'message':'temporary fixture overload'}}
  else:
   event={'type':'response.completed','response':{'id':'resp_fixture','status':'completed','output':[{'type':'message','id':'msg_fixture','role':'assistant','content':[{'type':'output_text','text':'READY'}]}],'usage':{'input_tokens':10,'output_tokens':1,'input_tokens_details':{'cached_tokens':0}}}}
  self.wfile.write(('data: '+json.dumps(event)+'\\n\\n').encode());self.wfile.flush()
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture)
threading.Thread(target=server.serve_forever,daemon=True).start()
env=dict(os.environ,HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL='http://127.0.0.1:'+str(server.server_address[1])+'/responses')
result=subprocess.run(['/opt/handwork','ask','--full-access','--json','--no-save','--no-color','--','Reply READY. Do not use tools.'],env=env,timeout=20)
server.shutdown()
assert result.returncode==0 and Fixture.count==2,(result.returncode,Fixture.count)
"""
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 ["python3", "-c", script], out / "recovery",
                                 binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                 auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 0)
        native = c.load(out / "recovery.stdout")
        self.assertEqual(native["final_output"], "READY")
        trace = (out / "recovery.stderr").read_text()
        self.assertIn("server_is_overloaded: temporary fixture overload", trace)
        from accounting import reconcile
        accounting = reconcile(trace)
        self.assertEqual(accounting["starts"], 2)
        self.assertEqual(accounting["terminal_records"], 2)
        self.assertFalse(accounting["eligible"])
        self.assertIsNone(accounting["usage"])

    @unittest.skipUnless(os.environ.get("HANDWORK_NATIVE_TEST_BINARY"), "requires a built Linux binary")
    def test_native_readonly_expired_credentials_do_not_start_provider(self):
        out = Path(tempfile.mkdtemp(prefix="handwork-readonly-auth-verification-", dir="/private/tmp"))
        print("Read-only auth evidence: " + str(out), flush=True)
        files, _, _ = c.fixture_files(c.ROOT, "pagination")
        workspace = out / "workspace"
        c.materialize(files, workspace)
        auth = out / "synthetic-expired-auth.json"
        c.write_new(auth, {"version": 1, "access_token": "synthetic-token",
                           "refresh_token": "synthetic-refresh", "account_id": "acct_123",
                           "expires_at_ms": 0})
        auth.chmod(0o600)
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        result = c.run_container(os.environ["HANDWORK_DOCKER_TEST_IMAGE"], workspace,
                                 c.native_argv("/opt/handwork", "Do not run; login is expired."),
                                 out / "expired", binary=Path(os.environ["HANDWORK_NATIVE_TEST_BINARY"]),
                                 auth=auth, profile=profile)
        self.assertEqual(result["exit_code"], 1)
        output = c.load(out / "expired.stdout")
        self.assertEqual(output["error"], "CredentialStorageUnavailable")
        self.assertNotIn("provider_admitted", (out / "expired.stderr").read_text())
        self.assertEqual(c.load(auth)["refresh_token"], "synthetic-refresh")

    def test_all_six_controls_and_real_denial_and_detached_cleanup(self):
        image = os.environ["HANDWORK_DOCKER_TEST_IMAGE"]
        c.runtime(image)
        out = Path(tempfile.mkdtemp(prefix="handwork-container-verification-", dir="/private/tmp"))
        print("Docker verification evidence: " + str(out), flush=True)
        configuration = c.contracts(c.ROOT)
        for task in configuration["tasks"]:
            with self.subTest(task=task):
                folder = out / task
                folder.mkdir()
                files, verifier, prompt = c.fixture_files(c.ROOT, task)
                c.verify_fixture(files, verifier, prompt, configuration["tasks"][task])
                workspace = folder / "workspace"
                c.materialize(files, workspace)
                oracle = folder / "verify.mjs"
                oracle.write_bytes(verifier)
                broken = c.checks(image, workspace, oracle, task, folder / "broken")
                self.assertFalse(broken["private_checks_pass"])
                self.assertTrue(broken["existing_tests_pass"])
                c.apply_gold(task, workspace)
                correct = c.checks(image, workspace, oracle, task, folder / "correct")
                self.assertTrue(correct["private_checks_pass"])
                self.assertTrue(correct["existing_tests_pass"])
                c.write_new(folder / "results.json", {"broken": broken, "correct": correct})
        # Synthetic non-secret auth fixture exercises the same read-only mount.
        auth = out / "auth-canary"
        auth.write_text("synthetic non-secret auth canary")
        auth.chmod(0o600)
        binary = out / "handwork-canary"
        binary.write_bytes(b"not executed")
        profile = out / "settings.json"
        c.write_new(profile, c.PROFILE)
        workspace = out / "probe-workspace"
        workspace.mkdir()
        oracle = out / "private-verifier-canary"
        oracle.write_text("private")
        evidence = c.isolation_probes(image, workspace, binary, auth, oracle, out, profile)
        c.write_new(out / "isolation.json", evidence)
        self.assertEqual(auth.read_text(), "synthetic non-secret auth canary")
        self.assertTrue(evidence["host_profile_write_denied"])
        # Also exercise successful leader exit while a detached grandchild lives.
        detached = ("import os,time\nr,w=os.pipe()\nif os.fork()==0:\n os.close(r)\n os.setsid()\n"
                    " os.write(w,b'ready');os.close(w)\n time.sleep(2)\n open('/workspace/leaked','w').write('bad')\n"
                    "else:\n os.close(w)\n assert os.read(r,5)==b'ready'\n os.close(r)\n")
        result = c.run_container(image, workspace, ["python3", "-c", detached], out / "success-detached")
        time.sleep(2)
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse((workspace / "leaked").exists())
        c.write_new(out / "success-cleanup.json", result)


if __name__ == "__main__":
    unittest.main()
