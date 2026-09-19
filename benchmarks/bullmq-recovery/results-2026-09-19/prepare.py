import json,os,shutil,subprocess,sys,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; HERE=Path(__file__).resolve().parent
base=Path(sys.argv[1]);upstream=base/'upstream';fixture=base/'private'/'fixture';fixture.parent.mkdir()
shutil.copytree(upstream,fixture,ignore=shutil.ignore_patterns('.git','node_modules','dist','rawScripts'))
shutil.copytree(upstream/'node_modules',fixture/'node_modules',symlinks=True)
shutil.rmtree(fixture/'src/scripts',ignore_errors=True)
changes=[('src/commands/includes/removeLock.lua','if lockToken == token then','if lockToken then'),('src/commands/extendLock-2.lua','if rcall("GET", KEYS[1]) == ARGV[1] then','if rcall("EXISTS", KEYS[1]) == 1 then'),('src/commands/extendLocks-1.lua','if currentToken == token then','if currentToken then')]
for name,old,new in changes:
 p=fixture/name;s=p.read_text();assert s.count(old)==1;s=s.replace(old,new);p.write_text(s)
for file in ['actor.cjs','verify.cjs']:shutil.copy2(HERE/file,base/'private'/file)
env=dict(os.environ);env['PATH']='/Users/connorlove/.vite-plus/js_runtime/node/24.21.0/bin:'+env['PATH']
with open(HERE/'build-broken.log','w') as f:subprocess.run(['npm','run','build'],cwd=fixture,env=env,stdout=f,stderr=subprocess.STDOUT,check=True)
for cmd in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Benchmark','-c','user.email=benchmark@localhost','commit','-qm','Repository snapshot']]:subprocess.run(cmd,cwd=fixture,check=True)
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=fixture,text=True).strip()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
state={'base':str(base),'fixture':str(fixture),'commit':commit,'upstream_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=upstream,text=True).strip(),'upstream':'https://github.com/taskforcesh/bullmq','version':json.loads((fixture/'package.json').read_text())['version'],'mutation_files':[x[0] for x in changes],'verifier_sha256':sha(HERE/'verify.cjs'),'actor_sha256':sha(HERE/'actor.cjs'),'seed_source_sha256':{name:sha(fixture/name) for name,*_ in changes}}
(HERE/'fixture.json').write_text(json.dumps(state,indent=2)+'\n');print(json.dumps(state),flush=True)
port=json.loads((base/'redis.json').read_text())['port']
with open(HERE/'control-broken.json','w') as out,open(HERE/'control-broken.stderr','w') as err:r=subprocess.run(['/Users/connorlove/.vite-plus/js_runtime/node/24.21.0/bin/node',str(base/'private/verify.cjs'),str(fixture),str(port)],stdout=out,stderr=err)
assert r.returncode==1
checks=json.loads((HERE/'control-broken.json').read_text());assert sum(not c['pass'] for c in checks)>=6
print('BROKEN CONTROL',sum(c['pass'] for c in checks),'/',len(checks),flush=True)
