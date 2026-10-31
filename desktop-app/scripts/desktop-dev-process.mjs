export function desktopDevProcess({ launch, onExit, delay = 150 }) {
  let child;
  let timer;
  let closed = false;
  let pending = Promise.resolve();
  async function terminate() {
    const previous = child;
    child = undefined;
    if (!previous || previous.exitCode !== null || previous.signalCode !== null) return;
    await new Promise(resolve => {
      previous.once('exit', resolve);
      const force = setTimeout(() => previous.kill('SIGKILL'), 2500);
      previous.once('exit', () => clearTimeout(force));
      previous.kill('SIGTERM');
    });
  }
  function start() {
    if (closed) return;
    const current = child = launch();
    current.once('error', error => { if (child === current) onExit(1, error); });
    current.once('exit', (code, signal) => {
      if (child === current) onExit(signal ? 1 : code ?? 1);
    });
  }
  return {
    start,
    restart() {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending = pending.then(async () => { await terminate(); start(); }).catch(error => onExit(1, error));
      }, delay);
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await pending;
      await terminate();
    },
  };
}
