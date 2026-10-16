import { honestChatLibrary } from 'honestui/genui';
import { createElement } from 'react';
import HandworkScatterChart from '@/components/site/HandworkScatterChart';

const scatter = honestChatLibrary.components.ScatterChart;

// Use every upstream component; model-selected actions still receive no native privileges.
export const desktopLibrary = { ...honestChatLibrary, components: {
  ...honestChatLibrary.components,
  ScatterChart: { ...scatter, component: (input: Parameters<typeof scatter.component>[0]) => {
    return createElement(HandworkScatterChart, input.props);
  } },
} };
