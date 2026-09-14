#!/usr/bin/env python3
"""Fifteen serial async-search attempts using the corrected pagination instrumentation."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT/'benchmarks/fixed-budget'))
import pilot

OUT = HERE/'results'
STATE = OUT/'state.json'
BASELINE = ROOT/'benchmarks/fixed-budget/results/corrected/report-data.json'
PROMPT = '''Fix the reported bug in this repository.

Bug report:
When a user changes their search quickly, results sometimes
revert to an earlier query. An earlier request can also clear
the loading indicator or display an error while the current
request is still running.

Required behavior:
- Only the latest search may update results, loading, or errors.
- Clearing the query must immediately clear results and errors
  and stop the loading indicator.
- Requests that finish after the query is cleared must not
  repopulate the results.
- Preserve the existing public API and normal search behavior.

Inspect the relevant code, make the smallest appropriate change,
and run the existing tests. Do not modify tests or install
dependencies. Summarize your changes and verification.'''
ORDERS = [
    ['handwork','opencode','codex'],
    ['opencode','codex','handwork'],
    ['codex','handwork','opencode'],
    ['handwork','codex','opencode'],
    ['opencode','handwork','codex'],
]

def configure():
    pilot.STATE=STATE
    pilot.OUT=OUT

def good_source(source, query_only=False):
    if query_only:
        source=source.replace('        update({ results });','        if (normalized !== state.query) return;\n        update({ results });')
        source=source.replace('      } catch (error) {','      } catch (error) {\n        if (normalized !== state.query) return;')
        return source.replace('        update({ loading: false });','        if (normalized === state.query) update({ loading: false });')
    source=source.replace('  const listeners =', '  let requestVersion = 0;\n  const listeners =')
    source=source.replace('    async search(query) {', '    async search(query) {\n      const version = ++requestVersion;')
    source=source.replace('        update({ results });','        if (version !== requestVersion) return;\n        update({ results });')
    source=source.replace('      } catch (error) {','      } catch (error) {\n        if (version !== requestVersion) return;')
    return source.replace('        update({ loading: false });','        if (version === requestVersion) update({ loading: false });')

def must(args, cwd):
    r=pilot.command(args,cwd)
    assert r.returncode==0,r.stderr+r.stdout
    return r

def prepare():
    assert not STATE.exists(),'Preserve existing benchmark state'
    baseline=json.loads(BASELINE.read_text())
    OUT.mkdir(exist_ok=True)
    base=Path(tempfile.mkdtemp(prefix='handwork-search-benchmark-',dir='/private/tmp'))
    private=base/'private';private.mkdir(mode=0o700)
    fixture=private/'fixture';shutil.copytree(HERE/'fixture',fixture)
    (private/'verify.mjs').write_bytes((HERE/'verify.mjs').read_bytes())
    (fixture/'.handwork').mkdir()
    pilot.write_json(fixture/'.handwork/settings.json',{'provider':'codex','models':{'codex':pilot.MODEL},'effort':'low','fast_mode':False})
    pilot.write_json(fixture/'package.json',{'name':'async-search-benchmark','private':True,'type':'module','scripts':{'test':'node --test tests/*.test.ts'},'engines':{'node':'>=24'}})
    (fixture/'README.md').write_text('# Search application\n\nNode 24 runs this TypeScript directly. Run `npm test`; no third-party dependencies.\n\n`src/api/search.ts` adapts HTTP requests, `src/search/controller.ts` owns query and state, and `src/ui/search-view.ts` connects an input to the controller and renders state.\n\nThe controller exposes getState, subscribe (immediately emits a snapshot), and async search. Search trims surrounding whitespace and preserves existing results while the next search loads. Empty input clears the view without an HTTP request.\n')
    (fixture/'.gitignore').write_text('node_modules/\n')
    must(['npm','install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund'],fixture)
    for cmd in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Search application with out-of-order request bug']]:must(cmd,fixture)
    commit=must(['git','rev-parse','HEAD'],fixture).stdout.strip()
    source=fixture/'src/search/controller.ts';broken=source.read_text();controls={}
    for name,content in [('broken',broken),('known_correct',good_source(broken)),('query_string_only',good_source(broken,True))]:
        source.write_text(content)
        result=pilot.command([pilot.NODE,private/'verify.mjs',fixture],fixture)
        tests=pilot.command(['npm','test'],fixture)
        (OUT/(name+'.verifier.stdout')).write_text(result.stdout)
        (OUT/(name+'.existing.stdout')).write_text(tests.stdout+tests.stderr)
        controls[name]={'exit_code':result.returncode,'checks':json.loads(result.stdout),'existing_tests_pass':tests.returncode==0}
        assert tests.returncode==0,tests.stdout+tests.stderr
    assert controls['broken']['exit_code']==1
    assert any(not c['pass'] for c in controls['broken']['checks'])
    assert controls['known_correct']['exit_code']==0 and all(c['pass'] for c in controls['known_correct']['checks'])
    aba=next(c for c in controls['query_string_only']['checks'] if c['name']=='Query changes A → B → A')
    assert not aba['pass'],'Verifier must catch query-string-only guards'
    (private/'known-correct-controller.ts').write_text(good_source(broken))
    must(['git','reset','--hard',commit],fixture)
    assert source.read_text()==broken
    bins=base/'bin';bins.mkdir();shutil.copy2(baseline['state']['handwork'],bins/'handwork')
    seed=base/'preinstalled';shutil.copytree(baseline['state']['profile_seed'],seed)
    (base/'forbidden').mkdir();(base/'forbidden/probe.txt').write_text('inaccessible')
    hashes={}
    for h,exe in [('handwork',bins/'handwork'),('opencode',Path(pilot.OPENCODE)),('codex',Path(pilot.CODEX))]:
        hashes[h]=hashlib.sha256(exe.read_bytes()).hexdigest()
        assert hashes[h]==baseline['installation'][h]['components'][0]['sha256'],f'{h} changed since pagination benchmark'
    state={'base':str(base),'private':str(private),'fixture':str(fixture),'commit':commit,'handwork':str(bins/'handwork'),'profile_seed':str(seed),
        'model':pilot.MODEL,'reasoning':'low','context':pilot.CONTEXT,'prompt':PROMPT,'prompt_sha256':hashlib.sha256(PROMPT.encode()).hexdigest(),
        'created':time.strftime('%Y-%m-%dT%H:%M:%S%z'),'machine':baseline['state']['machine'],'binary_sha256':hashes,'orders':ORDERS,
        'attempts_per_harness':5,'time_limit_seconds':300,'controls':controls}
    pilot.write_json(STATE,state);pilot.write_json(OUT/'verifier-controls.json',controls)
    (OUT/'prompt.txt').write_text(PROMPT)
    for p in [Path(__file__),HERE/'verify.mjs',Path(pilot.__file__)]:shutil.copy2(p,OUT/(p.stem+'-snapshot'+p.suffix))
    print(json.dumps({'commit':commit,'controls':{k:[c['pass'] for c in v['checks']] for k,v in controls.items()},'binary_hashes_match_pagination':True}),flush=True)

def args(h,s,prompt):
    argv=pilot.args_for(h,s,prompt)
    if h=='opencode':argv[argv.index('--title')+1]='Async search benchmark'
    return argv

def isolation(s,folder,repo):
    profile=pilot.sandbox(s,folder)
    hidden=str(Path(s['private'])/'verify.mjs');sibling=str(Path(s['base'])/'forbidden/probe.txt')
    link=repo/'verifier-link';link.symlink_to(hidden)
    probe='''import os,sys
root,hidden,sibling=sys.argv[1:]
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for part in root.strip('/').split('/'):
 n=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n
os.close(fd)
for target in [hidden,sibling,root+'/verifier-link']:
 for mode in ['r','w']:
  try:open(target,mode)
  except PermissionError:pass
  else:raise AssertionError('Protected path accessible')
print('TRAVERSAL_AND_ISOLATION_OK')
'''
    try:
        r=pilot.command(['/usr/bin/sandbox-exec','-p',profile,sys.executable,'-c',probe,str(repo),hidden,sibling],repo)
        assert r.returncode==0,r.stderr
        return profile
    finally:link.unlink()

def preflight():
    s=pilot.state();results=[]
    for h in ['handwork','opencode','codex']:
        folder=Path(s['base'])/('preflight-'+h);repo=folder/'repo';repo.mkdir(parents=True)
        (repo/'probe.txt').write_text('before\n');must(['git','init','-q'],repo)
        env=pilot.env_for(h,folder);profile=isolation(s,folder,repo);log=OUT/('preflight-'+h)
        prompt="Use your normal tools to read probe.txt and change its only line from before to after. Then use your shell tool to run: test \"$(cat probe.txt)\" = after && printf 'PROBE_OK\\n'. Do not modify any other files or install dependencies. Summarize the verification."
        try:
            with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():
                r=pilot.measured(args(h,s,prompt),repo,env,log,90,profile)
            r.update(pilot.parse(h,log));r['harness']=h
            r['tool_probe_pass']=r['completed'] and (repo/'probe.txt').read_text()=='after\n' and pilot.native_probe_succeeded(h,log)
            r['isolation']='ancestor traversal allowed; verifier/sibling/symlink read and write denied'
            results.append(r);pilot.write_json(OUT/'preflight.json',results)
            print('PREFLIGHT '+json.dumps(r),flush=True)
            assert r['tool_probe_pass'],f'{h} preflight failed'
        finally:pilot.cleanup_auth(folder)

def fingerprint(repo):
    # Protect directory additions/deletions as well as tracked file modifications.
    paths=list((repo/'tests').rglob('*'))+[repo/'package.json',repo/'package-lock.json',repo/'.handwork/settings.json']
    return {str(p.relative_to(repo)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.is_file()}

def run():
    s=pilot.state();assert not (OUT/'attempts.json').exists(),'Do not replace scored attempts'
    assert len(json.loads((OUT/'preflight.json').read_text()))==3
    assert all(r['tool_probe_pass'] for r in json.loads((OUT/'preflight.json').read_text()))
    records=[]
    for attempt,order in enumerate(ORDERS,1):
        for position,h in enumerate(order,1):
            name=f'{attempt}-{position}-{h}';folder,repo=pilot.workspace(s,name)
            env=pilot.env_for(h,folder);profile=isolation(s,folder,repo)
            protected=fingerprint(repo);log=OUT/name
            (OUT/(name+'.sandbox.sb')).write_text(profile)
            print('START '+name,flush=True)
            try:
                started=time.strftime('%Y-%m-%dT%H:%M:%S%z')
                with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():
                    r=pilot.measured(args(h,s,PROMPT),repo,env,log,300,profile)
                r.update(pilot.parse(h,log));r.update(harness=h,attempt=attempt,position=position,started_at=started,starting_commit=s['commit'],workspace=str(repo),log=name)
                (OUT/(name+'.diff')).write_text(pilot.command(['git','diff','--binary',s['commit']],repo).stdout)
                r['protected_files_unchanged']=fingerprint(repo)==protected
                r['dependency_directory_absent']=not (repo/'node_modules').exists()
                check=pilot.measured([pilot.NODE,Path(s['private'])/'verify.mjs',repo],repo,os.environ.copy(),OUT/(name+'.verify'),30)
                existing=pilot.measured(['npm','test'],repo,os.environ.copy(),OUT/(name+'.existing'),30)
                try:checks=json.loads((OUT/(name+'.verify.stdout')).read_text())
                except json.JSONDecodeError:checks=[]
                r.update(verification=check,existing_tests=existing,checks=checks)
                r['success']=bool(r['completed'] and not r['timeout'] and r['exit_code']==0 and check['exit_code']==0 and existing['exit_code']==0 and len(checks)==9 and all(c['pass'] for c in checks) and r['protected_files_unchanged'] and r['dependency_directory_absent'])
                records.append(r);pilot.write_json(OUT/'attempts.json',records)
                print('DONE '+json.dumps({k:r[k] for k in ['harness','attempt','success','duration_s','peak_rss_bytes','input_tokens','output_tokens','tool_calls','timeout']}),flush=True)
            finally:pilot.cleanup_auth(folder)
    print('SEARCH BENCHMARK COMPLETE',flush=True)

if __name__=='__main__':
    configure()
    action=sys.argv[1]
    if action=='all':prepare();preflight();run()
    else:{'prepare':prepare,'preflight':preflight,'run':run}[action]()
