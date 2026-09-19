#!/usr/bin/env python3
"""Fresh paired native Handwork runs. Frozen binaries, isolated fixtures, hidden checks."""
import argparse, hashlib, json, os, re, shutil, statistics, subprocess, sys, tempfile, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'benchmarks/async-search'))
import benchmark as search
pilot=search.pilot

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def must(args,cwd):
    r=pilot.command(args,cwd);assert r.returncode==0,r.stderr+r.stdout;return r

def protected(repo):
    return {str(p.relative_to(repo)):sha(p) for p in repo.rglob('*') if p.is_file() and (p.relative_to(repo).parts[0] in ('tests','test','.handwork') or p.name in ('package.json','package-lock.json','README.md'))}

def prepare_legacy(base,task):
    private=base/'private'/task;private.mkdir(parents=True)
    fixture=private/'fixture'
    if task=='pagination':
        (fixture/'src').mkdir(parents=True);(fixture/'test').mkdir()
        (fixture/'src/pagination.ts').write_text(pilot.SOURCE);(fixture/'test/pagination.test.ts').write_text(pilot.EXISTING)
        (private/'verify.mjs').write_text(pilot.VERIFY)
        prompt=pilot.PROMPT;testdir='test'
    else:
        source=ROOT/'benchmarks'/('async-search' if task=='search' else 'tenant-cache')/'fixture'
        shutil.copytree(source,fixture,ignore=shutil.ignore_patterns('.git','node_modules'))
        verifier=ROOT/'benchmarks/async-search/verify.mjs' if task=='search' else ROOT/'benchmarks/tool-batching/verify-tenant.mjs'
        shutil.copy2(verifier,private/'verify.mjs')
        prompt=search.PROMPT if task=='search' else json.loads((ROOT/'benchmarks/tenant-cache/results/state.json').read_text())['prompt'];testdir='tests'
    (fixture/'.handwork').mkdir(exist_ok=True)
    pilot.write_json(fixture/'.handwork/settings.json',{'provider':'codex','models':{'codex':pilot.MODEL},'effort':'low','fast_mode':False})
    if not (fixture/'package.json').exists():pilot.write_json(fixture/'package.json',{'private':True,'type':'module','scripts':{'test':f'node --test {testdir}/*.test.ts'}})
    if task=='search':(fixture/'README.md').write_text('# Search application\nNode 24 runs TypeScript directly. Run npm test; no dependencies.\nsrc/api/search.ts adapts HTTP; src/search/controller.ts owns state; src/ui/search-view.ts renders it.\n')
    for cmd in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Broken fixture']]:must(cmd,fixture)
    s={'base':str(base),'private':str(base/'private'),'fixture':str(fixture),'commit':must(['git','rev-parse','HEAD'],fixture).stdout.strip(),'task':task,'prompt':prompt,'verifier':str(private/'verify.mjs')}
    return s

def verify(s,repo):return [pilot.NODE,s['verifier'],str(repo/'src/pagination.ts') if s['task']=='pagination' else str(repo)]

def controls_legacy(s,out):
    fixture=Path(s['fixture']);broken=must(['npm','test'],fixture)
    r=pilot.command(verify(s,fixture),fixture);assert r.returncode!=0,'Verifier must reject broken fixture'
    result={'broken':json.loads(r.stdout)}
    if s['task']=='pagination':
        p=fixture/'src/pagination.ts';p.write_text(p.read_text().replace('start + pageSize - 1','start + pageSize'))
    elif s['task']=='search':
        p=fixture/'src/search/controller.ts';p.write_text(search.good_source(p.read_text()))
    else:
        must(['git','apply',ROOT/'benchmarks/tenant-cache/results/1-1-handwork.diff'],fixture)
    r=must(verify(s,fixture),fixture);result['known_correct']=json.loads(r.stdout)
    must(['git','reset','--hard',s['commit']],fixture)
    # The known-correct control may include an added regression test.
    must(['git','clean','-fd'],fixture)
    pilot.write_json(out/(s['task']+'-controls.json'),result)

from tasks import TASKS, COMMON, PREAMBLE, TAIL

