"""Offline capture; requires tiktoken. No inference. Usage numbers from mock are ignored."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import ThreadingHTTPServer
import tiktoken

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('fixture', ROOT/'tests/e2e/api-providers.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--binary',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
    binary=args.binary.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=False)
    server=ThreadingHTTPServer(('127.0.0.1',0),fixture.Handler);server.requests=[]
    threading.Thread(target=server.serve_forever,daemon=True).start()
    enc=tiktoken.get_encoding('o200k_base');rows=[]
    try:
        with tempfile.TemporaryDirectory(prefix='handwork-demand-count-') as home:
            workspace=Path(home)/'workspace';workspace.mkdir()
            env={'PATH':os.environ['PATH'],'HOME':home,'USER':'test','TERM':'dumb','OPENAI_API_KEY':'local-test-only','HANDWORK_OPENAI_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1'}
            for variant in ['eager','on_demand']:
                env['HANDWORK_ON_DEMAND_TOOLS']='1' if variant=='on_demand' else '0'
                for argv in [('login','openai'),('ask','--json','hello')]:
                    p=subprocess.run([str(binary),*argv],cwd=workspace,env=env,text=True,capture_output=True,timeout=30)
                    assert p.returncode==0,p.stderr
                body=server.requests[-1][2]
                (out/(variant+'-request.json')).write_text(json.dumps(body,indent=2))
                system=sum(len(enc.encode(m['content'])) for m in body['messages'] if m['role']=='system')
                tools=len(enc.encode(json.dumps(body['tools'],separators=(',',':'),ensure_ascii=False)))
                rows.append({'variant':variant,'system_tokens':system,'tool_definition_tokens':tools,'total_excluding_user':system+tools,'advertised_functions':[t['function']['name'] for t in body['tools']]})
    finally:
        server.shutdown();server.server_close()
    result={'encoding':'o200k_base','method':'Local tokenization of captured system text and compact tool JSON; not provider usage; excludes user message and provider framing. Same isolated profile and empty workspace.','binary_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'results':rows,'reduction_percent':round((1-rows[1]['total_excluding_user']/rows[0]['total_excluding_user'])*100,2)}
    (out/'measurement.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
