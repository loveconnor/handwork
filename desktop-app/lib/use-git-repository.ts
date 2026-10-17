"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopAPI, GitEvent, GitFailure, GitOperation, GitRepositoryState, GitResult } from './desktop-api';

export const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export type GitProgress = { operation: GitOperation; step?: string; percent?: number };
export type GitNotice = { kind: 'error'; failure: GitFailure; operation: GitOperation; retry?: () => void } | { kind: 'success'; text: string };

/**
 * The selected project's repository: refreshed with the changes poll (`tick`), after every
 * operation, and when any chat changes the same repository.
 */
export function useGitRepository(api: DesktopAPI | undefined, workspace: string, tick?: number, onSettled?: () => void) {
  const [state, setState] = useState<GitRepositoryState>();
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState<GitOperation | null>(null);
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [notice, setNotice] = useState<GitNotice>();
  const loading = useRef(false), queued = useRef(false);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  const repository = useRef('');
  repository.current = state?.kind === 'repository' ? state.repository : '';

  const load = useCallback(async () => {
    if (!api || !workspace) return;
    if (loading.current) { queued.current = true; return; }
    loading.current = true;
    try {
      const next = await api.gitState(workspace);
      if (next.workspace === workspace) { setState(next); setLoadError(''); }
    } catch (cause) { setLoadError(errorText(cause)); }
    finally {
      loading.current = false;
      if (queued.current) { queued.current = false; void load(); }
    }
  }, [api, workspace]);

  useEffect(() => { void load(); }, [load, tick]);

  useEffect(() => api?.onEvent(event => {
    if (event.method !== 'desktop/git') return;
    const params = event.params as GitEvent;
    if (!params || params.repository !== repository.current) return;
    if (params.phase === 'end') { setProgress(null); void load(); }
    else setProgress({ operation: params.operation, step: params.step, percent: params.percent });
  }), [api, load]);

  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const timer = setTimeout(() => setNotice(current => current === notice ? undefined : current), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const run = useCallback(async function run(operation: GitOperation, action: () => Promise<GitResult>, success?: (result: GitResult) => string | undefined): Promise<GitResult | undefined> {
    if (!api) return;
    setPending(operation);
    setNotice(undefined);
    try {
      const result = await action();
      if (result.state?.workspace === workspace) setState(result.state);
      if (result.ok) {
        const text = success?.(result);
        if (text) setNotice({ kind: 'success', text });
      } else if (result.error) {
        // A changed review is not retried blindly; the person checks the refreshed preview.
        setNotice({ kind: 'error', operation, failure: result.error, retry: result.changed ? undefined : () => void run(operation, action, success) });
      }
      return result;
    } catch (cause) {
      setNotice({ kind: 'error', operation, failure: { code: 'unknown', title: 'Something went wrong', message: errorText(cause), actions: ['refresh'] } });
    } finally {
      setPending(null);
      setProgress(null);
      settled.current?.();
    }
  }, [api, workspace]);

  const current = state?.workspace === workspace ? state : undefined;
  const busy = pending ?? (current?.kind === 'repository' ? current.busy : null);
  return { state: current, loadError, pending, busy, progress, notice, setNotice, refresh: load, run };
}

export type GitRepository = ReturnType<typeof useGitRepository>;
