// A stand-in language server: answers initialize with what it was sent,
// asks its client for configuration, and reports the answer back.
import { frame, MessageReader } from '../../../electron/language-servers.mjs';

const send = message => process.stdout.write(frame(JSON.stringify(message)));
const reader = new MessageReader(text => {
  const message = JSON.parse(text);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { textDocumentSync: 2 }, received: message.params } });
    send({ jsonrpc: '2.0', id: 'config-1', method: 'workspace/configuration', params: { items: [{ section: 'a' }, { section: 'b' }] } });
  } else if (message.id === 'config-1') {
    send({ jsonrpc: '2.0', method: 'test/answered', params: message.result });
  } else if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null });
  } else if (message.method === 'exit') {
    process.exit(0);
  } else if (message.method === 'test/crash') {
    process.stderr.write('something broke\n');
    process.exit(3);
  }
});
process.stdin.on('data', chunk => reader.push(chunk));
