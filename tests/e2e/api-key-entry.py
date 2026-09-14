"""Real PTY API-key entry regression; synthetic secrets and loopback HTTP only."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('providers', Path(__file__).with_name('api-providers.py'))
providers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(providers)

class KeyEntry(unittest.TestCase):
    def test_masked_entry_cancel_save_restart_and_logout(self):
        server = providers.ThreadingHTTPServer(('127.0.0.1', 0), providers.Handler)
        server.requests = []
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix='handwork-key-ui-') as home:
                profile = Path(home, '.handwork')
                profile.mkdir(mode=0o700)
                (profile / 'settings.json').write_text(json.dumps({'provider': 'openai'}))
                env = {'HOME': home, 'PATH': os.environ['PATH'], 'USER': 'test', 'TERM': 'xterm-256color',
                       'HANDWORK_OPENAI_BASE_URL': f'http://127.0.0.1:{server.server_port}/v1'}
                pid, fd = pty.fork()
                if pid == 0:
                    os.chdir(home)
                    os.execve(str(providers.EXE), [str(providers.EXE)], env)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
                output = bytearray()
                def read_for(seconds):
                    deadline = time.monotonic() + seconds
                    while time.monotonic() < deadline:
                        if select.select([fd], [], [], .05)[0]:
                            try:
                                output.extend(os.read(fd, 65536))
                            except OSError:
                                break
                def send(data, seconds=.3):
                    os.write(fd, data)
                    read_for(seconds)
                try:
                    read_for(1)
                    send(b'\x1b')
                    send(b'/provider openai\r', 2)
                    self.assertIn(b'Enter API key', output)
                    self.assertIn(b'owner-only access', output)
                    self.assertNotIn(b'API key: [', output)
                    send(b'cancelled-secret')
                    self.assertNotIn(b'cancelled-secret', output)
                    send(b'\x1b', .5)
                    self.assertFalse((profile / 'api-key-openai').exists())
                    send(b'/login openai\r', 2)
                    send(b'\x1b[200~test-saved-key\x1b[201~', .5)
                    self.assertNotIn(b'test-saved-key', output)
                    send(b'\r', 2)
                    key_file = profile / 'api-key-openai'
                    self.assertEqual(key_file.read_text(), 'test-saved-key')
                    self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)
                    self.assertNotIn('test-saved-key', (profile / 'settings.json').read_text())
                    self.assertTrue(server.requests)
                    self.assertEqual(server.requests[-1][1].get('authorization') or server.requests[-1][1].get('Authorization'), 'Bearer test-saved-key')
                finally:
                    os.kill(pid, signal.SIGTERM)
                    os.waitpid(pid, 0)
                    os.close(fd)
                def run(*args):
                    return subprocess.run([str(providers.EXE), *args], cwd=home, env=env, text=True, capture_output=True, timeout=15)
                reply = run('ask', '--no-save', '--json', 'hello')
                self.assertEqual(reply.returncode, 0, reply.stderr)
                self.assertIn('MOCK SUCCESS', reply.stdout)
                other = run('login', 'anthropic')
                self.assertNotEqual(other.returncode, 0)
                self.assertNotIn('test-saved-key', other.stdout + other.stderr)
                result = run('logout', 'openai')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(key_file.exists())
                self.assertNotEqual(run('login', 'openai').returncode, 0)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

if __name__ == '__main__':
    unittest.main()
