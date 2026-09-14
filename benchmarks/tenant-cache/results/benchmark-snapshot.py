#!/usr/bin/env python3
import contextlib,hashlib,json,os,shutil,socket,sqlite3,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[1];OUT=HERE/'results';STATE=OUT/'state.json'
sys.path.insert(0,str(ROOT/'benchmarks/async-search'))
import benchmark as search
pilot=search.pilot
# Importing this file by name from CLI is safe: the search module is on sys.path first.
ORDERS=[['handwork','opencode','codex'],['opencode','codex','handwork'],['codex','handwork','opencode'],['handwork','codex','opencode'],['opencode','handwork','codex']]
PROMPT=Path('/Users/connorlove/.codex/attachments/5ff9084a-3234-4c3d-bb9b-5ae4e4b1aaaf/pasted-text.txt').read_text().split('```text\n',1)[1].split('\n```',1)[0]
def configure():
 pilot.STATE=STATE;pilot.OUT=OUT
 s=pilot.state();pilot.CODEX=s['binaries']['codex']['path'];pilot.OPENCODE=s['binaries']['opencode']['path']
def prepare():
 assert not STATE.exists()
 f=json.loads((OUT/'freeze.json').read_text());fix=json.loads((OUT/'fixture.json').read_text());old=json.loads((ROOT/'benchmarks/async-search/results/state.json').read_text())
 s={**f,**fix,'handwork':f['binaries']['handwork']['path'],'profile_seed':old['profile_seed'],'model':pilot.MODEL,'reasoning':'low','context':pilot.CONTEXT,'machine':old['machine'],'prompt':PROMPT,'prompt_sha256':hashlib.sha256(PROMPT.encode()).hexdigest(),'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'orders':ORDERS,'time_limit_seconds':600,'attempts_per_harness':5}
 (Path(s['base'])/'forbidden').mkdir();(Path(s['base'])/'forbidden/probe.txt').write_text('private')
 pilot.write_json(STATE,s);(OUT/'prompt.txt').write_text(PROMPT)
 for b in s['binaries'].values():assert hashlib.sha256(Path(b['path']).read_bytes()).hexdigest()==b['sha256']

def environment(h,folder):
 e=pilot.env_for(h,folder)
 if h=='handwork':e.update(HANDWORK_TRACE_STDERR='1',HANDWORK_TRACE_SCOPES='agent')
 if h=='codex':
  home=folder/'codex-home';home.mkdir();shutil.copy2(Path.home()/'.codex/auth.json',home/'auth.json');(home/'auth.json').chmod(0o600)
  e['CODEX_HOME']=str(home)
 return e

def args(h,s,prompt):
 a=pilot.args_for(h,s,prompt)
 if h=='codex':a.remove('--ephemeral') # Keep local rollout evidence, including descendant sessions.
 if h=='opencode':a[a.index('--title')+1]='Organization isolation benchmark'
 return a

def isolation(s,folder,repo):
 p=pilot.sandbox(s,folder)
 denied=[Path.home()/'.codex/attachments',Path.home()/'.codex/sessions',Path.home()/'.codex/archived_sessions']
 denied += [x for x in Path('/private/tmp').glob('handwork-*') if x.resolve()!=Path(s['base']).resolve()]
 p+=''.join('(deny file-read* file-write* (subpath '+json.dumps(str(x))+'))' for x in denied)
 p+='(deny network-inbound)(deny network-outbound (remote ip "localhost:*"))'
 hidden=Path(s['private'])/'verify.mjs';link=repo/'hidden-link';link.symlink_to(hidden)
 code='''import sys,socket
for p in sys.argv[1:]:
 try:open(p).read()
 except PermissionError:pass
 else:raise AssertionError('Private path readable')
s=socket.socket()
try:s.connect(('127.0.0.1',8765))
except PermissionError:pass
else:raise AssertionError('Loopback permitted')
print('ISOLATION_OK')'''
 try:
  r=pilot.command(['/usr/bin/sandbox-exec','-p',p,sys.executable,'-c',code,str(hidden),str(link),str(Path(s['base'])/'forbidden/probe.txt')],repo)
  assert r.returncode==0,r.stderr
 finally:link.unlink()
 return p

def parse(h,log,folder):
 r=pilot.parse(h,log)
 if h=='handwork':
  trace=Path(str(log)+'.stderr').read_text();r['model_requests']=trace.count('event=provider_admitted ');r['request_count_basis']='provider admission trace, including subagents'
  r['descendant_accounting']='Fresh no-save Handwork session has no persistent subagent host; root usage covers this run'
  r['accounted_sessions']=1
  assert not __import__('re').search(r'subagent_id=[1-9]', trace), 'Unexpected Handwork descendant requires accounting'
 elif h=='opencode':
  db=folder/'xdg-data/opencode/opencode.db'
  events=[json.loads(l) for l in Path(str(log)+'.stdout').read_text().splitlines() if l.startswith('{')]
  root=next((e.get('sessionID') for e in events if e.get('sessionID')),None)
  with sqlite3.connect(db.resolve().as_uri()+'?mode=ro',uri=True) as c:
   rows=c.execute('select id,parent_id from session').fetchall();ids={root}
   while True:
    new={x for x,p in rows if p in ids}
    if new<=ids:break
    ids|=new
   parts=[json.loads(x[0]) for sid in ids for x in c.execute('select data from part where session_id=?',(sid,))]
   r['model_requests']=sum(p.get('type')=='step-start' for p in parts)
   r['request_count_basis']='Persisted model step-start records, including descendants; transport retries not separately exposed'
 elif h=='codex':
  files=list((folder/'codex-home/sessions').rglob('*.jsonl'))
  records=[]
  for p in files:
   ev=[]
   for l in p.read_text().splitlines():
    try:ev.append(json.loads(l))
    except ValueError:pass
   records.append((p,ev))
  r['rollout_files']=len(files)
  # Implemented/validated after native preflight: inspect structured rollout events.
  usage_records={};call_ids=set()
  for p,events in records:
   for e in events:
    v=e.get('payload',{})
    if e.get('type')=='token_usage_record':
     rid=v.get('response_id')
     if rid:usage_records[rid]=v['usage']
    if e.get('type')=='response_item' and v.get('type') in ('function_call','custom_tool_call','web_search_call'):
     call_ids.add(v.get('call_id') or v.get('id'))
  if usage_records:
   usages=list(usage_records.values())
   r['input_tokens']=sum(u.get('input_tokens',0) for u in usages);r['output_tokens']=sum(u.get('output_tokens',0) for u in usages);r['cached_input_tokens']=sum(u.get('cached_input_tokens',0) for u in usages);r['tool_calls']=len(call_ids)
   r['model_requests']=len(usage_records);r['accounted_sessions']=len(files)
  else:r['model_requests']=None
  r['request_count_basis']='Unique response IDs in token_usage_record across isolated parent and descendant rollouts; unbilled retries not exposed'

 return r

def preflight():
 s=pilot.state();results=[]
 for h in ['handwork','opencode','codex']:
  folder=Path(s['base'])/('preflight-'+h);repo=folder/'repo';repo.mkdir(parents=True)
  (repo/'probe.txt').write_text('before\n');pilot.command(['git','init','-q'],repo)
  env=environment(h,folder);profile=isolation(s,folder,repo);log=OUT/('preflight-'+h)
  prompt='Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
  try:
   with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(args(h,s,prompt),repo,env,log,120,profile)
   r.update(parse(h,log,folder));r['harness']=h;r['tool_probe_pass']=r['completed'] and (repo/'probe.txt').read_text()=='after\n' and pilot.native_probe_succeeded(h,log)
   results.append(r);pilot.write_json(OUT/'preflight.json',results);print('PREFLIGHT '+json.dumps(r),flush=True)
   assert r['tool_probe_pass'] and r['model_requests'],h
  finally:pilot.cleanup_auth(folder)

def fingerprint(repo):
 paths=list((repo/'tests').rglob('*'))+[repo/'package.json',repo/'package-lock.json',repo/'.handwork/settings.json']
 return {str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}

def run():
 s=pilot.state();assert not (OUT/'attempts.json').exists()
 assert len(json.loads((OUT/'preflight.json').read_text()))==3
 with socket.socket() as sock:assert sock.connect_ex(('127.0.0.1',8765))!=0,'Stop report server'
 records=[]
 for attempt,order in enumerate(ORDERS,1):
  for position,h in enumerate(order,1):
   name=f'{attempt}-{position}-{h}';folder,repo=pilot.workspace(s,name);env=environment(h,folder);profile=isolation(s,folder,repo);log=OUT/name;protected=fingerprint(repo)
   (OUT/(name+'.sandbox.sb')).write_text(profile);print('START '+name,flush=True)
   try:
    with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(args(h,s,PROMPT),repo,env,log,600,profile)
    try:r.update(parse(h,log,folder))
    except Exception as e:r.update(completed=False,model_requests=None,input_tokens=None,output_tokens=None,tool_calls=None,accounting_error=str(e))
    r.update(harness=h,attempt=attempt,position=position,workspace=str(repo),log=name,starting_commit=s['commit'])
    (OUT/(name+'.diff')).write_text(pilot.command(['git','diff','--binary',s['commit']],repo).stdout)
    # New tests are permitted; every original protected file must remain byte-identical.
    after=fingerprint(repo);r['protected_files_unchanged']=all(after.get(k)==v for k,v in protected.items());r['dependency_directory_absent']=not (repo/'node_modules').exists()
    r['verification']=pilot.measured([pilot.NODE,Path(s['private'])/'verify.mjs',repo],repo,os.environ.copy(),OUT/(name+'.verify'),30)
    r['existing_tests']=pilot.measured(['npm','test'],repo,os.environ.copy(),OUT/(name+'.existing'),60)
    try:r['checks']=json.loads((OUT/(name+'.verify.stdout')).read_text())
    except ValueError:r['checks']=[]
    r['checks'].append({'name':'Existing regression tests','category':'regressions','pass':r['existing_tests']['exit_code']==0 and r['protected_files_unchanged']})
    r['categories']={k:all(c['pass'] for c in r['checks'] if c['category']==k) and any(c['category']==k for c in r['checks']) for k in ['authorization','cache_isolation','invalidation','regressions']}
    r['success']=bool(r['completed'] and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['dependency_directory_absent'] and r['verification']['exit_code']==0 and r['existing_tests']['exit_code']==0 and len(r['checks'])==15 and all(c['pass'] for c in r['checks']))
    records.append(r);pilot.write_json(OUT/'attempts.json',records)
    print('DONE '+json.dumps({k:r.get(k) for k in ['harness','attempt','success','duration_s','input_tokens','output_tokens','model_requests','tool_calls','peak_rss_bytes','categories','timeout']}),flush=True)
   finally:pilot.cleanup_auth(folder)
 print('TENANT BENCHMARK COMPLETE',flush=True)

if __name__=='__main__':
 if sys.argv[1]=='prepare':prepare()
 else:
  configure();{'preflight':preflight,'run':run}[sys.argv[1]]()
