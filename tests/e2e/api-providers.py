"""Native provider integration tests using loopback only and isolated profiles.
Run: python3 tests/e2e/api-providers.py
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest

ROOT = Path(__file__).resolve().parents[2]
EXE = ROOT / 'zig-out/bin/handwork'
KEYS = {'openai':'OPENAI_API_KEY','anthropic':'ANTHROPIC_API_KEY','gemini':'GEMINI_API_KEY','xai':'XAI_API_KEY','deepseek':'DEEPSEEK_API_KEY','mistral':'MISTRAL_API_KEY','groq':'GROQ_API_KEY','together':'TOGETHER_API_KEY','fireworks':'FIREWORKS_API_KEY','openrouter':'OPENROUTER_API_KEY','minimax':'MINIMAX_SUBSCRIPTION_KEY','ollama':None,'ollama_cloud':'OLLAMA_API_KEY'}
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.server.requests.append((self.path, dict(self.headers), None))
        data=json.dumps({'data':[{'id':'gpt-test'}]}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.requests.append((self.path, dict(self.headers),body))
        if self.path.endswith('/messages'):
            events=[{'type':'message_start','message':{'usage':{'input_tokens':5}}},{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'MOCK SUCCESS'}},{'type':'message_delta','delta':{'stop_reason':'end_turn'},'usage':{'output_tokens':3}},{'type':'message_stop'}]
        else:
            events=[{'choices':[{'delta':{'content':'MOCK SUCCESS'},'finish_reason':None}]},{'choices':[{'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':5,'completion_tokens':3}},'[DONE]']
        data=''.join('data: '+(e if isinstance(e,str) else json.dumps(e))+'\n\n' for e in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
class Providers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);cls.server.requests=[]
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.server.shutdown();cls.server.server_close();cls.thread.join()
    def test_login_and_stream_all_providers(self):
        for provider,key in KEYS.items():
            with self.subTest(provider=provider), tempfile.TemporaryDirectory(prefix='handwork-api-') as home:
                env={'PATH':os.environ['PATH'],'HOME':home,'USER':'test','TERM':'dumb','HANDWORK_'+provider.upper()+'_BASE_URL':f'http://127.0.0.1:{self.server.server_port}/v1'}
                secret=('sk-cp-' if provider=='minimax' else '')+'test-'+provider
                if key: env[key]=secret
                if provider=='ollama': env['OLLAMA_API_KEY']='must-not-leak-to-local'
                if provider in ('qwen','minimax'): env['HANDWORK_'+provider.upper()+'_MODEL']='gpt-test'
                def run(*args):
                    return subprocess.run([str(EXE),*args],cwd=home,env=env,text=True,capture_output=True,timeout=30)
                login=run('login',provider)
                self.assertEqual(login.returncode,0,login.stderr)
                settings=json.loads((Path(home)/'.handwork/settings.json').read_text())
                self.assertEqual(settings['provider'],provider)
                self.assertNotIn('test-'+provider,json.dumps(settings))
                answer=run('ask','--no-save','--json','Say hello.')
                self.assertEqual(answer.returncode,0,answer.stderr)
                self.assertIn('MOCK SUCCESS',answer.stdout)
                path,headers,body=self.server.requests[-1]
                lower={k.lower():v for k,v in headers.items()}
                self.assertEqual(body['model'],'gpt-test')
                self.assertTrue(body['stream'])
                self.assertTrue(lower['user-agent'].startswith('handwork/'))
                self.assertNotIn('x-xai-token-auth',lower)
                if provider=='anthropic':
                    self.assertEqual(lower['x-api-key'],'test-'+provider);self.assertNotIn('authorization',lower)
                elif provider=='ollama':
                    self.assertNotIn('authorization',lower)
                    self.assertNotIn('must-not-leak-to-local',json.dumps(self.server.requests))
                else: self.assertEqual(lower['authorization'],'Bearer '+secret)
    def test_disabled_subscription_routes_never_connect(self):
        for provider in ('grok','qwen'):
            with self.subTest(provider=provider), tempfile.TemporaryDirectory(prefix='handwork-policy-') as home:
                env={'PATH':os.environ['PATH'],'HOME':home,'USER':'test','QWEN_SUBSCRIPTION_KEY':'sk-sp-test'}
                before=len(self.server.requests)
                for command in ('login', 'provider'):
                    result=subprocess.run([str(EXE),command,provider],cwd=home,env=env,text=True,capture_output=True,timeout=10)
                    self.assertNotEqual(result.returncode,0)
                    self.assertIn('disabled',result.stderr)
                profile=Path(home)/'.handwork'
                profile.mkdir(exist_ok=True)
                (profile/'settings.json').write_text(json.dumps({'provider':provider}))
                result=subprocess.run([str(EXE),'ask','--no-save','hello'],cwd=home,env=env,text=True,capture_output=True,timeout=10)
                self.assertNotEqual(result.returncode,0)
                self.assertEqual(len(self.server.requests),before)
    def test_ollama_cloud_requires_key_even_when_local_is_available(self):
        with tempfile.TemporaryDirectory(prefix='handwork-ollama-') as home:
            env={'PATH':os.environ['PATH'],'HOME':home,'USER':'test'}
            result=subprocess.run([str(EXE),'login','ollama_cloud'],cwd=home,env=env,text=True,capture_output=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('OLLAMA_API_KEY',result.stderr)
            result=subprocess.run([str(EXE),'logout','ollama'],cwd=home,env=env,text=True,capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0)
            self.assertIn('no saved login',result.stdout)
            self.assertNotIn('UNUSED_KEY',result.stdout)
    def test_missing_key_does_not_fall_back_to_another_provider(self):
        with tempfile.TemporaryDirectory(prefix='handwork-api-') as home:
            env={'PATH':os.environ['PATH'],'HOME':home,'USER':'test','OPENAI_API_KEY':'test-openai'}
            result=subprocess.run([str(EXE),'login','anthropic'],cwd=home,env=env,text=True,capture_output=True,timeout=10)
            self.assertNotEqual(result.returncode,0);self.assertIn('ANTHROPIC_API_KEY',result.stderr)
            self.assertNotIn('test-openai',result.stdout+result.stderr)
if __name__=='__main__': unittest.main()
