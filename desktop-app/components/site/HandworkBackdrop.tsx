"use client";
import { useEffect, useRef, useState } from 'react';
import { ShaderView, shaderInput, type ShaderId } from '@/lib/shaders';

const shaders: readonly string[] = ['aurora', 'silk', 'nebula', 'dune'];
const watched = ['data-theme', 'data-backdrop', 'data-backdrop-strength', 'data-light-palette', 'data-dark-palette'];
const current = () => { const value = document.documentElement.dataset.backdrop || 'none'; return shaders.includes(value) ? value as ShaderId : null; };

/**
 * The chosen shader, painted once behind the whole window. Only the frame
 * (sidebar and title row) shows it; cards stay solid above it. It follows the
 * appearance attributes on <html>, so a choice in Settings applies instantly.
 */
export function HandworkBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shader, setShader] = useState<ShaderId | null>(null);
  // A failure belongs to one shader and one attempt: choosing a shader again,
  // or the retry below, tries afresh instead of staying dark for the session.
  const [failed, setFailed] = useState<{ shader: ShaderId; attempt: number } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    setShader(current());
    const observer = new MutationObserver(() => setShader(current()));
    observer.observe(root, { attributes: true, attributeFilter: watched });
    return () => observer.disconnect();
  }, []);

  const broken = !!shader && failed?.shader === shader && failed.attempt === attempt;
  useEffect(() => {
    if (!broken || attempt >= 4) return;
    const retry = window.setTimeout(() => setAttempt(value => value + 1), 4000);
    return () => window.clearTimeout(retry);
  }, [broken, attempt]);

  useEffect(() => {
    const root = document.documentElement;
    if (!shader || broken || !canvas.current) { root.removeAttribute('data-backdrop-live'); return; }
    let view: ShaderView;
    try { view = new ShaderView(canvas.current, shader, shaderInput(shader, root.dataset.backdropStrength), { scale: 0.5, fps: 30 }); }
    catch { setFailed({ shader, attempt }); return; }
    root.setAttribute('data-backdrop-live', '');
    // Theme, palette and strength changes recolour the running shader in place.
    const observer = new MutationObserver(() => view.update(shaderInput(shader, root.dataset.backdropStrength)));
    observer.observe(root, { attributes: true, attributeFilter: watched });
    return () => { observer.disconnect(); view.destroy(); root.removeAttribute('data-backdrop-live'); };
  }, [shader, broken, attempt]);

  if (!shader || broken) return null;
  return <canvas key={`${shader}-${attempt}`} ref={canvas} className="handwork-backdrop" aria-hidden />;
}
