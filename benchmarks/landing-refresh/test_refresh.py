import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('landing_refresh', Path(__file__).with_name('run.py'))
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTests(unittest.TestCase):
    def test_schedule_keeps_five_attempts_for_each_original_task(self):
        rows = refresh.schedule()
        self.assertEqual(len({r['id'] for r in rows}), 20)
        for task in refresh.TASKS:
            self.assertEqual([r['attempt'] for r in rows if r['task'] == task], [1, 2, 3, 4, 5])

    def test_profile_removes_execution_credential_after_failure_without_changing_source(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            original = root / 'original/.handwork'
            original.mkdir(parents=True)
            source = original / 'chatgpt-auth.json'
            content = json.dumps({'access_token': 'synthetic', 'expires_at_ms': (time.time() + 3600) * 1000})
            source.write_text(content)
            folder = root / 'attempt'
            folder.mkdir()
            with patch.object(Path, 'home', return_value=root / 'original'):
                with self.assertRaisesRegex(RuntimeError, 'forced failure'):
                    with refresh.profile_home(folder, False) as task_home:
                        credential = task_home / '.handwork/chatgpt-auth.json'
                        self.assertEqual(credential.stat().st_mode & 0o777, 0o600)
                        self.assertEqual(credential.read_text(), content)
                        raise RuntimeError('forced failure')
            self.assertFalse(credential.exists())
            self.assertEqual(source.read_text(), content)

    def test_environment_removes_inherited_overrides_and_keeps_bounded_default_unset(self):
        with patch.dict(os.environ, {'HANDWORK_EXPERIMENT_BOUNDED_DELEGATION': '0',
                                    'HANDWORK_MAX_AGENT_STEPS': '1', 'OPENAI_API_KEY': 'synthetic',
                                    'HTTPS_PROXY': 'http://wrong'}, clear=False):
            env = refresh.environment(Path('/temporary-profile'))
        self.assertEqual(env['HANDWORK_AUTH_READ_ONLY'], '1')
        for key in ('HANDWORK_EXPERIMENT_BOUNDED_DELEGATION', 'HANDWORK_MAX_AGENT_STEPS',
                    'OPENAI_API_KEY', 'HTTPS_PROXY'):
            self.assertNotIn(key, env)

    def test_summary_keeps_failures_and_unavailable_usage(self):
        with tempfile.TemporaryDirectory() as name:
            rows = [dict(task='pagination', success=success, duration_s=seconds,
                         peak_rss_bytes={'harness': 1048576}, input_tokens=tokens,
                         output_tokens=2, tool_calls=3, model_requests=1)
                    for success, seconds, tokens in [(True, 10, 100), (False, 600, None)]]
            refresh.summarize(rows, Path(name))
            result = json.loads((Path(name) / 'summary.json').read_text())['pagination']
            self.assertEqual((result['attempts'], result['successes']), (2, 1))
            self.assertEqual(result['median_success_seconds'], 10)
            self.assertIsNone(result['mean_input_tokens'])
            self.assertEqual(result['mean_output_tokens'], 2)

    def test_exclusive_records_cannot_replace_failed_evidence(self):
        with tempfile.TemporaryDirectory() as name:
            path = Path(name) / 'attempt.json'
            refresh.write_new(path, {'success': False})
            with self.assertRaises(FileExistsError):
                refresh.write_new(path, {'success': True})
            self.assertFalse(json.loads(path.read_text())['success'])


if __name__ == '__main__':
    unittest.main()
