#!/usr/bin/env python3
"""Pagination pilot. Run prepare, smoke, run, then report. No third-party Python deps."""
import base64
import contextlib
import hashlib
import html
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/fixed-budget/results'
STATE = OUT / 'state.json'
MODEL = 'gpt-6-astra'
CONTEXT = 272000
PROMPT = ('Fix the reported bug in this repository. Inspect the relevant code, make the smallest appropriate change, '
          'and run the existing tests. Do not modify tests or install dependencies. Summarize your changes and verification.\n\n'
          'Bug report: Pagination loses the last item at page boundaries. Fix paginate in src/pagination.ts '
          'so that each one-based page returns all of its items, including a final partial page, without changing the public API.')
CODEX = '/Applications/ChatGPT.app/Contents/Resources/codex'
OPENCODE = str(Path.home() / '.opencode/bin/opencode')
NODE = shutil.which('node')
SOURCE = '''export function paginate<T>(items: readonly T[], page: number, pageSize: number): T[] {
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('pageSize must be a positive integer');
  const start = (page - 1) * pageSize;
  const end = Math.min(start + pageSize - 1, items.length);
  return items.slice(start, end);
}
'''
EXISTING = '''import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/pagination.ts';
test('empty collection', () => assert.deepEqual(paginate([], 1, 5), []));
test('page beyond collection', () => assert.deepEqual(paginate([1, 2], 5, 3), []));
test('reject invalid page', () => assert.throws(() => paginate([1], 0, 3), RangeError));
test('reject invalid page size', () => assert.throws(() => paginate([1], 1, 0), RangeError));
'''
VERIFY = '''import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { paginate } = await import(pathToFileURL(process.argv[2]).href);
const checks = [];
function check(name, fn) { try { fn(); checks.push({name, pass:true}); } catch(e) { checks.push({name,pass:false,error:e.message}); } }
check('empty', () => assert.deepEqual(paginate([], 1, 3), []));
check('exact page', () => assert.deepEqual(paginate([1,2,3], 1, 3), [1,2,3]));
check('second full page', () => assert.deepEqual(paginate([1,2,3,4,5,6], 2, 3), [4,5,6]));
check('partial page', () => assert.deepEqual(paginate([1,2,3,4,5], 2, 3), [4,5]));
check('page size one', () => assert.deepEqual(paginate([4,5,6], 2, 1), [5]));
check('beyond end', () => assert.deepEqual(paginate([1,2,3], 2, 3), []));
check('input unchanged', () => { const a = Object.freeze([1,2,3,4]); assert.deepEqual(paginate(a,1,2),[1,2]); assert.deepEqual(a,[1,2,3,4]); });
check('reconstruct all pages', () => { for(let n=0;n<=40;n++) for(let size=1;size<=9;size++) { const a=Array.from({length:n},(_,i)=>i); const b=[]; for(let p=1;p<=Math.ceil(n/size)+1;p++) b.push(...paginate(a,p,size)); assert.deepEqual(b,a); } });
check('invalid boundaries', () => { for(const x of [0,-1,1.5,NaN,Infinity]) { assert.throws(()=>paginate([1],x,2),RangeError); assert.throws(()=>paginate([1],1,x),RangeError); } });
console.log(JSON.stringify(checks)); process.exitCode=checks.every(x=>x.pass)?0:1;
'''

def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2)+'\n')

def command(args, cwd=None, env=None, timeout=60):
    return subprocess.run(list(map(str,args)), cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)

def state(): return json.loads(STATE.read_text())

def credentials():
    auth=json.loads((Path.home()/'.codex/auth.json').read_text())
    t=auth['tokens']
    claims=json.loads(base64.urlsafe_b64decode(t['access_token'].split('.')[1]+'=='))
    assert claims['exp'] > time.time()+600, 'Refresh the Codex login before benchmarking'
    return t, claims['exp']*1000

@contextlib.contextmanager
def handwork_auth():
    """Stage credentials without logging them; restore the previous file even on failure."""
    p=Path.home()/'.handwork/chatgpt-auth.json'
    previous=p.read_bytes() if p.exists() else None
    settings=p.parent/'settings.json'
    previous_settings=settings.read_bytes() if settings.exists() else None
    p.parent.mkdir(exist_ok=True,mode=0o700)
    t, expiry=credentials()
    p.write_text(json.dumps(dict(version=1,access_token=t['access_token'],refresh_token=t['refresh_token'],expires_at_ms=expiry,account_id=t['account_id'])))
    p.chmod(0o600)
    write_json(settings,{'provider':'codex','models':{'codex':MODEL},'effort':'low','fast_mode':False,'credential_source':'chatgpt_subscription','yolo_acknowledged':True})
    try: yield
    finally:
        if previous is None: p.unlink(missing_ok=True)
        else: p.write_bytes(previous)
        if previous_settings is None: settings.unlink(missing_ok=True)
        else: settings.write_bytes(previous_settings)

