"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopAPI, VoiceStatus } from './desktop-api';
import { voiceWav } from './voice-audio.mjs';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';
type Capture = {
  epoch: number; context?: AudioContext; stream?: MediaStream; node?: AudioWorkletNode;
  source?: MediaStreamAudioSourceNode; chunks: Float32Array[]; timer?: ReturnType<typeof setTimeout>;
  stopped?: () => void;
};
const errorMessage = (error: unknown) => {
  if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) return 'Allow Handwork microphone access in system settings to use dictation.';
  if (error instanceof DOMException && error.name === 'NotFoundError') return 'No microphone was found. Connect one and try again.';
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
};

async function release(capture: Capture) {
  clearTimeout(capture.timer);
  if (capture.node) { capture.node.port.onmessage = null; capture.node.disconnect(); capture.node.port.close(); }
  capture.source?.disconnect();
  capture.stream?.getTracks().forEach(track => track.stop());
  if (capture.context && capture.context.state !== 'closed') await capture.context.close().catch(() => {});
}

/** Recording belongs to one composer. Navigation cancels capture and late results. */
export function useLocalDictation({ api, composerKey, onText, onError }: {
  api?: DesktopAPI; composerKey: string; onText: (text: string) => void; onError: (message: string) => void;
}) {
  const [status, setStatus] = useState<VoiceStatus>({ available: false });
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const capture = useRef<Capture | null>(null);
  const epoch = useRef(0);
  const currentKey = useRef(composerKey);
  currentKey.current = composerKey;
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const setPhaseNow = useCallback((value: Phase) => { phaseRef.current = value; setPhase(value); }, []);
  // Serialize cancellation with a following transcription, without blocking capture.
  const cancellation = useRef<Promise<unknown>>(Promise.resolve());
  const cancel = useCallback(() => {
    epoch.current++;
    const previous = phaseRef.current;
    const recording = capture.current;
    capture.current = null;
    recording?.stopped?.();
    if (recording) void release(recording);
    setPhaseNow('idle');
    if (previous === 'transcribing' && api) cancellation.current = api.cancelVoice().catch(() => {});
  }, [api, setPhaseNow]);

  useEffect(() => {
    let live = true;
    if (api) void api.voiceStatus().then(value => { if (live) setStatus(value); }).catch(() => { if (live) setStatus({ available: false }); });
    return () => { live = false; };
  }, [api]);

  useEffect(() => {
    // Also stop capture when the app is hidden or the renderer is unloaded.
    const hidden = () => { if (document.hidden) cancel(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', cancel);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cancel); cancel(); };
  }, [composerKey, cancel]);

  const finish = useCallback(async () => {
    const recording = capture.current;
    if (!api || !recording || phaseRef.current !== 'recording') return;
    const key = currentKey.current;
    setPhaseNow('transcribing');
    clearTimeout(recording.timer);
    try {
      // Flush the audio thread before reading its final samples.
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 250);
        recording.stopped = () => { clearTimeout(timer); resolve(); };
        recording.node!.port.postMessage('stop');
      });
      await release(recording);
      if (epoch.current !== recording.epoch || currentKey.current !== key) return;
      capture.current = null;
      const audio = voiceWav(recording.chunks, recording.context!.sampleRate);
      recording.chunks = [];
      // Avoid interpreting very short clicks or silence as speech.
      if (audio.length < 44 + 16000 / 2) throw new Error('No speech recorded. Speak for a moment, then stop dictation.');
      await cancellation.current;
      if (epoch.current !== recording.epoch || currentKey.current !== key) return;
      const result = await api.transcribeVoice(audio);
      if (epoch.current !== recording.epoch || currentKey.current !== key) return;
      if (result.text) callbacks.current.onText(result.text);
      else callbacks.current.onError('No speech was detected. Try again closer to your microphone.');
    } catch (error) {
      if (epoch.current === recording.epoch && currentKey.current === key) callbacks.current.onError(errorMessage(error));
    } finally {
      await release(recording);
      if (epoch.current === recording.epoch) { capture.current = null; setPhaseNow('idle'); }
    }
  }, [api, setPhaseNow]);
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const toggle = useCallback(async () => {
    if (!api || !status.available) return;
    if (phaseRef.current === 'recording') { await finish(); return; }
    if (phaseRef.current !== 'idle') return;
    const recording: Capture = { epoch: ++epoch.current, chunks: [] };
    const key = currentKey.current;
    capture.current = recording;
    setPhaseNow('starting');
    try {
      recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      if (epoch.current !== recording.epoch || key !== currentKey.current) { await release(recording); return; }
      recording.context = new AudioContext();
      await recording.context.audioWorklet.addModule(new URL('./voice-recorder.js', document.baseURI).href);
      await recording.context.resume();
      if (epoch.current !== recording.epoch || key !== currentKey.current) { await release(recording); return; }
      recording.source = recording.context.createMediaStreamSource(recording.stream);
      recording.node = new AudioWorkletNode(recording.context, 'voice-recorder');
      recording.node.port.onmessage = event => {
        if (epoch.current !== recording.epoch) return;
        if (event.data.samples) recording.chunks.push(event.data.samples);
        if (event.data.stopped) recording.stopped?.();
        if (event.data.limit) void finishRef.current();
      };
      recording.source.connect(recording.node);
      // The processor emits silence; connecting it keeps capture running without
      // playing the microphone back through the speakers.
      recording.node.connect(recording.context.destination);
      for (const track of recording.stream.getAudioTracks()) track.onended = () => {
        if (epoch.current === recording.epoch && phaseRef.current === 'recording') {
          cancel(); callbacks.current.onError('Your microphone disconnected. Reconnect it and try again.');
        }
      };
      setPhaseNow('recording');
      recording.timer = setTimeout(() => void finishRef.current(), 120000);
    } catch (error) {
      await release(recording);
      if (epoch.current === recording.epoch) { capture.current = null; setPhaseNow('idle'); callbacks.current.onError(errorMessage(error)); }
    }
  }, [api, status.available, finish, cancel, setPhaseNow]);

  return { status, phase, toggle, cancel };
}
