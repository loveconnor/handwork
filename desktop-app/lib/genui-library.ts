import { honestChatLibrary } from 'honestui/genui';
import { createElement } from 'react';
import HandworkScatterChart from '@/components/site/HandworkScatterChart';

const scatter = honestChatLibrary.components.ScatterChart;
// HtmlVisual needs inline scripts, which the packaged renderer CSP blocks; see electron/genui-components.mjs.
const { HtmlVisual: _htmlVisual, ...components } = honestChatLibrary.components;

// Use every other upstream component; model-selected actions still receive no native privileges.
export const desktopLibrary = { ...honestChatLibrary, components: {
  ...components,
  ScatterChart: { ...scatter, component: (input: Parameters<typeof scatter.component>[0]) => {
    return createElement(HandworkScatterChart, input.props);
  } },
} };
