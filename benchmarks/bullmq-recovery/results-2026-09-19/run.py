#!/usr/bin/env python3
"""Frozen full-repository BullMQ pilot: five attempts for each native harness."""
import importlib.util,json,os,shutil,socket,statistics,subprocess,sys,time,hashlib,contextlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'benchmarks/async-search'));import benchmark as search
pilot=search.pilot
spec=importlib.util.spec_from_file_location('tenant_accounting',ROOT/'benchmarks/tenant-cache/benchmark.py');accounting=importlib.util.module_from_spec(spec);spec.loader.exec_module(accounting)
NODE='/Users/connorlove/.vite-plus/js_runtime/node/24.21.0/bin/node'
SUITE=['tests/worker.test.ts','tests/job.test.ts','tests/worker.redis.test.ts','tests/concurrency.test.ts','tests/stalled_jobs.test.ts','tests/lock_manager.test.ts','tests/job.redis.test.ts']
ORDERS=[['handwork','opencode','codex'],['opencode','codex','handwork'],['codex','handwork','opencode'],['handwork','codex','opencode'],['opencode','handwork','codex']]
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def must(args,cwd=None,env=None):
 r=pilot.command(args,cwd,env,timeout=600);assert r.returncode==0,r.stdout+r.stderr;return r

def redis_start(folder):
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 must(['/opt/homebrew/bin/redis-server','--bind','127.0.0.1','--port',str(port),'--save','','--appendonly','no','--daemonize','yes','--pidfile',str(folder/'redis.pid'),'--logfile',str(folder/'redis.log'),'--dir',str(folder)])
 return port

