"use client";

import { useEffect, useId, useState } from 'react';
import { Check, Code, Copy, Workflow } from 'honestui/icons';
import { Button } from '@/components/ui/button';

type Mermaid = typeof import('mermaid')['default'];
let loading: Promise<Mermaid> | undefined;
// Mermaid is large, so it loads the first time a reply contains a diagram.
const loadMermaid = () => loading ??= import('mermaid').then(module => module.default);

const theme = (): 'dark' | 'neutral' => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral';
let renders = 0;

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
  const [svg, setSvg] = useState('');
  const [failure, setFailure] = useState('');
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'dark' | 'neutral'>(() => typeof document === 'undefined' ? 'neutral' : theme());

  useEffect(() => {
    const sync = () => setMode(theme());
    window.addEventListener('handwork:theme', sync);
    return () => window.removeEventListener('handwork:theme', sync);
  }, []);

  useEffect(() => {
    if (streaming || !source.trim()) return;
    let current = true;
    void loadMermaid().then(async mermaid => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables: themeVariables(), fontFamily: 'inherit', htmlLabels: false });
      // Mermaid draws into a temporary element; each render needs its own id.
      const { svg: drawn } = await mermaid.render(`handwork-mermaid-${key}-${++renders}`, source.trim());
      if (current) { setSvg(drawn); setFailure(''); }
    }).catch(cause => {
      if (current) { setSvg(''); setFailure(cause instanceof Error ? cause.message.split('\n')[0].replace(/[:.\s]+$/, '') + '.' : 'Check the diagram syntax.'); }
    });
    return () => { current = false; };
  }, [source, streaming, mode, key]);

  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);

  const showSource = !!failure || view === 'source';
  const state = streaming ? 'streaming' : failure ? 'failed' : view === 'source' ? 'source' : svg ? 'ready' : 'loading';
  const copy = <Button variant="ghost" size="icon-sm" aria-label="Copy diagram source" title={copied ? 'Copied' : 'Copy source'} onClick={() => void navigator.clipboard.writeText(source).then(() => setCopied(true))}>{copied ? <Check aria-hidden width={13} height={13} /> : <Copy aria-hidden width={13} height={13} />}</Button>;
  // A drawn diagram sits in the reply like a figure; only its source looks like code.
  return <figure className="handwork-mermaid" data-state={state}>
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
          <div className="handwork-mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
          <span className="handwork-mermaid-actions handwork-mermaid-float">
            <Button variant="ghost" size="icon-sm" aria-label="View diagram source" title="View source" onClick={() => setView('source')}><Code aria-hidden width={13} height={13} /></Button>
            {copy}
          </span>
        </>
        : <div className="handwork-mermaid-pending" role="status"><Workflow aria-hidden width={14} height={14} />{streaming ? 'Drawing diagram…' : 'Preparing diagram…'}</div>}
    {failure && <p className="handwork-mermaid-note" role="status">This diagram could not be drawn: {failure}</p>}
  </figure>;
}