def prepare(base,task):
    if task not in TASKS:return prepare_legacy(base,task)
    definition=TASKS[task];private=base/'private'/task;fixture=private/'fixture';fixture.mkdir(parents=True)
    for name,body in definition['files'].items():
        target=fixture/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(body)
    (fixture/'README.md').write_text('# Behavioral contract\n\n'+definition['description']+'\n\nRun npm test. No dependencies.\n')
    pilot.write_json(fixture/'package.json',{'private':True,'type':'module','scripts':{'test':'node --test tests/*.test.js'}})
    (fixture/'.handwork').mkdir()
    pilot.write_json(fixture/'.handwork/settings.json',{'provider':'codex','models':{'codex':pilot.MODEL},'effort':'low','fast_mode':False})
    (private/'verify.mjs').write_text(PREAMBLE+definition['verify']+TAIL)
    for cmd in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Frozen held-out fixture']]:must(cmd,fixture)
    return {'base':str(base),'private':str(base/'private'),'fixture':str(fixture),'commit':must(['git','rev-parse','HEAD'],fixture).stdout.strip(),'task':task,'prompt':COMMON,'verifier':str(private/'verify.mjs')}

def controls(s,out):
    if s['task'] not in TASKS:return controls_legacy(s,out)
    fixture=Path(s['fixture']);must(['npm','test'],fixture)
    r=pilot.command(verify(s,fixture),fixture);assert r.returncode!=0,'Verifier accepted broken fixture'
    result={'broken':json.loads(r.stdout)}
    for name,body in TASKS[s['task']]['gold'].items():(fixture/name).write_text(body)
    r=must(verify(s,fixture),fixture);result['known_correct']=json.loads(r.stdout);must(['npm','test'],fixture)
    must(['git','reset','--hard',s['commit']],fixture)
    pilot.write_json(out/(s['task']+'-controls.json'),result)


def isolation(s,folder):
    profile=pilot.sandbox(s,folder)
    for name in ['attachments','sessions','archived_sessions']:
        profile+='(deny file-read* file-write* (subpath '+json.dumps(str(Path.home()/'.codex'/name))+'))'
    for other in Path('/private/tmp').glob('handwork-*'):
        if other.resolve()!=Path(s['base']).resolve():profile+='(deny file-read* file-write* (subpath '+json.dumps(str(other))+'))'
    profile+='(deny network-inbound)(deny network-outbound (remote ip "localhost:*"))'
    repo=folder/'repo';link=repo/'verifier-link';link.symlink_to(s['verifier'])
    try:
        code='import sys\nfor p in sys.argv[1:]:\n try:open(p).read()\n except PermissionError:pass\n else:raise AssertionError("private file readable")'
        must(['/usr/bin/sandbox-exec','-p',profile,sys.executable,'-c',code,s['verifier'],str(link),str(ROOT/'src/builtins/tools.zig')],repo)
    finally:link.unlink()
    return profile

