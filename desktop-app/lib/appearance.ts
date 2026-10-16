import type { DesktopPreferences } from './desktop-api';
export function applyAppearance(preferences: Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize'>) {
  const root = document.documentElement;
  const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark); root.classList.toggle('light', !dark);
  root.dataset.theme = dark ? 'dark' : 'light'; root.dataset.style = 'modern';
  root.style.setProperty('--handwork-ui-font-size', `${preferences.uiFontSize}px`);
  root.style.setProperty('--hui-font-size-regular', `${preferences.uiFontSize}px`);
  root.style.setProperty('--hui-font-size-small', `${preferences.uiFontSize - 1}px`);
  root.style.setProperty('--handwork-code-font-size', `${preferences.codeFontSize}px`);
  try { localStorage.setItem('bui-theme', preferences.theme); localStorage.setItem('handwork-appearance', JSON.stringify(preferences)); } catch { /* Preferences still apply for this window. */ }
  window.dispatchEvent(new Event('handwork:theme'));
}
export function savedAppearance(): Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize'> {
  try { const data = JSON.parse(localStorage.getItem('handwork-appearance') || '{}'); const theme = localStorage.getItem('bui-theme'); return { theme: theme === 'dark' || theme === 'light' ? theme : 'system', uiFontSize: Number(data.uiFontSize) || 14, codeFontSize: Number(data.codeFontSize) || 13 }; }
  catch { return { theme: 'system', uiFontSize: 14, codeFontSize: 13 }; }
}
