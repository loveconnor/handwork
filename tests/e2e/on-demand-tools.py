"""On-demand loading through the real native loop; loopback, no inference or credentials.
Run: HANDWORK_TEST_EXE=/path/to/handwork python3 tests/e2e/on-demand-tools.py
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('api_fixture', Path(__file__).with_name('api-providers.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
EXE = Path(os.environ.get('HANDWORK_TEST_EXE', ROOT / 'zig-out/bin/handwork'))

class Handler(fixture.Handler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.bodies.append(body)
        step = len(self.server.bodies)
        if self.server.script:
            name, args = self.server.script.pop(0)
            choice = {'delta': {'tool_calls': [{'index': 0, 'id': f'call_{step}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}, 'finish_reason': 'tool_calls'}
        else:
            choice = {'delta': {'content': 'DONE'}, 'finish_reason': 'stop'}
        events = [{'choices': [choice]}, {'choices': [], 'usage': {'prompt_tokens': 5, 'completion_tokens': 3}}, '[DONE]']
        data = ''.join('data: ' + (event if isinstance(event, str) else json.dumps(event)) + '\n\n' for event in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

class OnDemand(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='handwork-demand-')
        self.home = Path(self.tmp.name)
        self.workspace = self.home / 'workspace'
        self.workspace.mkdir()
        (self.workspace / 'evidence.txt').write_text('startup fixture\n')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.requests = []
        self.server.bodies = []
        self.server.script = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = {'PATH': os.environ['PATH'], 'HOME': str(self.home), 'USER': 'test', 'TERM': 'dumb', 'OPENAI_API_KEY': 'local-test-only', 'HANDWORK_OPENAI_BASE_URL': f'http://127.0.0.1:{self.server.server_port}/v1'}
        self.run_cli('login', 'openai')
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()
    def run_cli(self, *args):
        p = subprocess.run([str(EXE), *args], cwd=self.workspace, env=self.env, text=True, capture_output=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stderr)
        return p
    def functions(self, body):
        return {t['function']['name']: t['function'] for t in body['tools']}
    def test_load_execute_retry_and_resume(self):
        self.server.script = [('load_tools', {'names': ['glob_files', 'not_a_tool']}), ('load_tools', {'names': ['glob_files']}), ('glob_files', {'pattern': '*.txt'})]
        self.run_cli('ask', '--json', 'Find the txt file.')
        bodies = self.server.bodies
        self.assertEqual(set(self.functions(bodies[0])), {'load_tools', 'read_file'})
        self.assertEqual(set(self.functions(bodies[1])), {'load_tools', 'read_file'})
        self.assertIn('glob_files', self.functions(bodies[2]))
        self.assertNotIn('not_a_tool', self.functions(bodies[2]))
        self.assertIn('evidence.txt', json.dumps(bodies[-1]['messages']))
        count = len(bodies)
        self.run_cli('ask', '--resume', 'last', '--json', 'Thanks.')
        self.assertIn('glob_files', self.functions(bodies[count]))
    def test_every_schema_can_be_loaded_without_changing_contracts(self):
        self.env['HANDWORK_ON_DEMAND_TOOLS'] = '0'
        self.run_cli('ask', '--json', 'hello')
        eager = self.functions(self.server.bodies[-1])
        self.assertNotIn('load_tools', eager)
        self.assertIn('subagent', eager)
        self.env['HANDWORK_ON_DEMAND_TOOLS'] = '1'
        self.server.script = [('load_tools', {'names': list(eager)})]
        self.run_cli('ask', '--json', 'Load the available tools.')
        loaded = self.functions(self.server.bodies[-1])
        for name, definition in eager.items():
            self.assertEqual(definition, loaded[name])
        self.assertEqual(set(loaded), set(eager) | {'load_tools'})

    def test_resume_restores_successful_unused_selection_but_not_failed_selection(self):
        self.server.script = [('load_tools', {'names': ['shell', 'missing_tool']})]
        self.run_cli('ask', '--json', 'Load tools.')
        count = len(self.server.bodies)
        self.run_cli('ask', '--resume', 'last', '--json', 'Continue.')
        self.assertNotIn('shell', self.functions(self.server.bodies[count]))
        self.server.script = [('load_tools', {'names': ['edit_file']})]
        self.run_cli('ask', '--resume', 'last', '--json', 'Load editing.')
        count = len(self.server.bodies)
        self.run_cli('ask', '--resume', 'last', '--json', 'Continue.')
        self.assertIn('edit_file', self.functions(self.server.bodies[count]))

    def test_loading_cannot_restore_a_permission_denied_tool(self):
        settings = self.home / '.handwork/settings.json'
        data = json.loads(settings.read_text())
        data['permission'] = {'shell': 'deny'}
        settings.write_text(json.dumps(data))
        self.server.script = [('load_tools', {'names': ['shell']})]
        self.run_cli('ask', '--json', 'Load shell.')
        for body in self.server.bodies:
            functions = self.functions(body)
            self.assertNotIn('shell', functions)
            self.assertNotIn('shell', functions['load_tools']['description'])
        self.assertIn('Tool unavailable: shell', json.dumps(self.server.bodies[-1]['messages']))

    def test_denied_loader_falls_back_to_eager_without_losing_other_tools(self):
        settings = self.home / '.handwork/settings.json'
        data = json.loads(settings.read_text())
        data['permission'] = {'load_tools': 'deny'}
        settings.write_text(json.dumps(data))
        self.run_cli('ask', '--json', 'hello')
        functions = self.functions(self.server.bodies[-1])
        self.assertNotIn('load_tools', functions)
        self.assertIn('shell', functions)
        self.assertIn('subagent', functions)

if __name__ == '__main__':
    unittest.main(verbosity=2)
