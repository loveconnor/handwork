#!/usr/bin/env python3
"""Record interactive startup in a PTY, separately from task and model latency."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
import pilot

def capture(h,attempt):
    s=pilot.state();folder,repo=pilot.workspace(s,f'startup-{attempt}-{h}-{int(time.time())}')
    env=pilot.env_for(h,folder);env.update(PWD=str(repo));env.pop('OLDPWD',None)
    if h=='codex':
        args=[pilot.CODEX,'--no-alt-screen','--dangerously-bypass-approvals-and-sandbox','-m',pilot.MODEL,'-c','model_reasoning_effort="low"','-c',f'model_context_window={pilot.CONTEXT}','-c','plugins={}','-c','mcp_servers={}']
    elif h=='opencode':args=[pilot.OPENCODE,'--pure','--auto','--model','openai/'+pilot.MODEL]
    else:args=[s['handwork']]
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',34,120,0,0))
    raw=b'';first=None;ready=None;marker=None;sent=False
    with pilot.handwork_auth() if h=='handwork' else contextlib.nullcontext():
        start=time.monotonic()
        p=subprocess.Popen(['/usr/bin/sandbox-exec','-p',pilot.sandbox(s,folder)]+args,cwd=repo,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
        os.close(slave)
        try:
            while time.monotonic()-start<15 and p.poll() is None:
                if select.select([master],[],[],.05)[0]:
                    try:data=os.read(master,65536)
                    except OSError:break
                    raw+=data
                    if first is None:first=time.monotonic()-start
                    if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
                    text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw.decode(errors='replace'))
                    # Echoing a distinctive, unsubmitted string confirms that the prompt accepts input.
                    markers={'codex':['for shortcuts','context left','OpenAI Codex'], 'opencode':['Ask anything','Build','GPT-6','gpt-6-astra'], 'handwork':['ctrl','Ask','gpt-6-astra','handwork v']}
                    if not sent and any(m in text for m in markers[h]):
                        os.write(master,b'BENCH_READY_7');sent=True;marker=time.monotonic()-start
                    if sent and 'BENCH_READY_7' in text:
                        ready=time.monotonic()-start;break
        finally:
            try:os.killpg(p.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
            os.close(master)
    pilot.cleanup_auth(folder)
    prefix=pilot.OUT/f'startup-{attempt}-{h}'
    prefix.with_suffix('.ansi').write_bytes(raw)
    clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',raw.decode(errors='replace'))
    prefix.with_suffix('.txt').write_text(clean)
    return {'harness':h,'attempt':attempt,'first_output_s':first,'prompt_marker_s':marker,'usable_prompt_s':ready,'method':'PTY prompt accepted unsubmitted BENCH_READY_7','exit_code_after_termination':p.returncode,'note':'Codex TUI does not support exec ignore-user-config; CLI overrides model, effort, plugins and MCP, but may inherit other user settings.' if h=='codex' else None}

if __name__=='__main__':
    results=json.loads((pilot.OUT/'startup.json').read_text()) if (pilot.OUT/'startup.json').exists() else []
    for attempt in range(1,int(sys.argv[1] if len(sys.argv)>1 else '1')+1):
        for h in ['handwork','opencode','codex']:
            r=capture(h,attempt+1);results.append(r);print(json.dumps(r),flush=True)
            pilot.write_json(pilot.OUT/'startup.json',results)
