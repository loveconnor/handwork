import json,sqlite3,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'fixed-budget'))
import pilot

class SessionAccounting(unittest.TestCase):
    def test_descendants_once_and_unrelated_sessions_excluded(self):
        with tempfile.TemporaryDirectory() as folder:
            db=Path(folder)/'opencode.db'
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE session(id TEXT,parent_id TEXT,tokens_input INT,tokens_output INT,tokens_reasoning INT,tokens_cache_read INT,tokens_cache_write INT)')
                c.execute('CREATE TABLE part(session_id TEXT,data TEXT)')
                c.executemany('INSERT INTO session VALUES(?,?,?,?,?,?,?)',[
                    ('root',None,10,2,1,20,0),('child','root',5,3,0,4,0),('grandchild','child',7,1,0,0,0),('other',None,999,999,999,999,999)])
                c.executemany('INSERT INTO part VALUES(?,?)',[(sid,json.dumps({'type':kind})) for sid,kind in [('root','tool'),('child','tool'),('child','text'),('grandchild','tool'),('other','tool')]])
            result=pilot.opencode_session_usage(db,'root')
            self.assertEqual(result,dict(input_tokens=46,output_tokens=7,cached_input_tokens=24,reasoning_tokens=1,tool_calls=3,accounted_sessions=3))
            with self.assertRaises(ValueError):pilot.opencode_session_usage(db,'missing')

    def test_missing_child_usage_is_unavailable_not_parent_only(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as folder:
            log=Path(folder)/'attempt'
            events=[{'type':'tool_use','sessionID':'parent','part':{'tool':'task'}},
                    {'type':'step_finish','part':{'reason':'stop','tokens':{'input':10,'output':2}}}]
            Path(str(log)+'.stdout').write_text('\n'.join(json.dumps(e) for e in events))
            with patch.object(pilot,'state',return_value={'base':folder}):result=pilot.parse('opencode',log)
            self.assertIsNone(result['input_tokens'])
            self.assertIsNone(result['tool_calls'])
            self.assertEqual(result['parent_only_usage']['input_tokens'],10)
            self.assertTrue(result['completed'])

if __name__=='__main__':unittest.main()
