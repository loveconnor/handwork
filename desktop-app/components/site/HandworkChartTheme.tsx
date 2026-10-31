"use client";

import { useEffect, useRef, type ReactNode } from 'react';
import { getInstanceByDom } from 'echarts/core';

// Radar and polar charts use ECharts directly rather than Honest UI's tooltip
// shell. Apply the same theme tokens without replacing their upstream renderer.
export default function HandworkChartTheme({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const applied = new WeakMap<object, string>();
    const sync = () => {
      // ECharts replaces the initial aria-label with its data description.
      // These direct figure children are the upstream radar/polar mounts.
      for (const element of host.querySelectorAll<HTMLElement>('figure > div[_echarts_instance_]')) {
        const chart = getInstanceByDom(element);
        if (!chart || chart.isDisposed()) continue;
        const css = getComputedStyle(element);
        const background = css.getPropertyValue('--background').trim();
        const border = css.getPropertyValue('--border').trim();
        const color = css.color;
        const signature = [background, border, color].join('|');
        if (applied.get(chart) === signature) continue;
        applied.set(chart, signature);
        chart.setOption({ tooltip: {
          backgroundColor: background, borderColor: border, textStyle: { color },
          extraCssText: 'border-radius:var(--hui-radius-3);box-shadow:var(--hui-shadow-floating);',
        } });
      }
    };
    const content = new MutationObserver(sync);
    content.observe(host, { childList: true, subtree: true });
    const theme = new MutationObserver(sync);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    sync();
    return () => { content.disconnect(); theme.disconnect(); };
  }, []);
  return <div ref={root} className="min-w-0">{children}</div>;
}