def env_for(harness, folder):
    env={k:v for k,v in os.environ.items() if not k.startswith(('HANDWORK_', 'OPENCODE_', 'OPENAI_', 'ANTHROPIC_'))}
    env.update(NO_COLOR='1', TERM='xterm-256color', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    if harness=='opencode':
        t,expiry=credentials()
        data=folder/'xdg-data'; config=folder/'xdg-config'; cache=folder/'xdg-cache'; st=folder/'xdg-state'
        for p in [data/'opencode',config,cache,st]:p.mkdir(parents=True,exist_ok=True)
        seed=state().get('profile_seed')
        if seed:
            for source,dest in [(Path(seed)/'config',config),(Path(seed)/'cache',cache)]:
                shutil.copytree(source,dest,dirs_exist_ok=True)
        auth=data/'opencode/auth.json'
        write_json(auth,{'openai':dict(type='oauth',access=t['access_token'],refresh=t['refresh_token'],expires=expiry,accountId=t['account_id'])}); auth.chmod(0o600)
        env.update(XDG_DATA_HOME=str(data), XDG_CONFIG_HOME=str(config), XDG_CACHE_HOME=str(cache), XDG_STATE_HOME=str(st),
            OPENCODE_CONFIG_CONTENT=json.dumps({'model':'openai/'+MODEL,'small_model':'openai/'+MODEL,'autoupdate':False,'share':'disabled',
                'permission':'allow','lsp':False,'formatter':False,'provider':{'openai':{'models':{MODEL:{'name':MODEL,'limit':{'context':CONTEXT,'output':32000},'options':{'reasoningEffort':'low'},'variants':{'low':{'reasoningEffort':'low'}}}}}}}),
            OPENCODE_DISABLE_CLAUDE_CODE='true', OPENCODE_DISABLE_AUTOUPDATE='true')
    return env

def prepare():
    OUT.mkdir(parents=True,exist_ok=True)
    if STATE.exists(): raise SystemExit('Existing pilot state; preserve results rather than overwrite.')
    base=Path(tempfile.mkdtemp(prefix='handwork-pagination-pilot-',dir='/private/tmp'))
    private=base/'private'; private.mkdir(mode=0o700)
    fixture=private/'fixture'; fixture.mkdir()
    for d in ['src','test','.handwork']:(fixture/d).mkdir()
    (fixture/'src/pagination.ts').write_text(SOURCE)
    (fixture/'test/pagination.test.ts').write_text(EXISTING)
    write_json(fixture/'package.json',{'name':'pagination-pilot','private':True,'type':'module','scripts':{'test':'node --test test/*.test.ts'},'engines':{'node':'>=24'}})
    (fixture/'README.md').write_text('# Pagination utility\n\nRun `npm test`. Node 24 runs this TypeScript directly; no external dependencies.\nPages are one-based. Inputs must not be mutated. Invalid page or page size throws RangeError.\n')
    write_json(fixture/'.handwork/settings.json',{'provider':'codex','models':{'codex':MODEL},'effort':'low','fast_mode':False})
    (fixture/'.gitignore').write_text('node_modules/\n')
    install=command(['npm','install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],fixture)
    assert install.returncode==0,install.stderr
    for args in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Pagination starting point']]:
        r=command(args,fixture); assert r.returncode==0,r.stderr
    commit=command(['git','rev-parse','HEAD'],fixture).stdout.strip()
    (private/'verify.mjs').write_text(VERIFY)
    initial=command([NODE,private/'verify.mjs',fixture/'src/pagination.ts'])
    assert initial.returncode==1,'Verifier must reject buggy starting code'
    (fixture/'src/pagination.ts').write_text(SOURCE.replace('start + pageSize - 1','start + pageSize'))
    control=command([NODE,private/'verify.mjs',fixture/'src/pagination.ts'])
    assert control.returncode==0,'Verifier must accept known-correct control'
    command(['git','reset','--hard',commit],fixture)
    existing=command(['npm','test'],fixture); assert existing.returncode==0
    binaries=base/'bin'; binaries.mkdir(); shutil.copy2(ROOT/'zig-out/bin/handwork',binaries/'handwork')
    s={'base':str(base),'private':str(private),'fixture':str(fixture),'commit':commit,'handwork':str(binaries/'handwork'),
       'model':MODEL,'reasoning':'low','context':CONTEXT,'prompt':PROMPT,'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),
       'machine':{'platform':platform.platform(),'chip':command(['sysctl','-n','machdep.cpu.brand_string']).stdout.strip(),'memory_bytes':command(['sysctl','-n','hw.memsize']).stdout.strip()},
       'verifier_control':{'original':json.loads(initial.stdout),'corrected':json.loads(control.stdout),'existing_baseline_pass':True}}
    write_json(STATE,s)
    write_json(OUT/'verifier-control.json',s['verifier_control'])
    print(json.dumps({'prepared':str(base),'commit':commit,'verifier_control':'passed'}),flush=True)

def sandbox(s,folder=None):
    # Deny both verifier and benchmark source/results. The frozen Handwork binary lives elsewhere.
    denied=[s['private'],str(ROOT),str(Path.home()/'.agents'),str(Path.home()/'.codex/skills')]
    if folder:
        # Keep the common ancestor openable by component-wise path resolvers.
        # Deny sibling contents directly instead of denying their parent with exceptions.
        allowed={Path(folder).resolve(),(Path(s['base'])/'bin').resolve()}
        denied.extend(str(p.resolve()) for p in Path(s['base']).iterdir() if p.resolve() not in allowed)
    return '(version 1)(allow default)'+''.join('(deny file-read* file-write* (subpath '+json.dumps(p)+'))' for p in sorted(set(denied)))

def args_for(h,s,prompt):
    if h=='codex':return [CODEX,'exec','--ignore-user-config','--ignore-rules','--ephemeral','--json','--dangerously-bypass-approvals-and-sandbox','-m',MODEL,'-c','model_reasoning_effort="low"','-c',f'model_context_window={CONTEXT}','-c','model_auto_compact_token_limit=250000',prompt]
    if h=='opencode':return [OPENCODE,'run','--pure','--auto','--format','json','--title','Pagination pilot','--model','openai/'+MODEL,'--variant','low',prompt]
    return [s['handwork'],'ask','--full-access','--json','--no-save','--no-color',prompt]

def sample_processes(root):
    ps=command(['/bin/ps','-ww','-axo','pid=,ppid=,rss=,args='])
    rows={}
    for line in ps.stdout.splitlines():
        fields=line.strip().split(None,3)
        if len(fields)>=4:
            try: rows[int(fields[0])]=(int(fields[1]),int(fields[2])*1024,fields[3])
            except ValueError: pass
    descendants={root}
    while True:
        new={pid for pid,(parent,*_) in rows.items() if parent in descendants}
        if new <= descendants:break
        descendants|=new
    totals={'harness':0,'tests':0,'tools':0}; entries=[]; kinds={}
    def classify(pid):
        if pid in kinds:return kinds[pid]
        parent,rss,args=rows[pid]
        if pid==root:kind='harness'
        elif ('--test' in args or re.search(r'\bnpm (?:run )?test\b',args) or 'pagination.test.ts' in args):kind='tests'
        elif 'codex-code-mode-host' in args or args.startswith((CODEX,OPENCODE)) or 'shell_snapshot' in args:kind='harness'
        elif parent in descendants and parent in rows and parent!=pid and classify(parent)=='tests':kind='tests'
        else:kind='tools'
        kinds[pid]=kind;return kind
    for pid in descendants:
        if pid not in rows:continue
        parent,rss,args=rows[pid];kind=classify(pid)
        totals[kind]+=rss; entries.append({'pid':pid,'ppid':parent,'rss':rss,'kind':kind,'command':args})
    return totals,entries

def measured(args,cwd,env,logbase,limit=300,profile=None):
    env=dict(env, PWD=str(cwd));env.pop('OLDPWD',None);env.pop('INIT_CWD',None)
    launched=['/usr/bin/sandbox-exec','-p',profile]+args if profile else args
    peak={'harness':0,'tests':0,'tools':0}; samples=[]
    with open(str(logbase)+'.stdout','w') as stdout,open(str(logbase)+'.stderr','w') as stderr:
        start=time.monotonic(); p=subprocess.Popen(launched,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        def drain(stream,dest):
            for data in iter(lambda:stream.read(4096),b''):
                dest.write(data.decode('utf-8',errors='replace'));dest.flush()
        readers=[threading.Thread(target=drain,args=(p.stdout,stdout)),threading.Thread(target=drain,args=(p.stderr,stderr))]
        for reader in readers:reader.start()
        timed_out=False
        while p.poll() is None:
            elapsed=time.monotonic()-start
            totals,entries=sample_processes(p.pid)
            for k in peak:peak[k]=max(peak[k],totals[k])
            samples.append({'seconds':round(elapsed,3),'totals':totals,'processes':entries})
            if elapsed>=limit:
                timed_out=True; os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=2)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
                break
            time.sleep(.04)
        duration=time.monotonic()-start
        try:os.killpg(p.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        for reader in readers:reader.join(timeout=3)
    write_json(Path(str(logbase)+'.memory.json'),samples)
    return {'duration_s':round(duration,3),'timeout':timed_out,'exit_code':p.returncode,'peak_rss_bytes':peak,'samples':len(samples)}

def parse(h,logbase):
    raw=Path(str(logbase)+'.stdout').read_text()
    events=[]
    for line in raw.splitlines():
        try:events.append(json.loads(line))
        except json.JSONDecodeError:pass
    result={'input_tokens':None,'output_tokens':None,'cached_input_tokens':None,'tool_calls':0,'completed':False}
    if h=='handwork' and events:
        e=events[-1];result.update(e.get('usage',{}));result.update(e.get('usage_details',{}));result['tool_calls']=len(e.get('tool_calls',[]));result['completed']=e.get('exit_code')==0 and bool(e.get('final_output'));result['reported_model']=e.get('model')
    elif h=='codex':
        for e in events:
            if e.get('type')=='turn.completed':result.update(e.get('usage',{}));result['completed']=True
            if e.get('type')=='item.completed' and e.get('item',{}).get('type') in ['command_execution','file_change','mcp_tool_call','web_search']:result['tool_calls']+=1
    elif h=='opencode':
        usage=[]
        for e in events:
            if e.get('type')=='tool_use':result['tool_calls']+=1
            if e.get('type')=='step_finish':
                p=e.get('part',{});usage.append(p.get('tokens',{}))
                if p.get('reason')=='stop':result['completed']=True
        if usage:
            result['input_tokens']=sum(x.get('input',0)+x.get('cache',{}).get('read',0)+x.get('cache',{}).get('write',0) for x in usage)
            result['output_tokens']=sum(x.get('output',0)+x.get('reasoning',0) for x in usage)
            result['cached_input_tokens']=sum(x.get('cache',{}).get('read',0) for x in usage)
    if h=='opencode' and events:
        root=next((e.get('sessionID') for e in events if e.get('sessionID')),None)
        db=Path(state()['base'])/Path(logbase).name/'xdg-data/opencode/opencode.db'
        if root and db.exists():
            result['parent_only_usage']={k:result[k] for k in ['input_tokens','output_tokens','cached_input_tokens','tool_calls']}
            result.update(opencode_session_usage(db,root))
        elif any(e.get('type')=='tool_use' and e.get('part',{}).get('tool')=='task' for e in events):
            # Child model/tool activity is not included in root CLI events.
            # Never label parent-only counts as whole-harness totals.
            result['parent_only_usage']={k:result[k] for k in ['input_tokens','output_tokens','cached_input_tokens','tool_calls']}
            result['accounting_unavailable']='Descendant session database unavailable'
            for key in ['input_tokens','output_tokens','cached_input_tokens','tool_calls']:result[key]=None
    return result

def opencode_session_usage(db, root_session):
    """Read parent + descendant usage without opening credentials or mutating SQLite."""
    with sqlite3.connect(Path(db).resolve().as_uri()+'?mode=ro',uri=True) as conn:
        rows=conn.execute('SELECT id,parent_id,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session').fetchall()
        selected={root_session}
        while True:
            children={r[0] for r in rows if r[1] in selected}
            if children <= selected:break
            selected |= children
        chosen=[r for r in rows if r[0] in selected]
        if not any(r[0]==root_session for r in chosen):raise ValueError('Missing root session')
        tool_calls=0
        for sid in selected:
            for (raw,) in conn.execute('SELECT data FROM part WHERE session_id=?',(sid,)):
                tool_calls += json.loads(raw).get('type')=='tool'
        return {'input_tokens':sum(r[2]+r[5]+r[6] for r in chosen),
                'output_tokens':sum(r[3]+r[4] for r in chosen),
                'cached_input_tokens':sum(r[5] for r in chosen),
                'reasoning_tokens':sum(r[4] for r in chosen),
                'tool_calls':tool_calls,'accounted_sessions':len(chosen)}


def workspace(s,name):
    folder=Path(s['base'])/name;folder.mkdir()
    repo=folder/'repo'
    r=command(['git','clone','--quiet','--no-hardlinks',s['fixture'],repo]);assert r.returncode==0,r.stderr
    command(['git','reset','--hard',s['commit']],repo)
    assert command(['git','rev-parse','HEAD'],repo).stdout.strip()==s['commit']
    return folder,repo

def cleanup_auth(folder):
    for p in folder.rglob('auth.json'):p.unlink()

def native_probe_succeeded(h,log):
    events=[json.loads(line) for line in Path(str(log)+'.stdout').read_text().splitlines()]
    if h=='handwork':
        calls=events[-1].get('tool_calls',[])
        return all(c.get('status')=='success' for c in calls) and any(c.get('name')=='shell' and c.get('command_result',{}).get('exit_code')==0 for c in calls)
    if h=='opencode':
        calls=[e['part'] for e in events if e.get('type')=='tool_use']
        return all(c['state']['status']=='completed' for c in calls) and any(c['tool']=='bash' and c['state'].get('metadata',{}).get('exit')==0 and 'PROBE_OK' in c['state'].get('output','') for c in calls)
    calls=[e['item'] for e in events if e.get('type')=='item.completed']
    return any(c.get('type')=='command_execution' and c.get('exit_code')==0 and 'PROBE_OK' in c.get('aggregated_output','') for c in calls)

def smoke():
    s=state(); results=[]
    for h in ['codex','opencode','handwork']:
        folder,repo=workspace(s,'smoke-'+h+'-'+str(int(time.time())))
        env=env_for(h,folder)
        if h=='handwork':
            with handwork_auth():
                catalog=command([s['handwork'],'models'],repo,env)
                (OUT/'handwork-models.txt').write_text(catalog.stdout+catalog.stderr)
        # Confirm the exact sandbox prevents verifier reads, then make a model-only request.
        probe=command(['/usr/bin/sandbox-exec','-p',sandbox(s),'/bin/cat',Path(s['private'])/'verify.mjs'],repo,env)
        assert probe.returncode!=0 and not probe.stdout,'Hidden verifier unexpectedly readable'
        log=OUT/('smoke-'+h)
        with handwork_auth() if h=='handwork' else contextlib.nullcontext():
            r=measured(args_for(h,s,'Reply with exactly READY. Do not call tools.'),repo,env,log,90,sandbox(s))
        r.update(parse(h,log));r['harness']=h;results.append(r);cleanup_auth(folder)
        print(json.dumps(r),flush=True)
    write_json(OUT/'smoke.json',results)

def run():
    s=state(); smoke_results=json.loads((OUT/'smoke.json').read_text())
    assert all(r['completed'] for r in smoke_results),'Resolve smoke failures before task runs'
    assert not (OUT/'attempts.json').exists(),'Do not overwrite measured attempts'
    runs=[]
    # Every harness is first, second and third once.
    for attempt,order in enumerate([['handwork','opencode','codex'],['opencode','codex','handwork'],['codex','handwork','opencode']],1):
        for position,h in enumerate(order,1):
            name=f'{attempt}-{position}-{h}'; folder,repo=workspace(s,(OUT.name+'-' if OUT.name in ['final','corrected'] else '')+name);env=env_for(h,folder);log=OUT/name
            (OUT/(name+'.sandbox.sb')).write_text(sandbox(s,folder))
            print('START '+name,flush=True)
            with handwork_auth() if h=='handwork' else contextlib.nullcontext():
                r=measured(args_for(h,s,PROMPT),repo,env,log,300,sandbox(s,folder))
            r.update(parse(h,log));r.update(harness=h,attempt=attempt,position=position,starting_commit=s['commit'],workspace=str(repo),log=name)
            diff=command(['git','diff','--binary',s['commit']],repo).stdout;(OUT/(name+'.diff')).write_text(diff)
            protected=command(['git','diff','--exit-code',s['commit'],'--','test','package.json','package-lock.json','.handwork/settings.json'],repo)
            r['protected_files_unchanged']=protected.returncode==0
            check=measured([NODE,Path(s['private'])/'verify.mjs',repo/'src/pagination.ts'],repo,os.environ.copy(),OUT/(name+'.verify'),30)
            existing=measured(['npm','test'],repo,os.environ.copy(),OUT/(name+'.existing'),30)
            r['verification']=check;r['existing_tests']=existing
            r['success']=r['completed'] and not r['timeout'] and r['exit_code']==0 and check['exit_code']==0 and existing['exit_code']==0 and r['protected_files_unchanged']
            runs.append(r);write_json(OUT/'attempts.json',runs);cleanup_auth(folder)
            print('DONE '+json.dumps(r),flush=True)
    print('PILOT COMPLETE',flush=True)

def warm():
    s=state();seed=Path(s['base'])/'preinstalled';seed.mkdir(exist_ok=True)
    # Only runtime packages and model catalog cache; no sessions, prompts, credentials or fixes.
    original=Path(s['base'])/'1-2-opencode'
    for name,source in [('config','xdg-config'),('cache','xdg-cache')]:
        shutil.copytree(original/source,seed/name,dirs_exist_ok=True)
    s['profile_seed']=str(seed);write_json(STATE,s)
    print('Preinstalled OpenCode runtime profile ready',flush=True)

def validate_tools():
    """Exercise real harness tools, not just a direct cat of an allowed leaf."""
    s=state();results=[]
    for h in ['handwork','opencode','codex']:
        folder,repo=workspace(s,'corrected-preflight-'+h)
        (repo/'probe.txt').write_text('before\n')
        env=env_for(h,folder);profile=sandbox(s,folder)
        # Reproduce Handwork's no-follow component traversal, plus denied leaf and symlink reads.
        probe='''import os,sys
root,hidden,sibling=sys.argv[1:]
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for part in root.strip('/').split('/'):
 new=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=new
os.close(fd)
assert open(root+'/probe.txt').read()=='before\\n'
for target in [hidden,sibling,root+'/verifier-link']:
 try:open(target).read()
 except PermissionError:pass
 else:raise AssertionError('Protected content readable: '+target)
print('TRAVERSAL_AND_ISOLATION_OK')
'''
        hidden=str(Path(s['private'])/'verify.mjs');sibling=str(Path(s['base'])/'1-1-handwork/repo/src/pagination.ts')
        (repo/'verifier-link').symlink_to(hidden)
        check=command(['/usr/bin/sandbox-exec','-p',profile,sys.executable,'-c',probe,str(repo),hidden,sibling],repo,env)
        assert check.returncode==0,check.stderr
        (repo/'verifier-link').unlink()
        prompt="Use your normal tools to read probe.txt and change its only line from before to after. Then use your shell tool to run: test \"$(cat probe.txt)\" = after && printf 'PROBE_OK\\n'. Do not modify any other files or install dependencies. Summarize the verification."
        log=OUT/('tool-preflight-'+h)
        try:
            with handwork_auth() if h=='handwork' else contextlib.nullcontext():
                r=measured(args_for(h,s,prompt),repo,env,log,90,profile)
            r.update(parse(h,log));r.update(harness=h,isolation_probe=check.stdout.strip())
            r['tool_probe_pass']=r['completed'] and (repo/'probe.txt').read_text()=='after\n' and native_probe_succeeded(h,log)
            results.append(r);write_json(OUT/'smoke.json',results)
            print(json.dumps(r),flush=True)
            assert r['tool_probe_pass'],f'{h} native tool probe failed'
        finally:cleanup_auth(folder)

def corrected():
    global OUT
    OUT=OUT/'corrected';OUT.mkdir(exist_ok=True)
    assert not (OUT/'runner-snapshot.py').exists(),'Do not overwrite a corrected series; use a new results location'
    # Retain exact runner source alongside this series.
    shutil.copy2(__file__,OUT/'runner-snapshot.py')
    validate_tools()
    run()

if __name__=='__main__':
    action=sys.argv[1]
    if action=='final':
        warm();OUT=OUT/'final';OUT.mkdir(exist_ok=True)
        shutil.copy2(OUT.parent/'smoke.json',OUT/'smoke.json')
        run()
    else:{'prepare':prepare,'smoke':smoke,'run':run,'warm':warm,'corrected':corrected}[action]()
