"use client";
import { useEffect, useRef, useState, type RefObject } from 'react';
import { IconClose } from '@/components/atoms/Icons';

const BARS = 18;

/**
 * Dictation in progress, as one quiet pill in the composer: a live waveform
 * drawn from the microphone, the elapsed time, and the two ways out — cancel,
 * or stop and transcribe.
 */
export function HandworkDictation({ phase, level, startedAt, onStop, onCancel }: {
  phase: 'starting' | 'recording' | 'transcribing'; level: RefObject<number>; startedAt: number;
  onStop: () => void; onCancel: () => void;
}) {
  const wave = useRef<HTMLSpanElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  // The newest level enters on the right and the history drifts left, so the
  // meter reads as speech rather than a bouncing bar. It writes styles
  // directly each frame and never re-renders.
  useEffect(() => {
    const bars = wave.current ? [...wave.current.children] as HTMLElement[] : [];
    if (phase !== 'recording' || !bars.length) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const history = new Array<number>(BARS).fill(0);
    let smooth = 0, last = 0, frame = 0;
    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      const target = level.current ?? 0;
      smooth += (target - smooth) * (target > smooth ? 0.5 : 0.18);
      if (time - last < (still ? 240 : 64)) return;
      last = time;
      history.shift(); history.push(smooth);
      bars.forEach((bar, index) => bar.style.transform = `scaleY(${(0.14 + Math.min(1, history[index] ** 0.7) * 0.86).toFixed(3)})`);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [phase, level]);

  const seconds = phase === 'recording' && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const label = phase === 'starting' ? 'Opening microphone…' : phase === 'recording' ? 'Listening' : 'Transcribing…';

  return <div className="handwork-dictation" data-phase={phase}>
    <button type="button" className="handwork-dictation-cancel" aria-label="Cancel dictation" title="Cancel dictation" onClick={onCancel}><IconClose size={13} /></button>
    <span className="handwork-sr-only" role="status">{label}</span>
    {phase === 'recording'
      ? <>
        <span ref={wave} className="handwork-dictation-wave" aria-hidden>{Array.from({ length: BARS }, (_, index) => <i key={index} />)}</span>
        <span className="handwork-dictation-time" aria-hidden>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>
      </>
      : <span className="handwork-dictation-label" aria-hidden>{phase === 'starting' ? 'Starting' : 'Transcribing'}</span>}
    <button type="button" className="handwork-dictation-stop" aria-label="Stop and transcribe" title="Stop and transcribe" disabled={phase !== 'recording'} onClick={onStop}>
      {phase === 'recording' ? <span className="handwork-dictation-square" aria-hidden /> : <span className="handwork-dictation-spinner" aria-hidden />}
    </button>
  </div>;
}
