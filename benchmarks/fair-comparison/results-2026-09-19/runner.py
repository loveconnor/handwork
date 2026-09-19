#!/usr/bin/env python3
"""Five fresh attempts per task and agent; preserve every scored outcome."""
import contextlib, importlib.util, json, os, platform, shutil, statistics, sys, tempfile, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'benchmarks/harness-efficiency'))
import run as fixtures
pilot=fixtures.pilot
spec=importlib.util.spec_from_file_location('tenant_accounting',ROOT/'benchmarks/tenant-cache/benchmark.py')
accounting=importlib.util.module_from_spec(spec);spec.loader.exec_module(accounting)
AGENTS=['handwork','opencode','codex']
ORDERS=[AGENTS,['opencode','codex','handwork'],['codex','handwork','opencode'],['handwork','codex','opencode'],['opencode','handwork','codex']]

def summarize(records,out):
    summary={}
    for task in ['pagination','search','tenant-cache']:
        summary[task]={}
        for agent in AGENTS:
            rows=[r for r in records if r['task']==task and r['harness']==agent]
            if not rows:continue
            passed=[r for r in rows if r['success']]
            summary[task][agent]={'attempts':len(rows),'successes':len(passed),'median_success_seconds':statistics.median(r['duration_s'] for r in passed) if passed else None,'median_peak_mib':statistics.median(r['peak_rss_bytes']['harness']/1048576 for r in rows),**{'mean_'+k:statistics.mean(r[k] for r in rows) if all(r.get(k) is not None for r in rows) else None for k in ['input_tokens','output_tokens','tool_calls','model_requests']}}
    pilot.write_json(out/'summary.json',summary)

