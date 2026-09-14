#!/usr/bin/env python3
"""Paired frozen/current Handwork runs; same fixture, model, sandbox and sampler."""
import hashlib,json,os,shutil,sys,tempfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]
sys.path.insert(0,str(ROOT/'benchmarks/async-search'))
import benchmark as search
pilot=search.pilot
OUT=HERE/(sys.argv[1] if len(sys.argv)>1 else 'results')

def main():
    assert not OUT.exists(), 'Keep scored optimization results immutable'
    OUT.mkdir()
    old=json.loads(search.STATE.read_text())
    base=Path(tempfile.mkdtemp(prefix='handwork-efficiency-',dir='/private/tmp'))
    private=base/'private';private.mkdir()
    shutil.copytree(old['fixture'],private/'fixture')
    shutil.copy2(Path(old['private'])/'verify.mjs',private/'verify.mjs')
    (base/'forbidden').mkdir();(base/'forbidden/probe.txt').write_text('not accessible')
    (base/'bin').mkdir()
    for name,source in [('baseline',old['handwork']),('optimized',ROOT/'zig-out/bin/handwork')]:
        shutil.copy2(source,base/'bin'/name)
    s=dict(old,base=str(base),private=str(private),fixture=str(private/'fixture'),created=time.strftime('%Y-%m-%dT%H:%M:%S%z'),orders=[(['baseline','optimized'] if a%2 else ['optimized','baseline']) for a in range(1,6)])
    s['variants']={v:{'path':str(base/'bin'/v),'sha256':hashlib.sha256((base/'bin'/v).read_bytes()).hexdigest()} for v in ['baseline','optimized']}
    pilot.OUT=OUT;pilot.STATE=OUT/'state.json';pilot.write_json(pilot.STATE,s)
    shutil.copy2(__file__,OUT/'runner-snapshot.py')
    for source in ['src/builtins/system_prompt.md','src/builtins/tools.zig','src/tools/filesystem/edit_file.zig','src/core/tooling/file_mutation.zig','src/core/tooling/file_mutation_contract.zig','src/core/cli/cli_ask.zig','src/core/agent/runtime/parallel_execution.zig']:
        dest=OUT/'source'/source;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/source,dest)
    # Require report server shutdown so hidden checks cannot be fetched by HTTP.
    import socket
    with socket.socket() as probe:assert probe.connect_ex(('127.0.0.1',8765))!=0,'Stop the report server before scoring'
    records=[]
    for attempt in range(1,6):
        order=['baseline','optimized'] if attempt%2 else ['optimized','baseline']
        for position,variant in enumerate(order,1):
            name=f'{attempt}-{position}-{variant}'
            runstate=dict(s,handwork=s['variants'][variant]['path'])
            folder,repo=pilot.workspace(runstate,name)
            profile=search.isolation(runstate,folder,repo)
            (OUT/(name+'.sandbox.sb')).write_text(profile)
            protected=search.fingerprint(repo);log=OUT/name
            print('START '+name,flush=True)
            try:
                with pilot.handwork_auth():
                    r=pilot.measured(pilot.args_for('handwork',runstate,search.PROMPT),repo,pilot.env_for('handwork',folder),log,300,profile)
                r.update(pilot.parse('handwork',log));r.update(variant=variant,attempt=attempt,position=position,workspace=str(repo),log=name,starting_commit=s['commit'])
                (OUT/(name+'.diff')).write_text(pilot.command(['git','diff','--binary',s['commit']],repo).stdout)
                r['protected_files_unchanged']=search.fingerprint(repo)==protected and not (repo/'node_modules').exists()
                r['verification']=pilot.measured([pilot.NODE,private/'verify.mjs',repo],repo,os.environ.copy(),OUT/(name+'.verify'),30)
                r['existing_tests']=pilot.measured(['npm','test'],repo,os.environ.copy(),OUT/(name+'.existing'),30)
                try:r['checks']=json.loads((OUT/(name+'.verify.stdout')).read_text())
                except ValueError:r['checks']=[]
                r['success']=bool(r['completed'] and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['verification']['exit_code']==0 and r['existing_tests']['exit_code']==0 and len(r['checks'])==9 and all(x['pass'] for x in r['checks']))
                records.append(r);pilot.write_json(OUT/'attempts.json',records)
                print('DONE '+json.dumps({k:r[k] for k in ['variant','attempt','success','duration_s','input_tokens','output_tokens','tool_calls','peak_rss_bytes']}),flush=True)
            finally:pilot.cleanup_auth(folder)
    print('PAIRED RUNS COMPLETE',flush=True)

if __name__=='__main__':main()
