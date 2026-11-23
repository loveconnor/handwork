"use client";
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { DesktopAPI } from '@/lib/desktop-api';

// Tuned to the app's neutrals: ink and graphite for black and white, and hues
// that sit beside the status colours (a touch less saturated than Tailwind or
// One Dark) while staying far enough apart to tell red, yellow and magenta,
// or green and cyan, apart at a glance. Light hues hold >= 4.5:1 on the white
// panel; dark ones are soft pastels on graphite.
const ANSI_DARK = { black: '#3a3a3d', red: '#e5806f', green: '#82c59b', yellow: '#e2bd6f', blue: '#8fb1e6', magenta: '#c9a2e3', cyan: '#78c3c8', white: '#c4c4c9', brightBlack: '#8d8d93', brightRed: '#f0a194', brightGreen: '#a3d8b6', brightYellow: '#eed49a', brightBlue: '#b2caf0', brightMagenta: '#dcc0ef', brightCyan: '#9fd6da', brightWhite: '#ededef' };
const ANSI_LIGHT = { black: '#21201c', red: '#bb3e2d', green: '#2f7a4c', yellow: '#91660f', blue: '#3563ae', magenta: '#8b4a9f', cyan: '#1d7682', white: '#a8a7a1', brightBlack: '#82827c', brightRed: '#d0533f', brightGreen: '#3f8f5d', brightYellow: '#ab7c1f', brightBlue: '#4c7bc6', brightMagenta: '#a061b4', brightCyan: '#2b8b97', brightWhite: '#cfceca' };

const isDark = () => document.documentElement.classList.contains('dark');
function theme() {
  const dark = isDark();
  const styles = getComputedStyle(document.documentElement);
  const foreground = styles.getPropertyValue('--hui-color-foreground-base-primary').trim() || (dark ? '#ededef' : '#21201c');
  // The GPU renderer paints its own background, so it takes the panel's colour.
  const background = styles.getPropertyValue('--hw-panel').trim() || (dark ? '#171718' : '#ffffff');
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)', selectionInactiveBackground: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  };
}

/** The editor's code size, so a terminal reads at the same scale as the file above it. */
const codeFontSize = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--handwork-code-font-size')) || 13;

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
      cursorBlink: true, cursorStyle: 'bar', cursorInactiveStyle: 'bar', cursorWidth: 2, fontSize: codeFontSize(), lineHeight: 1.35, scrollback: 4000,
      // Colours a program pairs badly (bright white on a red badge, white on the light panel) are nudged until they read.
      minimumContrastRatio: 4.5,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--hui-font-family-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: theme(), macOptionIsMeta: navigator.platform.startsWith('Mac'),
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    xterm.open(host.current);
    // Drawing on the GPU keeps a terminal coming back with its history, or a burst of output, from
    // stalling the window; without WebGL it stays on the DOM renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      xterm.loadAddon(webgl);
    } catch { /* The DOM renderer is the fallback. */ }
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
    // Follow the app's theme and code size as they change.
    const themeWatch = new MutationObserver(() => {
      xterm.options.theme = theme();
      if (xterm.options.fontSize !== codeFontSize()) { xterm.options.fontSize = codeFontSize(); safeFit(); }
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

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
