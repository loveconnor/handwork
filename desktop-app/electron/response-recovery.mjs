// Resume only the engine's durable checkpoint, never replay a user prompt or tools.
export function canContinueRecovery(recovery) {
  return recovery?.state === 'paused' && recovery.durable === true && recovery.requiredAction === 'continue_later';
}

export function canAutoRecover(recovery) {
  return canContinueRecovery(recovery)
    && ['network_interrupted', 'response_interrupted', 'provider_stream_timeout', 'provider_unavailable', 'system_resumed'].includes(recovery.cause)
    && !(recovery.attemptLimit > 0 && recovery.attempt >= recovery.attemptLimit);
}

export const continuationParams = sessionId => ({ sessionId, prompt: [], _meta: { handwork: { continueRecovery: true } } });

export async function requestWithRecovery(engine, params, { onWaiting = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let retry = 0; ; retry++) {
    engine.recovery = undefined;
    let result;
    let failure;
    try { result = await engine.client.request('session/prompt', params, { timeout: 0 }); }
    catch (error) { failure = error; }
    if (engine.cancelling || engine.client.closed || result?.stopReason === 'cancelled' || retry >= 2 || !canAutoRecover(engine.recovery)) {
      if (failure) throw failure;
      return result;
    }
    const delay = retry === 0 ? 2000 : 5000;
    onWaiting({ ...engine.recovery, state: 'active', message: `Connection interrupted. Retrying in ${delay / 1000} seconds…` });
    await wait(delay);
    if (engine.cancelling || engine.client.closed) return { stopReason: 'cancelled' };
    params = continuationParams(params.sessionId);
  }
}