def main():
    out=Path(sys.argv[1]).resolve();assert not out.exists(),'Never overwrite results';out.mkdir(parents=True)
    base=Path(tempfile.mkdtemp(prefix='handwork-fair-',dir='/private/tmp'));(base/'bin').mkdir();(base/'forbidden').mkdir();(base/'forbidden/probe.txt').write_text('private')
    binaries={}
    for h,p in [('handwork',ROOT/'zig-out/bin/handwork'),('opencode',Path(pilot.OPENCODE)),('codex',Path(pilot.CODEX))]:
        dest=base/'bin'/h;shutil.copy2(p,dest);binaries[h]={'path':str(dest),'original':str(p),'sha256':fixtures.sha(dest)}
    pilot.CODEX=binaries['codex']['path'];pilot.OPENCODE=binaries['opencode']['path'];pilot.OUT=out;pilot.STATE=out/'state.json'
    tasks=[fixtures.prepare(base,t) for t in ['pagination','search','tenant-cache']]
    for s in tasks:fixtures.controls(s,out)
    state={'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'base':str(base),'binaries':binaries,'model':pilot.MODEL,'effort':'low','context':pilot.CONTEXT,'attempts_per_agent_task':5,'budget_seconds':600,'orders':ORDERS,'tasks':tasks,'machine':platform.platform(),'node':pilot.command([pilot.NODE,'--version']).stdout.strip(),'profile_note':'Existing Handwork personal context; Codex ignores user rules; OpenCode pure mode. This is not a pristine common prompt profile.'}
    pilot.write_json(pilot.STATE,state)
    for name,p in [('runner.py',Path(__file__)),('fixtures.py',Path(fixtures.__file__)),('pilot.py',Path(pilot.__file__)),('accounting.py',Path(accounting.__file__))]:shutil.copy2(p,out/name)
    pilot.write_json(out/'fixture-hashes.json',{s['task']:{'files':{str(p.relative_to(Path(s['fixture']))):fixtures.sha(p) for p in Path(s['fixture']).rglob('*') if p.is_file() and '.git' not in p.parts},'verifier':fixtures.sha(Path(s['verifier']))} for s in tasks})
    probes=[]
    for h in AGENTS:
        s=dict(tasks[0],handwork=binaries['handwork']['path']);name='preflight-'+h;folder,repo=pilot.workspace(s,name);(repo/'probe.txt').write_text('before\n')
        env=accounting.environment(h,folder);profile=fixtures.isolation(s,folder)
        prompt='Read probe.txt, change its only line from before to after, then run: test "$(cat probe.txt)" = after && printf "PROBE_OK\\n". Use normal tools. Do not install dependencies. Summarize verification.'
        print('PREFLIGHT '+h,flush=True)
        try:
            with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(accounting.args(h,s,prompt),repo,env,out/name,180,profile)
            r.update(accounting.parse(h,out/name,folder));r['harness']=h;r['pass']=bool(r['completed'] and r['exit_code']==0 and (repo/'probe.txt').read_text()=='after\n' and pilot.native_probe_succeeded(h,out/name) and r.get('input_tokens'))
            probes.append(r);pilot.write_json(out/'preflight.json',probes);print('PROBE '+json.dumps({'agent':h,'pass':r['pass'],'seconds':r['duration_s']}),flush=True)
            assert r['pass'],h+' native preflight failed'
            if h=='opencode':
                seed=base/'preinstalled';seed.mkdir()
                for target,origin in [('config','xdg-config'),('cache','xdg-cache')]:shutil.copytree(folder/origin,seed/target)
                state['profile_seed']=str(seed);pilot.write_json(pilot.STATE,state)
        finally:pilot.cleanup_auth(folder)
    records=[]
    for attempt,order in enumerate(ORDERS,1):
        for task_index,s0 in enumerate(tasks):
            s=dict(s0,handwork=binaries['handwork']['path'])
            rotated=order[task_index:]+order[:task_index]
            for position,h in enumerate(rotated,1):
                name=f'{s["task"]}-{attempt}-{h}';folder,repo=pilot.workspace(s,name);env=accounting.environment(h,folder);profile=fixtures.isolation(s,folder);before=fixtures.protected(repo)
                (out/(name+'.sandbox.sb')).write_text(profile)
                assert all(fixtures.sha(Path(b['path']))==b['sha256'] for b in binaries.values())
                print('START '+name,flush=True)
                try:
                    with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():r=pilot.measured(accounting.args(h,s,s['prompt']),repo,env,out/name,600,profile)
                    try:r.update(accounting.parse(h,out/name,folder))
                    except Exception as e:r.update(completed=False,input_tokens=None,output_tokens=None,tool_calls=None,model_requests=None,accounting_error=str(e))
                    r.update(task=s['task'],harness=h,attempt=attempt,position=position,workspace=str(repo),log=name)
                    (out/(name+'.diff')).write_text(fixtures.must(['git','diff','--binary'],repo).stdout)
                    after=fixtures.protected(repo);r['protected_files_unchanged']=all(after.get(k)==v for k,v in before.items()) if s['task']=='tenant-cache' else after==before
                    r['no_dependencies']=not (repo/'node_modules').exists()
                    checked=pilot.measured(fixtures.verify(s,repo),repo,os.environ.copy(),out/(name+'.verify'),30)
                    existing=pilot.measured(['npm','test'],repo,os.environ.copy(),out/(name+'.existing'),60)
                    try:r['checks']=json.loads((out/(name+'.verify.stdout')).read_text())
                    except ValueError:r['checks']=[]
                    r['existing_tests_pass']=existing['exit_code']==0
                    r['success']=bool(r.get('completed') and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['no_dependencies'] and checked['exit_code']==0 and r['existing_tests_pass'] and r['checks'] and all(c['pass'] for c in r['checks']))
                    records.append(r);pilot.write_json(out/'attempts.json',records);summarize(records,out)
                    print('DONE '+json.dumps({k:r.get(k) for k in ['task','harness','attempt','success','duration_s','input_tokens','output_tokens','tool_calls']}),flush=True)
                finally:pilot.cleanup_auth(folder)
    print('COMPLETE '+str(out),flush=True)
if __name__=='__main__':main()
