"use client";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Check } from 'honestui/icons';
import type { AccentColor, Backdrop, BackdropStrength, DarkPalette, DesktopPreferences, LightPalette } from '@/lib/desktop-api';
import { ShaderView, shaderInput, type ShaderId } from '@/lib/shaders';

type Theme = DesktopPreferences['theme'];
type Keys = 'theme' | 'accent' | 'lightPalette' | 'darkPalette' | 'backdrop' | 'backdropStrength';
type Patch = Partial<Pick<DesktopPreferences, Keys>>;
type Swatch = { chrome: string; panel: string; line: string; text: string; muted: string };

/* Preview colors mirror the palette tokens in surface.css. */
const lightPalettes: { id: LightPalette; label: string; note: string; swatch: Swatch }[] = [
  { id: 'sand', label: 'Sand', note: 'Warm', swatch: { chrome: '#f6f5f2', panel: '#ffffff', line: '#e8e6e1', text: '#21201c', muted: '#d9d6d0' } },
  { id: 'paper', label: 'Paper', note: 'Neutral', swatch: { chrome: '#f4f4f5', panel: '#ffffff', line: '#e7e7e9', text: '#1d1d1f', muted: '#d6d6d9' } },
  { id: 'mist', label: 'Mist', note: 'Cool', swatch: { chrome: '#f2f4f7', panel: '#ffffff', line: '#e2e6ec', text: '#1a1f27', muted: '#d1d8e0' } },
];
const darkPalettes: { id: DarkPalette; label: string; note: string; swatch: Swatch }[] = [
  { id: 'graphite', label: 'Graphite', note: 'Neutral', swatch: { chrome: '#0f0f10', panel: '#171718', line: '#262628', text: '#ededef', muted: '#39393c' } },
  { id: 'slate', label: 'Slate', note: 'Cool', swatch: { chrome: '#0d1014', panel: '#14181e', line: '#232930', text: '#e9edf2', muted: '#363e49' } },
  { id: 'black', label: 'Black', note: 'True black', swatch: { chrome: '#000000', panel: '#0a0a0a', line: '#1c1c1c', text: '#eeeeee', muted: '#2f2f2f' } },
];
const accents: { id: AccentColor; label: string; light: string; dark: string }[] = [
  { id: 'ink', label: 'Ink', light: '#21201c', dark: '#ededef' },
  { id: 'blue', label: 'Blue', light: 'oklch(0.55 0.16 256)', dark: 'oklch(0.74 0.12 256)' },
  { id: 'violet', label: 'Violet', light: 'oklch(0.53 0.17 292)', dark: 'oklch(0.74 0.12 292)' },
  { id: 'green', label: 'Green', light: 'oklch(0.52 0.115 160)', dark: 'oklch(0.76 0.12 160)' },
  { id: 'amber', label: 'Amber', light: 'oklch(0.58 0.14 55)', dark: 'oklch(0.79 0.12 70)' },
  { id: 'rose', label: 'Rose', light: 'oklch(0.56 0.17 12)', dark: 'oklch(0.74 0.13 12)' },
];

const backdrops: { id: Backdrop; label: string; note: string }[] = [
  { id: 'none', label: 'None', note: 'Flat' },
  { id: 'aurora', label: 'Aurora', note: 'Drifting light' },
  { id: 'silk', label: 'Silk', note: 'Folded satin' },
  { id: 'nebula', label: 'Nebula', note: 'Wandering color' },
  { id: 'dune', label: 'Dune', note: 'Wind and sand' },
];
const strengths: { id: BackdropStrength; label: string }[] = [{ id: 'subtle', label: 'Subtle' }, { id: 'balanced', label: 'Balanced' }, { id: 'vivid', label: 'Vivid' }];

