import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexRuntime } from './codex.mjs';
import { CopilotRuntime } from './copilot.mjs';

test('Codex adapter authenticates via runtime, denies unapproved actions, and streams a turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'handwork-runtime-'));
  const executable = join(dir, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({input:process.stdin});
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line', line => {
 const m=JSON.parse(line);
 if(m.id===900) {
  if(m.result.decision!=='decline') process.exit(2);
  send({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:'runtime output'}});
  send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});
  return;
 }
 if(!m.method || m.id===undefined) return;
 let result={};
 switch(m.method) {
  case 'initialize': if(m.params.clientInfo.name!=='handwork') process.exit(3);break;
  case 'account/read': result={account:{type:'chatgpt'}};break;
  case 'model/list': result={data:[{id:'model-test'}]};break;
  case 'thread/start': if(m.params.approvalPolicy!=='on-request')process.exit(4);result={thread:{id:'thread-test'}};break;
  case 'turn/start': result={turn:{id:'turn-test'}};break;
 }
 send({id:m.id,result});
 if(m.method==='turn/start') send({id:900,method:'item/commandExecution/requestApproval',params:{threadId:'thread-test',command:'example'}});
});
`, { mode: 0o700 });
  const output = [];
  const runtime = new CodexRuntime({ executable, cwd: dir, output: text => output.push(text) });
  try {
    await runtime.start();
    assert.equal((await runtime.models())[0].id, 'model-test');
    assert.equal(await runtime.ask('hello'), 'thread-test');
    assert.equal(output.join(''), 'runtime output\n');
  } finally { await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('Copilot adapter uses SDK authentication, streams and denies permissions by default', async () => {
  let sessionConfig;
  let callback;
  let disconnected = false;
  const fake = {
    start: async () => {}, stop: async () => {},
    getAuthStatus: async () => ({ isAuthenticated: true }),
    createSession: async config => {
      sessionConfig = config;
      return {
        sessionId: 'copilot-test',
        on: listener => { callback=listener;return () => {}; },
        sendAndWait: async () => {
          assert.deepEqual(await config.onPermissionRequest({kind:'shell'}), {kind:'denied-interactively-by-user'});
          callback({type:'assistant.message_delta',data:{deltaContent:'hello'}});
        },
        disconnect: async () => {disconnected=true;},
      };
    },
  };
  let output='';
  const runtime=new CopilotRuntime({client:fake,output:text=>{output+=text;}});
  await runtime.start();
  assert.equal(await runtime.ask('hello',{model:'test-model'}),'copilot-test');
  assert.equal(sessionConfig.model,'test-model');
  assert.equal(sessionConfig.provider,undefined);
  assert.ok(output.endsWith('hello\n'));
  assert.ok(disconnected);
  await runtime.stop();
});

test('Copilot does not silently substitute API billing for missing subscription auth', async () => {
  const runtime=new CopilotRuntime({client:{getAuthStatus:async()=>({isAuthenticated:false})}});
  await assert.rejects(runtime.ask('hello'),/official Copilot CLI/);
});
