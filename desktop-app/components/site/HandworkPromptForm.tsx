"use client";
import { useEffect, useMemo, useRef } from 'react';
import { Renderer } from 'honestui/genui';
import { desktopLibrary } from '@/lib/genui-library';
import { promptFormSource, promptFormValues } from '@/lib/saved-prompts';

/**
 * A saved prompt's `{{fields}}` as Honest AI form inputs, the same controls generated
 * replies use. Values stay in the renderer; each change is reported by field name.
 */
export default function HandworkPromptForm({ names, initial, onChange, preview = false, autoFocus = false }: {
  names: string[]; initial?: Record<string, string>; onChange?: (values: Record<string, string>) => void; preview?: boolean; autoFocus?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The form renders after it loads, and a closing dialog may return focus elsewhere first.
  useEffect(() => {
    if (!autoFocus) return;
    let frames = 0; let handle = 0;
    const focus = () => {
      const field = root.current?.querySelector<HTMLElement>('input, textarea');
      if (field && root.current?.contains(document.activeElement)) return;
      if (field) field.focus();
      if (++frames < 20) handle = requestAnimationFrame(focus);
    };
    handle = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(handle);
  }, [autoFocus]);
  // The source is built once per set of fields so typing never rebuilds the form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const source = useMemo(() => promptFormSource(names, initial), [names.join('\u0000')]);
  return <div ref={root} className="handwork-prompt-form" data-preview={preview || undefined}>
    <Renderer library={desktopLibrary} response={source} publishObservability={false}
      onStateUpdate={state => onChange?.(promptFormValues(state, names))} />
  </div>;
}