def summarize(records,out):
    summaries={}
    for task in sorted({r['task'] for r in records}):
        summaries[task]={}
        for variant in ('baseline','optimized'):
            rows=[r for r in records if r['task']==task and r['variant']==variant]
            if not rows:continue
            complete=[r for r in rows if r['success']]
            summaries[task][variant]={'attempts':len(rows),'successes':len(complete),
                **{'mean_'+k:statistics.mean(r[k] for r in rows) if all(r.get(k) is not None for r in rows) else None for k in ('tool_calls','input_tokens','output_tokens','model_requests')},
                'median_success_seconds':statistics.median(r['duration_s'] for r in complete) if complete else None,
                'median_peak_mib':statistics.median(r['peak_rss_bytes']['harness']/1048576 for r in rows)}
    pilot.write_json(out/'summary.json',summaries)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--baseline',required=True,type=Path);ap.add_argument('--optimized',required=True,type=Path);ap.add_argument('--out',required=True,type=Path);ap.add_argument('--attempts',type=int,default=2);ap.add_argument('--tasks',nargs='+',choices=['pagination','search','tenant-cache',*TASKS],default=['pagination','search','tenant-cache',*TASKS]);args=ap.parse_args()
    out=args.out.resolve();assert not out.exists(),'Preserve scored results';out.mkdir(parents=True)
    base=Path(tempfile.mkdtemp(prefix='handwork-efficiency-',dir='/private/tmp'));(base/'bin').mkdir();(base/'forbidden').mkdir();(base/'forbidden/probe.txt').write_text('private')
    variants={}
    for variant,source in [('baseline',args.baseline),('optimized',args.optimized)]:
        dest=base/'bin'/variant;shutil.copy2(source,dest);variants[variant]={'path':str(dest),'sha256':sha(dest)}
    tasks=[prepare(base,task) for task in args.tasks]
    for s in tasks:
        controls(s,out)
        s['verifier_sha256']=sha(Path(s['verifier']))
        s['fixture_hashes']={str(p.relative_to(s['fixture'])):sha(p) for p in Path(s['fixture']).rglob('*') if p.is_file() and '.git' not in p.parts}
    state={'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'base':str(base),'variants':variants,'tasks':tasks,'model':pilot.MODEL,'effort':'low','attempts':args.attempts,'build':'ReleaseFast','split':{'development':['pagination','search','tenant-cache'],'held_out':list(TASKS)},'fixture_source_sha256':sha(Path(__file__).with_name('tasks.py')),'git_head':must(['git','rev-parse','HEAD'],ROOT).stdout.strip()}
    pilot.write_json(out/'state.json',state);shutil.copy2(__file__,out/'runner.py');shutil.copy2(Path(__file__).with_name('tasks.py'),out/'tasks.py');pilot.OUT=out
    records=[]
    for attempt in range(1,args.attempts+1):
        for task_index,s in enumerate(tasks):
            order=['baseline','optimized'] if (attempt+task_index)%2 else ['optimized','baseline']
            for variant in order:
                name=f'{s["task"]}-{attempt}-{variant}';folder,repo=pilot.workspace(s,name);profile=isolation(s,folder);(out/(name+'.sandbox.sb')).write_text(profile);before=protected(repo)
                env=pilot.env_for('handwork',folder);env.update(HANDWORK_TRACE_STDERR='1',HANDWORK_TRACE_SCOPES='agent')
                print('START '+name,flush=True)
                with pilot.handwork_auth():r=pilot.measured(pilot.args_for('handwork',dict(s,handwork=variants[variant]['path']),s['prompt']),repo,env,out/name,600,profile)
                r.update(pilot.parse('handwork',out/name));trace=(out/(name+'.stderr')).read_text();r['model_requests']=trace.count('event=provider_admitted ')
                batches=[int(x) for x in re.findall(r'event=read_batch_complete file_read_operations=(\d+)',trace)]
                r['request_composition']=[dict((k,int(v)) for k,v in re.findall(r'(\w+)=(\d+)',line) if k not in ('turn_id','step_id','subagent_id')) for line in trace.splitlines() if 'event=request_composition ' in line];r['duplicate_saved_bytes']=sum(int(v) for v in re.findall(r'event=duplicate_results_projected[^\n]*saved_bytes=(\d+)',trace));r['recovery_hints']=trace.count('event=repeated_failure_hint');r['split']='held_out' if s['task'] in TASKS else 'development';r['read_batches']=len(batches);r['native_operations_excluding_shell_contents']=r['tool_calls']-len(batches)+sum(batches)
                r.update(task=s['task'],variant=variant,attempt=attempt,workspace=str(repo),log=name)
                (out/(name+'.diff')).write_text(must(['git','diff','--binary'],repo).stdout)
                after=protected(repo)
                r['protected_files_unchanged']=all(after.get(k)==v for k,v in before.items()) if s['task']=='tenant-cache' else after==before
                r['no_dependencies']=not (repo/'node_modules').exists()
                checked=pilot.measured(verify(s,repo),repo,os.environ.copy(),out/(name+'.verify'),30)
                existing=pilot.measured(['npm','test'],repo,os.environ.copy(),out/(name+'.existing'),30)
                r['checks']=json.loads((out/(name+'.verify.stdout')).read_text());r['existing_tests_pass']=existing['exit_code']==0
                r['success']=bool(r['completed'] and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['no_dependencies'] and checked['exit_code']==0 and r['existing_tests_pass'] and all(c['pass'] for c in r['checks']))
                for item in repo.rglob('*'):
                    if not item.is_symlink() and item.is_file() and item.relative_to(repo).parts[0] in ('src','tests','test') and item.stat().st_size<1048576:
                        dest=out/(name+'.workspace')/item.relative_to(repo);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(item,dest)
                records.append(r);pilot.write_json(out/'attempts.json',records);summarize(records,out)
                print('DONE '+json.dumps({k:r[k] for k in ['task','variant','attempt','success','tool_calls','model_requests','input_tokens','output_tokens','duration_s']}),flush=True)
                if r.get('input_tokens') is None:raise RuntimeError('Provider preflight failed; stop without repeating unusable measurements')
    from report import generate
    generate(out)
    print('COMPLETE '+str(out),flush=True)
if __name__=='__main__':main()
