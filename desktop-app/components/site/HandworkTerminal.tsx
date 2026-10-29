"use client";
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { DesktopAPI } from '@/lib/desktop-api';

// The native app's palettes, so a terminal looks the same in both.
const ANSI_DARK = { black: '#1d2428', red: '#f87171', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e8eef2', brightBlack: '#64748b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#f8fafc' };
const ANSI_LIGHT = { black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#4078f2', magenta: '#a626a4', cyan: '#0184bc', white: '#fafafa', brightBlack: '#7c8591', brightRed: '#df6b60', brightGreen: '#68b567', brightYellow: '#d19a2f', brightBlue: '#5c89f5', brightMagenta: '#b54bb3', brightCyan: '#1f9cc9', brightWhite: '#ffffff' };

const isDark = () => document.documentElement.classList.contains('dark');
function theme() {
  const dark = isDark();
  const foreground = getComputedStyle(document.documentElement).getPropertyValue('--hui-color-foreground-base-primary').trim() || (dark ? '#eeeeec' : '#21201c');
  return {
    background: '#00000000', foreground, cursor: foreground, cursorAccent: dark ? '#000000' : '#ffffff',
    selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)', selectionInactiveBackground: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/**
 * A shell in the project. It starts one when given no id, or reattaches to a
 * running one (replaying its recent output), so hiding the panel never stops
 * a dev server. Closing the pane, not unmounting it, ends the shell.
 */
export function HandworkTerminal({ api, workspace, terminalId, focused, onOpened, onExit, onError }: {
  api: DesktopAPI; workspace: string; terminalId?: string; focused?: boolean;
  onOpened: (id: string, shell: string) => void; onExit: (code: number) => void; onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const callbacks = useRef({ onOpened, onExit, onError });
  callbacks.current = { onOpened, onExit, onError };

  useEffect(() => {
    if (!host.current) return;
    const xterm = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', fontSize: 12.5, lineHeight: 1.15, scrollback: 4000, allowTransparency: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--hui-font-family-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: theme(), macOptionIsMeta: navigator.platform.startsWith('Mac'),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    xterm.open(host.current);
    term.current = xterm;
    let id = terminalId;
    let disposed = false;
    const pending: string[] = [];
    const safeFit = () => { try { fit.fit(); } catch { /* Not laid out yet. */ } };
    safeFit();

    const offEvents = api.onEvent(event => {
      const params = event.params as { id?: string; data?: string; exitCode?: number } | undefined;
      if (!params?.id) return;
      // Output can arrive before the id is known; it waits until then.
      if (event.method === 'desktop/terminal-data') { if (!id) pending.push(params.data ?? ''); else if (params.id === id) xterm.write(params.data ?? ''); }
      if (event.method === 'desktop/terminal-exit' && params.id === id) { xterm.write(`\r\n\x1b[2m[Process exited with code ${params.exitCode ?? 0}]\x1b[0m\r\n`); callbacks.current.onExit(params.exitCode ?? 0); }
    });
    const input = xterm.onData(data => { if (id) void api.writeTerminal(id, data).catch(() => {}); });
    const resize = xterm.onResize(({ cols, rows }) => { if (id) void api.resizeTerminal(id, cols, rows).catch(() => {}); });

    void (async () => {
      try {
        if (id) {
          const history = await api.terminalHistory(id);
          if (disposed) return;
          if (history === null) { xterm.write('\x1b[2m[This terminal has closed]\x1b[0m\r\n'); callbacks.current.onExit(0); return; }
          xterm.write(history);
          void api.resizeTerminal(id, xterm.cols, xterm.rows).catch(() => {});
        } else {
          const opened = await api.openTerminal(workspace, Math.max(2, xterm.cols), Math.max(2, xterm.rows));
          if (disposed) { void api.closeTerminal(opened.id); return; }
          id = opened.id;
          for (const chunk of pending.splice(0)) xterm.write(chunk);
          callbacks.current.onOpened(opened.id, opened.shell);
        }
      } catch (cause) {
        callbacks.current.onError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause));
      }
    })();

    const observer = new ResizeObserver(() => safeFit());
    observer.observe(host.current);
    // Follow the app's theme as it changes.
    const themeWatch = new MutationObserver(() => { xterm.options.theme = theme(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    return () => {
      disposed = true;
      observer.disconnect(); themeWatch.disconnect(); offEvents(); input.dispose(); resize.dispose();
      xterm.dispose(); term.current = null;
    };
    // A terminal view binds to one shell for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (focused) term.current?.focus(); }, [focused]);

  return <div ref={host} className="handwork-terminal" />;
}
