import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('claude_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class AccountingTests(unittest.TestCase):
    def parse(self, events):
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / 'run'
            log.with_suffix('.stdout').write_text('\n'.join(json.dumps(e) for e in events))
            return runner.parse(log)

    def test_cache_tokens_and_duplicate_stream_messages(self):
        assistant = {'type': 'assistant', 'message': {'id': 'message-1', 'content': [{'type': 'tool_use', 'id': 'call-1'}]}}
        result = {'type': 'result', 'subtype': 'success', 'modelUsage': {runner.MODEL: {}},
                  'usage': {'input_tokens': 10, 'cache_creation_input_tokens': 20, 'cache_read_input_tokens': 30, 'output_tokens': 4}}
        measured = self.parse([assistant, assistant, result])
        self.assertEqual(measured['input_tokens'], 60)
        self.assertEqual(measured['output_tokens'], 4)
        self.assertEqual(measured['tool_calls'], 1)
        self.assertEqual(measured['model_requests'], 1)
        self.assertTrue(measured['completed'])

    def test_interrupted_run_does_not_invent_usage(self):
        measured = self.parse([{'type': 'system', 'subtype': 'init'}])
        self.assertFalse(measured['completed'])
        self.assertIsNone(measured['input_tokens'])

    def test_wrong_model_cannot_be_reported_as_requested_model(self):
        with self.assertRaises(RuntimeError):
            self.parse([{'type': 'result', 'modelUsage': {'other-model': {}}, 'usage': {}}])


if __name__ == '__main__':
    unittest.main()
