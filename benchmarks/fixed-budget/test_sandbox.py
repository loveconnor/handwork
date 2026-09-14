"""Regression checks for allowed ancestor traversal and denied external content."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import pilot

@unittest.skipUnless(sys.platform == 'darwin', 'Requires macOS sandbox-exec')
class SandboxRegression(unittest.TestCase):
    def test_component_traversal_and_content_isolation(self):
        with tempfile.TemporaryDirectory(prefix='handwork-sandbox-test-',dir='/private/tmp') as directory:
            base=Path(directory);folder=base/'attempt';repo=folder/'repo'
            private=base/'private';sibling=base/'other-attempt';binary=base/'bin'
            for p in [repo,private,sibling,binary]:p.mkdir(parents=True)
            (repo/'allowed').write_text('before')
            (private/'secret').write_text('private')
            (sibling/'secret').write_text('sibling')
            (repo/'escape').symlink_to(private/'secret')
            profile=pilot.sandbox({'base':str(base),'private':str(private)},folder)
            code='''import os,sys,json
repo,private,sibling=sys.argv[1:]
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for part in repo.strip('/').split('/'):
 child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
 os.close(fd);fd=child
os.close(fd)
assert open(repo+'/allowed').read()=='before'
with open(repo+'/allowed','w') as f:f.write('after')
checks=['ancestor_traversal','own_read','own_write']
for label,path in [('verifier',private+'/secret'),('sibling',sibling+'/secret'),('symlink',repo+'/escape')]:
 for mode in ['r','w']:
  try:
   with open(path,mode) as f:
    if mode=='r':f.read()
  except PermissionError:checks.append(label+'_'+mode+'_denied')
  else:raise AssertionError(label+' '+mode+' unexpectedly allowed')
print(json.dumps(checks))
'''
            r=pilot.command(['/usr/bin/sandbox-exec','-p',profile,sys.executable,'-c',code,str(repo),str(private),str(sibling)],repo)
            self.assertEqual(r.returncode,0,r.stderr)
            self.assertEqual(len(json.loads(r.stdout)),9)
            self.assertEqual((private/'secret').read_text(),'private')
            self.assertEqual((sibling/'secret').read_text(),'sibling')
            self.assertEqual((repo/'allowed').read_text(),'after')

if __name__=='__main__':unittest.main()