/** A live shader tile, drawn in the current theme and strength. */
function ShaderSwatch({ id, strength }: { id: ShaderId; strength: BackdropStrength }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<ShaderView | null>(null);
  const level = useRef(strength);
  const [failed, setFailed] = useState(false);
  level.current = strength;
  useEffect(() => {
    if (!canvas.current) return;
    try { view.current = new ShaderView(canvas.current, id, shaderInput(id, level.current), { scale: Math.min(2, window.devicePixelRatio || 1), fps: 30, seed: 20 + id.length * 7 }); }
    catch { setFailed(true); return; }
    // Follow theme and palette changes made elsewhere on the page.
    const observer = new MutationObserver(() => view.current?.update(shaderInput(id, level.current)));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-light-palette', 'data-dark-palette'] });
    return () => { observer.disconnect(); view.current?.destroy(); view.current = null; };
  }, [id]);
  useEffect(() => { view.current?.update(shaderInput(id, strength)); }, [id, strength]);
  // Without a GPU the tile's painted fallback shows instead.
  return failed ? null : <canvas ref={canvas} className="handwork-shader-canvas" aria-hidden />;
}

/** A tiny window: chrome, a sidebar of rows, and the card with a reply, a
 *  message and a send button in the accent. */
function Preview({ swatch, accent }: { swatch: Swatch; accent: string }) {
  const style = { '--p-chrome': swatch.chrome, '--p-panel': swatch.panel, '--p-line': swatch.line, '--p-text': swatch.text, '--p-muted': swatch.muted, '--p-accent': accent } as CSSProperties;
  return <span className="handwork-appearance-preview" style={style} aria-hidden>
    <span className="handwork-appearance-preview-side"><i /><i /><i /></span>
    <span className="handwork-appearance-preview-card">
      <i className="is-line" /><i className="is-line is-short" />
      <i className="is-bubble" />
      <span className="handwork-appearance-preview-field"><b /></span>
    </span>
  </span>;
}

/** Arrow keys move the choice within a group, as in a native radio group. */
function radioKeys<T extends string>(event: KeyboardEvent, ids: readonly T[], current: T, choose: (id: T) => void) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const next = ids[(ids.indexOf(current) + step + ids.length) % ids.length];
  choose(next);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  window.requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus());
}

function Group({ title, detail, children }: { title: string; detail?: ReactNode; children: ReactNode }) {
  return <div className="handwork-appearance-group">
    <div className="handwork-appearance-heading"><span className="handwork-setting-title">{title}</span>{detail && <p>{detail}</p>}</div>
    {children}
  </div>;
}

