"""Audit saved attempts and accounting without rerunning agents."""
import hashlib,importlib.util,json,subprocess,sqlite3
from pathlib import Path
HERE=Path(__file__).resolve().parent;OUT=HERE/'results'
spec=importlib.util.spec_from_file_location('tenant_runner',HERE/'benchmark.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b);b.configure()
s=b.pilot.state();records=json.loads((OUT/'attempts.json').read_text())
assert len(records)==15
for h,x in s['binaries'].items():assert hashlib.sha256(Path(x['path']).read_bytes()).hexdigest()==x['sha256']
for r in records:
 log=OUT/r['log'];folder=Path(s['base'])/r['log'];parsed=b.parse(r['harness'],log,folder)
 for key in ['input_tokens','output_tokens','tool_calls','model_requests']:
  assert parsed[key]==r[key],(r['log'],key)
 assert r['starting_commit']==s['commit']
 if r['harness']=='handwork':assert r['reported_model']==s['model']
 if r['harness']=='opencode':
  with sqlite3.connect((folder/'xdg-data/opencode/opencode.db').resolve().as_uri()+'?mode=ro',uri=True) as conn:
   messages=[json.loads(x[0]) for x in conn.execute('select data from message')]
   assert all(m.get('modelID')==s['model'] for m in messages if m.get('role')=='assistant')
 if r['harness']=='codex':
  for f in (folder/'codex-home/sessions').rglob('*.jsonl'):
   for line in f.read_text().splitlines():
    e=json.loads(line)
    if e['type']=='turn_context':assert e['payload'].get('model')==s['model'] and e['payload'].get('effort')==s['reasoning']

 assert len(r['checks'])==15
 assert all(isinstance(r[k],int) and r[k]>=0 for k in ['input_tokens','output_tokens','tool_calls','model_requests'])
 assert r['success']==bool(r['completed'] and not r['timeout'] and r['exit_code']==0 and r['protected_files_unchanged'] and r['dependency_directory_absent'] and all(c['pass'] for c in r['checks']))
 assert not list(folder.rglob('auth.json'))
 repo=Path(r['workspace'])
 untracked=subprocess.check_output(['git','ls-files','--others','--exclude-standard','-z'],cwd=repo).split(b'\0')
 added=[]
 for raw in untracked:
  if not raw:continue
  name=raw.decode();p=repo/name
  if not p.is_symlink() and p.is_file() and p.resolve().is_relative_to(repo.resolve()) and p.stat().st_size<1024*1024:
   dest=OUT/(r['log']+'.added')/name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(p.read_bytes());added.append(name)
 (OUT/(r['log']+'.added-files.json')).write_text(json.dumps(added,indent=2))
print('All 15 accounting records reproduced; hashes match; credentials removed; added files retained.')
(OUT/'audit.json').write_text(json.dumps({'passed':True,'attempts':15,'binary_hashes_verified':True,'accounting_reproduced':True,'credentials_removed':True},indent=2))
