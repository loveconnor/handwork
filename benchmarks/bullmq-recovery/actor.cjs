const path = require('node:path');
const [repo, port, queueName, prefix, token] = process.argv.slice(2);
const { Worker } = require(path.join(repo, 'dist/cjs'));
const { createIORedisClient } = require(path.join(repo, 'dist/cjs/classes/ioredis-client'));
const Redis = require(path.join(repo, 'node_modules/ioredis'));
const raw = new Redis({ host: '127.0.0.1', port: Number(port), maxRetriesPerRequest: null });
const worker = new Worker(queueName, null, { connection: createIORedisClient(raw), prefix, autorun: false, skipLockRenewal: true, stalledInterval: 50, lockDuration: 120000, maxStalledCount: 2 });
worker.on('error', e => process.send?.({ event: 'worker-error', message: e.message }));
let job;
process.on('message', async ({ id, op }) => {
 try {
  let value;
  if (op === 'claim') { job = await worker.getNextJob(token, { block: false }); value = job?.id ?? null; }
  else if (op === 'recover') { await worker.startStalledCheckTimer(); value = true; }
  else if (op === 'complete') value = await job.moveToCompleted('owner-result', token, false);
  else if (op === 'fail') value = await job.moveToFailed(new Error('processor failure'), token, false);
  else if (op === 'extend') value = await job.extendLock(token, 900000);
  else if (op === 'extend-batch') value = await worker.extendJobLocks([job.id], [token], 900000);
  else if (op === 'stop') { await worker.close(true); raw.disconnect(); process.send({ id, ok: true }); process.exit(0); }
  else throw Error('Unknown operation');
  process.send({ id, ok: true, value });
 } catch(e) { process.send({ id, ok: false, error: e.message }); }
});
worker.waitUntilReady().then(() => process.send({ ready: true })).catch(e => { console.error(e); process.exit(1); });