export function HandworkAppearance({ value, disabled, onChange }: { value?: Pick<DesktopPreferences, Keys>; disabled?: boolean; onChange: (patch: Patch) => void }) {
  const backdrop: Backdrop = backdrops.some(item => item.id === value?.backdrop) ? value!.backdrop : 'none';
  const strength: BackdropStrength = strengths.some(item => item.id === value?.backdropStrength) ? value!.backdropStrength : 'balanced';
  const theme: Theme = value?.theme || 'system';
  const accent: AccentColor = value?.accent || 'ink';
  const light = lightPalettes.find(item => item.id === value?.lightPalette) || lightPalettes[0];
  const dark = darkPalettes.find(item => item.id === value?.darkPalette) || darkPalettes[0];
  const tone = accents.find(item => item.id === accent) || accents[0];
  const themes: { id: Theme; label: string }[] = [{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

  return <div className="handwork-appearance">
    <Group title="Theme" detail="System follows your device’s light and dark setting.">
      <div className="handwork-appearance-themes" role="radiogroup" aria-label="Theme">
        {themes.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={theme === item.id} tabIndex={theme === item.id ? 0 : -1} disabled={disabled}
          className="handwork-appearance-theme" onClick={() => onChange({ theme: item.id })} onKeyDown={event => radioKeys(event, themes.map(entry => entry.id), theme, id => onChange({ theme: id }))}>
          <span className="handwork-appearance-frame" data-split={item.id === 'system' || undefined}>
            {item.id !== 'dark' && <Preview swatch={light.swatch} accent={tone.light} />}
            {item.id !== 'light' && <Preview swatch={dark.swatch} accent={tone.dark} />}
          </span>
          <span className="handwork-appearance-label">{theme === item.id && <Check className="handwork-appearance-tick" aria-hidden width={13} height={13} />}{item.label}</span>
        </button>)}
      </div>
    </Group>

    <Group title="Accent" detail={accent === 'ink' ? 'Ink keeps the interface colorless.' : 'Used for send, primary buttons, switches, links and focus.'}>
      <div className="handwork-appearance-accents" role="radiogroup" aria-label="Accent color">
        {accents.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={accent === item.id} aria-label={item.label} title={item.label} tabIndex={accent === item.id ? 0 : -1} disabled={disabled}
          className="handwork-appearance-accent" style={{ '--swatch-light': item.light, '--swatch-dark': item.dark } as CSSProperties}
          onClick={() => onChange({ accent: item.id })} onKeyDown={event => radioKeys(event, accents.map(entry => entry.id), accent, id => onChange({ accent: id }))}>
          {accent === item.id && <Check aria-hidden width={14} height={14} />}
        </button>)}
        <span className="handwork-appearance-accent-name" aria-hidden>{tone.label}</span>
      </div>
    </Group>

    <Group title="Shader" detail="A slow, living light behind the window frame. Your conversations stay on solid cards.">
      <div className="handwork-shaders" role="radiogroup" aria-label="Shader">
        {backdrops.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={backdrop === item.id} tabIndex={backdrop === item.id ? 0 : -1} disabled={disabled}
          className="handwork-shader" onClick={() => onChange({ backdrop: item.id })} onKeyDown={event => radioKeys(event, backdrops.map(entry => entry.id), backdrop, id => onChange({ backdrop: id }))}>
          <span className="handwork-shader-frame" data-shader={item.id}>
            {item.id !== 'none' && <ShaderSwatch id={item.id} strength={strength} />}
            <span className="handwork-shader-window" aria-hidden><span className="handwork-shader-side"><i /><i /><i /></span><span className="handwork-shader-card"><i /><i /></span></span>
          </span>
          <span className="handwork-shader-text">
            <span className="handwork-appearance-label">{backdrop === item.id && <Check className="handwork-appearance-tick" aria-hidden width={13} height={13} />}{item.label}</span>
            <small>{item.note}</small>
          </span>
        </button>)}
      </div>
      <div className="handwork-shader-strength" data-off={backdrop === 'none' || undefined}>
        <span className="handwork-setting-title" id="handwork-shader-strength">Strength</span>
        <div className="handwork-segmented" role="radiogroup" aria-labelledby="handwork-shader-strength">
          {strengths.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={strength === item.id} tabIndex={strength === item.id ? 0 : -1} disabled={disabled || backdrop === 'none'}
            onClick={() => onChange({ backdropStrength: item.id })} onKeyDown={event => radioKeys(event, strengths.map(entry => entry.id), strength, id => onChange({ backdropStrength: id }))}>{item.label}</button>)}
        </div>
      </div>
    </Group>

    <Group title="Light background">
      <div className="handwork-appearance-palettes" role="radiogroup" aria-label="Light background">
        {lightPalettes.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={light.id === item.id} tabIndex={light.id === item.id ? 0 : -1} disabled={disabled}
          className="handwork-appearance-palette" onClick={() => onChange({ lightPalette: item.id })} onKeyDown={event => radioKeys(event, lightPalettes.map(entry => entry.id), light.id, id => onChange({ lightPalette: id }))}>
          <span className="handwork-appearance-chip" style={{ '--p-chrome': item.swatch.chrome, '--p-panel': item.swatch.panel, '--p-line': item.swatch.line } as CSSProperties} aria-hidden />
          <span className="handwork-appearance-palette-text"><span>{item.label}</span><small>{item.note}</small></span>
          <Check className="handwork-appearance-tick" aria-hidden width={14} height={14} />
        </button>)}
      </div>
    </Group>

    <Group title="Dark background">
      <div className="handwork-appearance-palettes" role="radiogroup" aria-label="Dark background">
        {darkPalettes.map(item => <button key={item.id} type="button" role="radio" data-value={item.id} aria-checked={dark.id === item.id} tabIndex={dark.id === item.id ? 0 : -1} disabled={disabled}
          className="handwork-appearance-palette" onClick={() => onChange({ darkPalette: item.id })} onKeyDown={event => radioKeys(event, darkPalettes.map(entry => entry.id), dark.id, id => onChange({ darkPalette: id }))}>
          <span className="handwork-appearance-chip" style={{ '--p-chrome': item.swatch.chrome, '--p-panel': item.swatch.panel, '--p-line': item.swatch.line } as CSSProperties} aria-hidden />
          <span className="handwork-appearance-palette-text"><span>{item.label}</span><small>{item.note}</small></span>
          <Check className="handwork-appearance-tick" aria-hidden width={14} height={14} />
        </button>)}
      </div>
    </Group>
  </div>;
}
