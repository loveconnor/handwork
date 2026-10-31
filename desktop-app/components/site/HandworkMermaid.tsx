"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Check, Code, Copy, Workflow } from 'honestui/icons';
import { Button } from '@/components/ui/button';

type Mermaid = typeof import('mermaid')['default'];
let loading: Promise<Mermaid> | undefined;
// Mermaid is large, so it loads the first time a reply contains a diagram.
const loadMermaid = () => loading ??= import('mermaid').then(module => module.default);

const theme = (): 'dark' | 'neutral' => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral';
let renders = 0;

type Drawing = { svg: string; width: number };
/** Below this share of its drawn size a diagram's labels stop being comfortably readable. */
const legibleScale = 0.85;
/** A top-down flowchart redrawn left to right, so a wide one can grow down the reply instead of across it. */
const sideways = (source: string) => {
  const turned = source.replace(/^(\s*(?:flowchart|graph)\s+)(?:TD|TB)\b/m, '$1LR');
  return turned === source ? undefined : turned;
};

/** Mermaid's colors from the app's own surface tokens, so a diagram reads as
 * part of the reply rather than an embedded image with its own palette. */
function themeVariables() {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const panel = token('--hw-panel', '#ffffff');
  const fill = token('--hui-gray-2', '#f9f9f8');
  const subtle = token('--hui-gray-3', '#f1f0ef');
  const edge = token('--hw-hairline-strong', '#d9d6d0');
  const ink = token('--hui-gray-12', '#21201c');
  const line = token('--hui-gray-9', '#8d8d86');
  return {
    background: panel, mainBkg: fill, primaryColor: fill, secondaryColor: subtle, tertiaryColor: subtle,
    primaryBorderColor: edge, secondaryBorderColor: edge, tertiaryBorderColor: edge, nodeBorder: edge,
    primaryTextColor: ink, secondaryTextColor: ink, tertiaryTextColor: ink, textColor: ink, titleColor: ink,
    lineColor: line, defaultLinkColor: line, clusterBkg: panel, clusterBorder: edge, edgeLabelBackground: panel,
    fontSize: '13px',
  };
}

/**
 * Draws a ```mermaid fence as a figure in the reply. While the reply streams it
 * shows a quiet placeholder; if the diagram cannot be parsed, the source is
 * shown instead, so nothing the model wrote is lost.
 */
export function HandworkMermaid({ source, streaming }: { source: string; streaming: boolean }) {
  const key = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [drawing, setDrawing] = useState<Drawing>();
  const [turned, setTurned] = useState<Drawing>();
  const [room, setRoom] = useState(0);
  const figure = useRef<HTMLElement>(null);
  const [failure, setFailure] = useState('');
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'dark' | 'neutral'>(() => typeof document === 'undefined' ? 'neutral' : theme());

  useEffect(() => {
    const sync = () => setMode(theme());
    window.addEventListener('handwork:theme', sync);
    return () => window.removeEventListener('handwork:theme', sync);
  }, []);

  // The diagram follows the panel's width as it is resized.
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (streaming || !source.trim()) return;
    let current = true;
    void loadMermaid().then(async mermaid => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: themeVariables(), fontFamily: 'inherit', htmlLabels: false });
      // Mermaid draws into a temporary element; each render needs its own id.
      const draw = async (text: string): Promise<Drawing> => {
        const { svg } = await mermaid.render(`handwork-mermaid-${key}-${++renders}`, text);
        // The width Mermaid laid the diagram out at, read from its viewBox.
        return { svg, width: Number(/viewBox="\S+\s+\S+\s+([\d.]+)/.exec(svg)?.[1]) || 0 };
      };
      const drawn = await draw(source.trim());
      const alternate = sideways(source.trim());
      const other = alternate ? await draw(alternate).catch(() => undefined) : undefined;
      if (current) { setDrawing(drawn); setTurned(other); setFailure(''); }
    }).catch(cause => {
      if (current) { setDrawing(undefined); setTurned(undefined); setFailure(cause instanceof Error ? cause.message.split('\n')[0].replace(/[:.\s]+$/, '') + '.' : 'Check the diagram syntax.'); }
    });
    return () => { current = false; };
  }, [source, streaming, mode, key]);

  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);

  // Fit the whole diagram to the panel. When that would shrink a wide top-down
  // flowchart past legibility, its left-to-right drawing is used if it fits better.
  const scale = (d: Drawing) => room && d.width ? Math.min(1, room / d.width) : 1;
  const shown = drawing && turned && scale(drawing) < legibleScale && scale(turned) > scale(drawing) ? turned : drawing;
  const svg = shown?.svg ?? '';
  const showSource = !!failure || view === 'source';
  const state = streaming ? 'streaming' : failure ? 'failed' : view === 'source' ? 'source' : svg ? 'ready' : 'loading';
  const copy = <Button variant="ghost" size="icon-sm" aria-label="Copy diagram source" title={copied ? 'Copied' : 'Copy source'} onClick={() => void navigator.clipboard.writeText(source).then(() => setCopied(true))}>{copied ? <Check aria-hidden width={13} height={13} /> : <Copy aria-hidden width={13} height={13} />}</Button>;
  // A drawn diagram sits in the reply like a figure; only its source looks like code.
  return <figure ref={figure} className="handwork-mermaid" data-state={state}>
    {showSource && <figcaption>
      <span className="handwork-mermaid-label"><Workflow aria-hidden width={13} height={13} />{failure ? 'Diagram · showing source' : 'Diagram source'}</span>
      <span className="handwork-mermaid-actions">
        {svg && !failure && <Button variant="ghost" size="xs" onClick={() => setView('diagram')}><Workflow aria-hidden width={12} height={12} />Diagram</Button>}
        {copy}
      </span>
    </figcaption>}
    {showSource
      ? <pre className="handwork-mermaid-source"><code>{source}</code></pre>
      : svg && !streaming
        // Mermaid's strict mode sanitizes the SVG it returns.
        ? <>
          <div className="handwork-mermaid-diagram" role="img" aria-label="Diagram" style={shown?.width ? { '--handwork-mermaid-width': `${shown.width}px` } as CSSProperties : undefined} dangerouslySetInnerHTML={{ __html: svg }} />
          <span className="handwork-mermaid-actions handwork-mermaid-float">
            <Button variant="ghost" size="icon-sm" aria-label="View diagram source" title="View source" onClick={() => setView('source')}><Code aria-hidden width={13} height={13} /></Button>
            {copy}
          </span>
        </>
        : <div className="handwork-mermaid-pending" role="status"><Workflow aria-hidden width={14} height={14} />{streaming ? 'Drawing diagram…' : 'Preparing diagram…'}</div>}
    {failure && <p className="handwork-mermaid-note" role="status">This diagram could not be drawn: {failure}</p>}
  </figure>;
}
