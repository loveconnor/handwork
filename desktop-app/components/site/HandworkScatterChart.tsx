"use client";

import { ScatterChart, type ChartConfig } from 'honestui/charts';

function propsOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const node = value as Record<string, unknown>;
  return node.props && typeof node.props === 'object' ? node.props as Record<string, unknown> : node;
}

// Preserve the upstream chart primitive while fixing GenUI's dataset-to-series
// mapping: each group needs a Scatter whose dataKey matches its group value.
export default function HandworkScatterChart({ datasets, xLabel, yLabel }: { datasets?: unknown[]; xLabel?: string; yLabel?: string }) {
  const groups = (datasets ?? []).map(propsOf);
  const config: ChartConfig = {};
  const data = groups.flatMap((group, index) => {
    const key = `series${index}`;
    config[key] = { label: String(group.name ?? ''), colors: { light: [`var(--chart-${index % 5 + 1})`] } };
    return (Array.isArray(group.points) ? group.points : []).flatMap(value => {
      const point = propsOf(value);
      return typeof point.x === 'number' && typeof point.y === 'number' ? [{ x: point.x, y: point.y, group: key }] : [];
    });
  });
  if (!data.length) return null;
  return <ScatterChart data={data} config={config} xDataKey="x" yDataKey="y" groupDataKey="group"
    className="h-64 w-full" animation={false} ariaLabel={['ScatterChart', xLabel, yLabel].filter(Boolean).join(' — ')}>
    {groups.map((_, index) => <ScatterChart.Scatter key={index} dataKey={`series${index}`} />)}
    <ScatterChart.XAxis /><ScatterChart.YAxis />
    <ScatterChart.Legend /><ScatterChart.Tooltip />
  </ScatterChart>;
}
