"""Reproduce unrelated broad-suite failures against pre-change and current source."""
import json,os,re,shutil,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'benchmarks/optimization/results'
backup=Path('/private/tmp/handwork-optimization-originals')
base=Path(tempfile.mkdtemp(prefix='handwork original tests ',dir='/private/tmp'))
shutil.copytree(ROOT/'src',base/'src')
for p in (backup/'src').rglob('*'):
 if p.is_file():shutil.copy2(p,base/p.relative_to(backup))
failures=re.findall(r"^error: '([^']+)' failed",(OUT/'early-full-suite.log').read_text(),re.M)
# Prompt and schema snapshots were deliberately updated and covered separately.
failures=[x for x in failures if not x.startswith(('builtins.context.','builtins.tools.'))]
zig='/private/tmp/zig-aarch64-macos-0.16.0/zig'
options=ROOT/'.zig-cache/c/baf6a720d1c11e7fa013d0c4446241f1/options.zig'
results={}
for name,src in [('original',base/'src/main.zig'),('current',ROOT/'src/main.zig')]:
 cmd=[zig,'test','-OReleaseFast','--dep','build_options','-Mroot='+str(src),'-Mbuild_options='+str(options),'-lc']
 for f in failures:cmd+=['--test-filter',f.split('.test.',1)[-1]]
 with (OUT/(name+'-unrelated-tests.log')).open('w') as log:
  r=subprocess.run(cmd,cwd=ROOT,stdout=log,stderr=log)
 text=(OUT/(name+'-unrelated-tests.log')).read_text()
 bad=[title for title,body in re.findall(r'^\d+/\d+ (.*?)\.\.\.(.*?)(?=^\d+/|\Z)',text,re.M|re.S) if 'FAIL (' in body]
 results[name]={'exit_code':r.returncode,'failures':bad,'summary':text.splitlines()[-3:]}
 print(name,results[name],flush=True)
(OUT/'unrelated-test-audit.json').write_text(json.dumps(results,indent=2))
