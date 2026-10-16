"use client";
import { Component, useState, type ReactNode } from 'react';
import { Markdown } from 'honestui/ai/markdown';
import { MapServicesContext, Renderer } from 'honestui/genui';
import { desktopMapServices } from '@/lib/map-services';
import { desktopLibrary } from '@/lib/genui-library';
import { actionPrompt } from '@/lib/genui-action';
import HandworkChartTheme from './HandworkChartTheme';

class GeneratedBoundary extends Component<{ children: ReactNode; source: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div role="alert"><p>This generated view could not render. Its source is shown below.</p><Markdown>{'```text\n' + this.props.source + '\n```'}</Markdown></div> : this.props.children;
  }
}

export default function GeneratedView({ source, streaming, onSend }: { source: string; streaming: boolean; onSend: (text: string) => Promise<void> }) {
  const [error, setError] = useState('');
  return <GeneratedBoundary source={source}>
    <MapServicesContext.Provider value={desktopMapServices}><HandworkChartTheme><Renderer library={desktopLibrary} response={source} isStreaming={streaming} publishObservability={false}
      onError={errors => setError(errors.filter(error => error.severity !== 'warning').map(error => error.message).join('\n'))}
      onAction={event => {
        const prompt = actionPrompt(event);
        if (!prompt) { setError('This action is unavailable in Handwork. Ask for it in the prompt field.'); return; }
        void onSend(prompt).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
      }} /></HandworkChartTheme></MapServicesContext.Provider>
    {error && <div role="alert"><p>{error}</p><Markdown>{'```text\n' + source + '\n```'}</Markdown></div>}
  </GeneratedBoundary>;
}