def redis_stop(port):
 subprocess.run(['/opt/homebrew/bin/redis-cli','-h','127.0.0.1','-p',str(port),'shutdown','nosave'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

def profile(s,folder,repo,port):
 home=Path.home();denied=[ROOT,ROOT.parent/'handwork-site',Path(s['base'])/'private',Path(s['base'])/'upstream',home/'.handwork/AGENTS.md',home/'.handwork/skills',home/'.handwork/mcp.json',home/'.handwork/sessions',home/'.handwork/history.jsonl',home/'.agents',home/'.codex/skills',home/'.codex/sessions',home/'.codex/archived_sessions',home/'.codex/attachments',home/'.codex/plugins',home/'.claude',home/'.claw',home/'.config/opencode']
 allowed={folder.resolve(),(Path(s['base'])/'bin').resolve()}
 denied += [p for p in Path(s['base']).iterdir() if p.resolve() not in allowed]
 denied += [p for p in Path('/private/tmp').glob('handwork-*') if p.resolve()!=Path(s['base']).resolve()]
 p='(version 1)(allow default)'+''.join('(deny file-read* file-write* (subpath '+json.dumps(str(x))+'))' for x in sorted(set(denied)))
 p+='(deny network-inbound)(deny network-outbound)'
 p+='(allow network-outbound (remote ip "127.0.0.1:'+str(port)+'"))'
 for ip in s['provider_ips']:
  # Sandbox remote-ip syntax accepts numeric IPv4 endpoints. Provider DNS also resolves IPv4.
  if ':' not in ip:p+='(allow network-outbound (remote ip '+json.dumps(ip+':443')+'))'
 # System DNS requests may be issued directly by runtime resolvers.
 p+='(allow network-outbound (remote udp "*:53"))'
 hidden=Path(s['base'])/'private/verify.cjs';link=repo/'private-probe';link.symlink_to(hidden)
 try:
  code='import sys,socket\nfor p in sys.argv[1:]:\n try:open(p).read()\n except PermissionError:pass\n else:raise AssertionError("Private file readable: "+p)\ns=socket.socket();s.settimeout(2)\ntry:s.connect(("140.82.112.3",443))\nexcept PermissionError:pass\nelse:raise AssertionError("Upstream network accessible")\nprint("ISOLATION_OK")'
  paths=[str(hidden),str(link),str(ROOT/'src/builtins/tools.zig')]
  for candidate in [home/'.handwork/AGENTS.md',home/'.handwork/skills/unslop/SKILL.md']:
   if candidate.exists():paths.append(str(candidate))
  must(['/usr/bin/sandbox-exec','-p',p,sys.executable,'-c',code,*paths],repo)
 finally:link.unlink()
 return p

def workspace(s,name):
 folder,repo=pilot.workspace(s,name)
 # APFS copy-on-write makes private dependency copies without sharing writable files.
 must(['/bin/cp','-cR',str(Path(s['fixture'])/'node_modules'),str(repo/'node_modules')])
 return folder,repo

def environment(h,folder,port):
 e=accounting.environment(h,folder);e['PATH']=str(Path(NODE).parent)+':'+e['PATH'];e.update(REDIS_HOST='127.0.0.1',REDIS_PORT=str(port),BULLMQ_TEST_PREFIX='bull',HANDWORK_TRACE_STDERR='1',HANDWORK_TRACE_SCOPES='agent')
 return e

def protected(repo):
 files=must(['git','ls-files','-z'],repo).stdout.split('\0')
 return {name:sha(repo/name) for name in files if name and not name.startswith('src/')}

def summarize(records,out):
 summary={}
 for h in ['handwork','opencode','codex']:
  rows=[r for r in records if r['harness']==h]
  if not rows:continue
  good=[r for r in rows if r['success']]
  summary[h]={'attempts':len(rows),'successes':len(good),'median_success_seconds':statistics.median(r['duration_s'] for r in good) if good else None,'median_peak_mib':statistics.median(r['peak_rss_bytes']['harness']/1048576 for r in rows),**{'mean_'+k:statistics.mean(r[k] for r in rows) if all(r.get(k) is not None for r in rows) else None for k in ['input_tokens','output_tokens','tool_calls','model_requests']}}
 pilot.write_json(out/'summary.json',summary)

def main():
 out=Path(sys.argv[1]).resolve();assert not out.exists();out.mkdir(parents=True)
 fixture=json.loads((HERE/'fixture.json').read_text());base=Path(fixture['base']);(base/'bin').mkdir(exist_ok=True)
 binaries={}
 for h,source in [('handwork',ROOT/'zig-out/bin/handwork'),('opencode',Path(pilot.OPENCODE)),('codex',Path(pilot.CODEX)),('codex-code-mode-host',Path(pilot.CODEX).with_name('codex-code-mode-host'))]:
  dest=base/'bin'/h;shutil.copy2(source,dest);binaries[h]={'path':str(dest),'original':str(source),'sha256':sha(dest)}
 ips=sorted({r[4][0] for host in ['chatgpt.com','api.openai.com','auth.openai.com','ab.chatgpt.com'] for r in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)})
 s={**fixture,'binaries':binaries,'handwork':binaries['handwork']['path'],'model':pilot.MODEL,'effort':'low','context':pilot.CONTEXT,'budget_seconds':1800,'attempts_per_agent':5,'orders':ORDERS,'provider_ips':ips,'prompt':(HERE/'prompt.txt').read_text(),'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'node':NODE,'suite':SUITE,'profile_note':'Personal instructions, skills, MCP configuration and history are blocked. Codex ignores user configuration and rules. OpenCode pure mode. Handwork global authentication/settings are temporarily staged and restored.'}
 pilot.OUT=out;pilot.STATE=out/'state.json';pilot.CODEX=binaries['codex']['path'];pilot.OPENCODE=binaries['opencode']['path'];pilot.NODE=NODE;pilot.write_json(pilot.STATE,s)
 for name in ['run.py','actor.cjs','verify.cjs','prompt.txt','prepare.py','fixture.json','control-upstream.json','control-broken.json']:shutil.copy2(HERE/name,out/name)
 for name,p in [('pilot.py',Path(pilot.__file__)),('accounting.py',Path(accounting.__file__))]:shutil.copy2(p,out/name)
 probes=[]
 for h in ['handwork','opencode','codex']:
  folder=base/('native-preflight-'+out.name+'-'+h);repo=folder/'repo';repo.mkdir(parents=True);must(['git','init','-q'],repo);(repo/'probe.txt').write_text('before\n');port=redis_start(folder)
  try:
   env=environment(h,folder,port);sb=profile(s,folder,repo,port);name='preflight-'+h
   print('PREFLIGHT '+h,flush=True)
   prompt='Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
   with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(accounting.args(h,s,prompt),repo,env,out/name,180,sb)
   r.update(accounting.parse(h,out/name,folder));r['harness']=h;r['pass']=bool(r['completed'] and r['exit_code']==0 and (repo/'probe.txt').read_text()=='after\n' and pilot.native_probe_succeeded(h,out/name) and r.get('input_tokens'))
   if h=='handwork':assert 'Loading skill' not in (out/(name+'.stderr')).read_text(),'Personal skill leakage'
   probes.append(r);pilot.write_json(out/'preflight.json',probes);print('PROBE '+json.dumps({'agent':h,'pass':r['pass'],'seconds':r['duration_s']}),flush=True);assert r['pass'],h+' preflight failed'
   if h=='opencode':
    seed=base/('preinstalled-'+out.name);seed.mkdir()
    for target,origin in [('config','xdg-config'),('cache','xdg-cache')]:shutil.copytree(folder/origin,seed/target)
    s['profile_seed']=str(seed);pilot.write_json(pilot.STATE,s)
  finally:pilot.cleanup_auth(folder);redis_stop(port)
 records=[]
 for attempt,order in enumerate(ORDERS,1):
  for position,h in enumerate(order,1):
   name=f'{attempt}-{h}';folder,repo=workspace(s,name);port=redis_start(folder)
   try:
    env=environment(h,folder,port);sb=profile(s,folder,repo,port);before=protected(repo);(out/(name+'.sandbox.sb')).write_text(sb)
    # Build the broken checkout before timing; no compiled reference implementation is present.
    with open(out/(name+'.setup.log'),'w') as log:subprocess.run(['npm','run','build'],cwd=repo,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
    assert all(sha(Path(b['path']))==b['sha256'] for b in binaries.values())
    print('START '+name,flush=True)
    with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(accounting.args(h,s,s['prompt']),repo,env,out/name,1800,sb)
    try:r.update(accounting.parse(h,out/name,folder))
    except Exception as e:r.update(completed=False,input_tokens=None,output_tokens=None,tool_calls=None,model_requests=None,accounting_error=str(e))
    r.update(harness=h,attempt=attempt,position=position,workspace=str(repo),log=name)
    # Persist the attempt before grading; all outcomes are retained.
    pilot.write_json(out/(name+'.ungraded.json'),r)
    patch=must(['git','diff','--binary'],repo).stdout;(out/(name+'.diff')).write_text(patch)
    after=protected(repo);r['protected_files_unchanged']=all(after.get(k)==v for k,v in before.items())
    grade_folder,grade=workspace(s,'grade-'+name)
    # Include source additions, but never copy dependencies, build artifacts or private files.
    shutil.rmtree(grade/'src');shutil.copytree(repo/'src',grade/'src',symlinks=True)
    assert not any(p.is_symlink() for p in (grade/'src').rglob('*')),'Unexpected source symlink'
    grade_port=redis_start(grade_folder);grade_env=dict(os.environ,PATH=str(Path(NODE).parent)+':'+os.environ['PATH'],REDIS_HOST='127.0.0.1',REDIS_PORT=str(grade_port),BULLMQ_TEST_PREFIX='bull')
    try:
     print('GRADE '+name,flush=True)
     built=pilot.measured(['npm','run','build'],grade,grade_env,out/(name+'.build'),180)
     r['build_pass']=built['exit_code']==0 and not built['timeout'];r['checks']=[];r['existing_tests_pass']=False
     if r['build_pass']:
      v=pilot.measured([NODE,str(base/'private/verify.cjs'),str(grade),str(grade_port)],grade,grade_env,out/(name+'.verify'),120)
      try:r['checks']=json.loads((out/(name+'.verify.stdout')).read_text())
      except ValueError:r['checks']=[]
      e=pilot.measured([NODE,'node_modules/vitest/vitest.mjs','run','--no-file-parallelism',*SUITE],grade,grade_env,out/(name+'.existing'),600)
      r['existing_tests_pass']=e['exit_code']==0 and not e['timeout'];r['verifier_exit']=v['exit_code']
     r['success']=bool(r.get('completed') and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['build_pass'] and r['existing_tests_pass'] and len(r['checks'])==10 and all(c['pass'] for c in r['checks']))
     records.append(r);pilot.write_json(out/'attempts.json',records);summarize(records,out)
     print('DONE '+json.dumps({k:r.get(k) for k in ['harness','attempt','success','duration_s','input_tokens','output_tokens','tool_calls','existing_tests_pass']}),flush=True)
    finally:redis_stop(grade_port)
   finally:pilot.cleanup_auth(folder);redis_stop(port)
 print('COMPLETE '+str(out),flush=True)
if __name__=='__main__':main()
