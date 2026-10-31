"use client";

import { Component, lazy, Suspense, type ReactNode } from 'react';
import { ProseCodeBlock } from 'honestui/ai/prose-code-block';

const GeneratedView = lazy(() => import('./HandworkGeneratedView'));

// This boundary must wrap the lazy import, not live inside the module that can fail to load.
class InteractiveBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div>
      <p role="alert">This interactive view could not load. You can keep chatting or copy its source below.</p>
      <ProseCodeBlock label="Honest AI source" code={this.props.source} />
    </div>;
    return this.props.children;
  }
}

export default function HandworkInteractiveView(props: { source: string; streaming: boolean; onSend: (text: string) => Promise<void> }) {
  return <InteractiveBoundary source={props.source}>
    <Suspense fallback={<p role="status">Loading interactive view…</p>}>
      <GeneratedView {...props} />
    </Suspense>
  </InteractiveBoundary>;
}
