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

/**
 * Draws a ```mermaid fence. While the reply streams, or if the diagram cannot be
 * parsed, the source is shown instead, so nothing the model wrote is lost.
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
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: mode, fontFamily: 'inherit', htmlLabels: false });
      // Mermaid draws into a temporary element; each render needs its own id.
      const { svg: drawn } = await mermaid.render(`handwork-mermaid-${key}-${++renders}`, source.trim());
      if (current) { setSvg(drawn); setFailure(''); }
    }).catch(cause => {
      if (current) { setSvg(''); setFailure(cause instanceof Error ? cause.message.split('\n')[0].replace(/[:.\s]+$/, '') + '.' : 'Check the diagram syntax.'); }
    });
    return () => { current = false; };
  }, [source, streaming, mode, key]);

  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(timer); }, [copied]);

  const showSource = streaming || !!failure || view === 'source' || !svg;
  return <figure className="handwork-mermaid" data-state={streaming ? 'streaming' : failure ? 'failed' : svg ? 'ready' : 'loading'}>
    <figcaption>
      <span className="handwork-mermaid-label"><Workflow aria-hidden width={13} height={13} />{streaming ? 'Diagram · drawing when the reply finishes' : failure ? 'Diagram · showing source' : 'Diagram'}</span>
      <span className="handwork-mermaid-actions">
        {svg && !failure && !streaming && <Button variant="ghost" size="xs" aria-pressed={view === 'source'} onClick={() => setView(value => value === 'source' ? 'diagram' : 'source')}>{view === 'source' ? <Workflow aria-hidden width={12} height={12} /> : <Code aria-hidden width={12} height={12} />}{view === 'source' ? 'Diagram' : 'Source'}</Button>}
        <Button variant="ghost" size="xs" aria-label="Copy diagram source" onClick={() => void navigator.clipboard.writeText(source).then(() => setCopied(true))}>{copied ? <Check aria-hidden width={12} height={12} /> : <Copy aria-hidden width={12} height={12} />}{copied ? 'Copied' : 'Copy'}</Button>
      </span>
    </figcaption>
    {showSource
      ? <pre className="handwork-mermaid-source"><code>{source}</code></pre>
      // Mermaid's strict mode sanitizes the SVG it returns.
      : <div className="handwork-mermaid-diagram" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />}
    {failure && <p className="handwork-mermaid-note" role="status">This diagram could not be drawn: {failure}</p>}
  </figure>;
}
