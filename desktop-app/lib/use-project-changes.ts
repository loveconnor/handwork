"use client";

import { useEffect, useState } from 'react';
import type { DesktopAPI, ProjectChangesSnapshot } from './desktop-api';

export function useProjectChanges(api: DesktopAPI | undefined, workspace: string) {
  const [state, setState] = useState<{ workspace: string; snapshot?: ProjectChangesSnapshot; error?: string; loading: boolean }>({ workspace: '', loading: false });
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let cancelled = false, pending = false;
    let timer: ReturnType<typeof setTimeout>;
    setState(current => current.workspace === workspace ? current : { workspace, loading: !!api && !!workspace });
    if (!api || !workspace) return;
    const load = async () => {
      if (pending || cancelled) return;
      clearTimeout(timer);
      if (document.hidden) { timer = setTimeout(load, 2000); return; }
      pending = true;
      try {
        const snapshot = await api.projectChanges();
        if (cancelled) return;
        if (snapshot.workspace !== workspace) throw new Error('Waiting for the selected project.');
        setState({ workspace, snapshot, loading: false });
      } catch (cause) {
        if (!cancelled) setState(current => ({ ...current, workspace, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      } finally {
        pending = false;
        if (!cancelled) timer = setTimeout(load, 2000);
      }
    };
    const focus = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    void load();
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [api, workspace, refreshKey]);
  return { ...(state.workspace === workspace ? state : { workspace, loading: true }), refresh: () => setRefreshKey(key => key + 1) };
}
