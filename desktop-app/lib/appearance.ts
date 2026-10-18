import type { DesktopPreferences } from './desktop-api';
export function appearanceTokens(uiFontSize: number): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, baseSize, baseLine] of [
    ['micro', 10, 12], ['mini', 11, 14], ['small', 13, 16],
    ['control', 13, 16], ['regular', 14, 20], ['large', 16, 24],
  ] as const) {
    const size = Math.max(10, baseSize + uiFontSize - 14);
    tokens[`--hui-font-size-${name}`] = `${size}px`;
    tokens[`--hui-line-height-${name}`] = `${Math.max(size + 2, baseLine + uiFontSize - 14)}px`;
  }
  return tokens;
}

export function applyAppearance(preferences: Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize'>) {
  const root = document.documentElement;
  const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const nextTheme = dark ? 'dark' : 'light';
  const transitionOverride = root.dataset.theme !== nextTheme ? document.createElement('style') : undefined;
  if (transitionOverride) {
    transitionOverride.textContent = '*,*::before,*::after{transition:none !important}';
    document.head.append(transitionOverride);
  }
  root.classList.toggle('dark', dark); root.classList.toggle('light', !dark);
  root.dataset.theme = dark ? 'dark' : 'light'; root.dataset.style = 'modern';
  root.style.setProperty('--handwork-ui-font-size', `${preferences.uiFontSize}px`);
  for (const [name, value] of Object.entries(appearanceTokens(preferences.uiFontSize))) root.style.setProperty(name, value);
  root.style.setProperty('--handwork-code-font-size', `${preferences.codeFontSize}px`);
  try { localStorage.setItem('bui-theme', preferences.theme); localStorage.setItem('handwork-appearance', JSON.stringify(preferences)); } catch { /* Preferences still apply for this window. */ }
  window.dispatchEvent(new Event('handwork:theme'));
  if (transitionOverride) {
    // Commit the new colors while transitions are disabled, then restore hover/press motion.
    void root.offsetHeight;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => transitionOverride.remove()));
  }
}
export function savedAppearance(): Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize'> {
  try { const data = JSON.parse(localStorage.getItem('handwork-appearance') || '{}'); const theme = localStorage.getItem('bui-theme'); return { theme: theme === 'dark' || theme === 'light' ? theme : 'system', uiFontSize: Number(data.uiFontSize) || 14, codeFontSize: Number(data.codeFontSize) || 13 }; }
  catch { return { theme: 'system', uiFontSize: 14, codeFontSize: 13 }; }
}
