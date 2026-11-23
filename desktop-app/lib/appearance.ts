import type { AccentColor, Backdrop, BackdropStrength, DarkPalette, DesktopPreferences, LightPalette } from './desktop-api';

export type Appearance = Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize' | 'accent' | 'lightPalette' | 'darkPalette' | 'backdrop' | 'backdropStrength'>;
const accents: AccentColor[] = ['ink', 'blue', 'violet', 'green', 'amber', 'rose'];
const lightPalettes: LightPalette[] = ['sand', 'paper', 'mist'];
const darkPalettes: DarkPalette[] = ['graphite', 'slate', 'black'];
const backdrops: Backdrop[] = ['none', 'aurora', 'silk', 'nebula', 'dune'];
const strengths: BackdropStrength[] = ['subtle', 'balanced', 'vivid'];
const pick = <T extends string>(list: readonly T[], value: unknown, fallback: T): T => list.includes(value as T) ? value as T : fallback;

export function appearanceTokens(uiFontSize: number): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [name, baseSize, baseLine] of [
    ['micro', 10, 12], ['mini', 11, 14], ['small', 13, 16],
    ['control', 14, 16], ['control-sm', 13, 16], ['control-xs', 12, 16],
    ['regular', 14, 20], ['large', 16, 24],
  ] as const) {
    const size = Math.max(10, baseSize + uiFontSize - 14);
    tokens[`--hui-font-size-${name}`] = `${size}px`;
    tokens[`--hui-line-height-${name}`] = `${Math.max(size + 2, baseLine + uiFontSize - 14)}px`;
  }
  return tokens;
}

export function applyAppearance(preferences: Pick<DesktopPreferences, 'theme' | 'uiFontSize' | 'codeFontSize'> & Partial<Appearance>) {
  const root = document.documentElement;
  const accent = pick(accents, preferences.accent, 'ink');
  const lightPalette = pick(lightPalettes, preferences.lightPalette, 'sand');
  const darkPalette = pick(darkPalettes, preferences.darkPalette, 'graphite');
  const backdrop = pick(backdrops, preferences.backdrop, 'none');
  const backdropStrength = pick(strengths, preferences.backdropStrength, 'balanced');
  const dark = preferences.theme === 'dark' || (preferences.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const nextTheme = dark ? 'dark' : 'light';
  const changing = root.dataset.theme !== nextTheme || root.dataset.accent !== accent || root.dataset.lightPalette !== lightPalette || root.dataset.darkPalette !== darkPalette;
  const transitionOverride = changing ? document.createElement('style') : undefined;
  if (transitionOverride) {
    transitionOverride.textContent = '*,*::before,*::after{transition:none !important}';
    document.head.append(transitionOverride);
  }
  root.classList.toggle('dark', dark); root.classList.toggle('light', !dark);
  root.dataset.theme = nextTheme;
  root.dataset.accent = accent;
  root.dataset.lightPalette = lightPalette;
  root.dataset.darkPalette = darkPalette;
  root.dataset.backdrop = backdrop;
  root.dataset.backdropStrength = backdropStrength;
  root.style.setProperty('--handwork-ui-font-size', `${preferences.uiFontSize}px`);
  for (const [name, value] of Object.entries(appearanceTokens(preferences.uiFontSize))) root.style.setProperty(name, value);
  root.style.setProperty('--handwork-code-font-size', `${preferences.codeFontSize}px`);
  const saved: Appearance = { theme: preferences.theme, uiFontSize: preferences.uiFontSize, codeFontSize: preferences.codeFontSize, accent, lightPalette, darkPalette, backdrop, backdropStrength };
  try { localStorage.setItem('bui-theme', preferences.theme); localStorage.setItem('handwork-appearance', JSON.stringify(saved)); } catch { /* Preferences still apply for this window. */ }
  window.dispatchEvent(new Event('handwork:theme'));
  if (transitionOverride) {
    // Commit the new colors while transitions are disabled, then restore hover/press motion.
    void root.offsetHeight;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => transitionOverride.remove()));
  }
}
export function savedAppearance(): Appearance {
  const fallback: Appearance = { theme: 'system', uiFontSize: 14, codeFontSize: 13, accent: 'ink', lightPalette: 'sand', darkPalette: 'graphite', backdrop: 'none', backdropStrength: 'balanced' };
  try {
    const data = JSON.parse(localStorage.getItem('handwork-appearance') || '{}'); const theme = localStorage.getItem('bui-theme');
    return {
      theme: theme === 'dark' || theme === 'light' ? theme : 'system', uiFontSize: Number(data.uiFontSize) || 14, codeFontSize: Number(data.codeFontSize) || 13,
      accent: pick(accents, data.accent, 'ink'), lightPalette: pick(lightPalettes, data.lightPalette, 'sand'), darkPalette: pick(darkPalettes, data.darkPalette, 'graphite'),
      backdrop: pick(backdrops, data.backdrop, 'none'), backdropStrength: pick(strengths, data.backdropStrength, 'balanced'),
    };
  } catch { return fallback; }
}
