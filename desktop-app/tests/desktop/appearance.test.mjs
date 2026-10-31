import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { appearanceTokens, applyAppearance } from '../../lib/appearance.ts';

const preferences = { theme: 'dark', uiFontSize: 20, codeFontSize: 15 };

test('interface text size scales control and small-text tokens with their line heights', () => {
  const normal = appearanceTokens(14);
  assert.equal(normal['--hui-font-size-mini'], '11px');
  assert.equal(normal['--hui-font-size-control'], '13px');
  assert.equal(normal['--hui-line-height-regular'], '20px');
  const large = appearanceTokens(20);
  assert.equal(large['--hui-font-size-mini'], '17px');
  assert.equal(large['--hui-font-size-control'], '19px');
  assert.equal(large['--hui-line-height-mini'], '20px');
  assert.equal(large['--hui-line-height-control'], '22px');
  for (const [key, value] of Object.entries(appearanceTokens(11))) if (key.includes('font-size')) assert.ok(parseFloat(value) >= 10);
});

test('tab and menu typography scales at 20px without changing 14px density', () => {
  const css = readFileSync(new URL('../../desktop/desktop.css', import.meta.url), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const value = (selector, property, size) => {
    const rule = rules.find(([, selectors]) => selectors.trim().split(/,\s*/).includes(selector));
    assert.ok(rule, selector);
    const declaration = rule[2].match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1];
    assert.ok(declaration, `${selector} ${property}`);
    assert.match(declaration, /var\(--hui-/, `${selector} must use appearance tokens`);
    const resolved = declaration.replace(/var\((--hui-[\w-]+),\s*[\d.]+px\)/g, (_, token) => appearanceTokens(size)[token]);
    const calculation = resolved.match(/^calc\(([\d.]+)px ([+-]) ([\d.]+)px\)$/);
    return calculation ? Number(calculation[1]) + (calculation[2] === '+' ? 1 : -1) * Number(calculation[3]) : parseFloat(resolved);
  };
  for (const [selector, font, line] of [
    ['.handwork-tab-label', 12.5, 28],
    ['.handwork-model-options [data-slot="menu-label"]', 11, 16],
    ['.handwork-model-options [role^="menuitem"]', 13, 18],
    ['.handwork-option-submenu [role^="menuitem"]', 13, 18],
    ['.handwork-option-description', 12, 17],
    ['.handwork-option-value', 12],
    ['.handwork-composer .handwork-model-trigger', 12],
    ['.handwork-composer [data-slot="select-trigger"]', 12],
    ['.handwork-changes-tabs > button', 12, 16],
    ['.handwork-changes-tab-count', 10.5, 16],
    ['.handwork-change-group-count', 10.5, 16],
    ['.handwork-composer-menu [data-slot="menu-shortcut"]', 12],
  ]) {
    for (const size of [14, 20]) {
      assert.equal(value(selector, 'font-size', size), font + size - 14, selector);
      if (line) assert.equal(value(selector, 'line-height', size), line + size - 14, selector);
    }
  }
  for (const size of [14, 20]) {
    assert.equal(value('.handwork-tab', 'height', size), size + 14);
    assert.equal(value('.handwork-tab-label', 'height', size), size + 14);
  }
});

test('theme changes suppress transitions through the next paint and restore them after rapid toggles', () => {
  const descriptors = Object.fromEntries(['document', 'window', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const sheets = new Set(); const frames = []; const tokens = new Map(); const classes = new Set(['light']);
  let flushes = 0;
  const root = {
    dataset: { theme: 'light' },
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    style: { setProperty: (name, value) => tokens.set(name, value) },
    get offsetHeight() { assert.ok(sheets.size > 0); flushes++; return 600; },
  };
  try {
    const values = {
      document: { documentElement: root, head: { append: sheet => sheets.add(sheet) }, createElement: () => ({ textContent: '', remove() { sheets.delete(this); } }) },
      window: { requestAnimationFrame: callback => frames.push(callback), dispatchEvent() {}, matchMedia: () => ({ matches: false }) },
      localStorage: { setItem() {} },
    };
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    applyAppearance(preferences);
    assert.ok(classes.has('dark')); assert.ok(!classes.has('light'));
    assert.equal(tokens.get('--hui-font-size-control'), '19px');
    assert.equal(sheets.size, 1);
    assert.match([...sheets][0].textContent, /transition:none !important/);
    applyAppearance(preferences);
    assert.equal(sheets.size, 1, 'unchanged themes must not repeatedly suppress interaction transitions');
    applyAppearance({ ...preferences, theme: 'light' });
    assert.equal(sheets.size, 2);
    assert.equal(flushes, 2);
    frames.shift()();
    assert.equal(sheets.size, 2, 'keep the override until after the next paint');
    while (frames.length) frames.shift()();
    assert.equal(sheets.size, 0, 'restore transitions after every pending theme change');
  } finally {
    for (const [name, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
  }
});
