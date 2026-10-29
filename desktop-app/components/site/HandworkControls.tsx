"use client";
import { HoverTooltip } from "@/components/ui/tooltip";
import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuCheckboxItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuSubPopup } from '@/components/ui/menu';
import { ChevronDown, Sun, Moon, Monitor, Star, Zap } from 'honestui/icons';
import { ProviderLogo } from '@/components/site/ProviderLogo';
import { modelProfile, modelProfiles, modelDisplayName, settingDisplayName } from '@/lib/model-presentation';
import { applyAppearance, savedAppearance } from '@/lib/appearance';
import type { ConfigOption } from '@/lib/desktop-state';
import { modelKey, type ModelShortcut } from '@/lib/model-shortcuts';

export function ConfigChoice({ option, disabled, onChange, compact = false }: { option: ConfigOption; disabled: boolean; compact?: boolean; onChange: (value: string) => void }) {
  return <Select value={option.currentValue} onValueChange={value => { if (value) onChange(value); }} disabled={disabled}>
    <SelectTrigger aria-label={option.name || option.id} size="sm" variant={compact ? "text" : "outline"}><SelectValue>{`${compact ? "" : `${option.name || option.id}: `}${choiceLabel(option)}`}</SelectValue></SelectTrigger>
    <SelectContent>{option.options.map(choice => <SelectItem key={choice.value} value={choice.value}>{displayChoice(option.id, choice.name)}</SelectItem>)}</SelectContent>
  </Select>;
}

function choiceLabel(option: ConfigOption): string {
  return displayChoice(option.id, option.options.find(choice => choice.value === option.currentValue)?.name || option.currentValue);
}

function displayChoice(id: string, name: string): string {
  return id === 'model' ? modelDisplayName(name) : id === 'provider' ? name : settingDisplayName(name);
}

/** Menu labels in sentence case, as every other label in the app; acronyms keep their capitals. */
function optionName(option: ConfigOption): string {
  const name = option.name || option.id.replace(/[-_]+/g, ' ');
  return name.split(' ').map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : /^[A-Z0-9]{2,}$/.test(word) ? word : word.toLowerCase()).join(' ');
}

/** A two-state setting, shown as a switch. */
const isSwitch = (option: ConfigOption) => option.id === 'fast_mode' && option.options.length === 2 && option.options.some(choice => choice.value === 'on') && option.options.some(choice => choice.value === 'off');

/** An ordered scale, such as reasoning effort, shown as a stepped track rather than a submenu. */
const isLevels = (option: ConfigOption) => option.id === 'effort' && option.options.length >= 2 && option.options.length <= 8;

function OptionSubmenu({ option, disabled, browsingOnly = false, onChange }: { option: ConfigOption; disabled: boolean; browsingOnly?: boolean; onChange: (value: string) => void }) {
  return <MenuSub>
    {option.id === 'provider'
      ? <MenuSubTrigger disabled={disabled && !browsingOnly} className="handwork-option-row handwork-provider-header" aria-label={`Provider: ${choiceLabel(option)}`}>
        <span className="handwork-provider-mark"><ProviderLogo provider={option.currentValue} size={15} /></span><span className="handwork-provider-current">{choiceLabel(option)}</span><span className="handwork-option-value">Switch</span>
      </MenuSubTrigger>
      : <MenuSubTrigger disabled={disabled} className="handwork-option-row" aria-label={optionName(option)}>
        <span>{optionName(option)}</span><span className="handwork-option-value">{choiceLabel(option)}</span>
      </MenuSubTrigger>}
    <MenuSubPopup className="handwork-option-submenu" aria-label={option.name || option.id}>
      <MenuRadioGroup value={option.currentValue} onValueChange={value => onChange(String(value))}>
        {option.options.map(choice => <MenuRadioItem key={choice.value} value={choice.value} disabled={disabled} closeOnClick>
          <span className="handwork-provider-choice">{option.id === 'provider' && <ProviderLogo provider={choice.value} />}<span className="handwork-option-name">{displayChoice(option.id, choice.name)}</span></span>
          {choice.description && <span className="handwork-option-description">{choice.description}</span>}
        </MenuRadioItem>)}
      </MenuRadioGroup>
    </MenuSubPopup>
  </MenuSub>;
}

/** Favorite and frequently used models, chosen from any connected provider. */
function ModelShortcuts({ label, items, provider, currentKey, disabled, onChoose }: { label: string; items: ModelShortcut[]; provider?: ConfigOption; currentKey: string; disabled: boolean; onChoose: (model: ModelShortcut) => void }) {
  if (!items.length) return null;
  return <MenuGroup aria-label={label}>
    <MenuRadioGroup value={currentKey} onValueChange={value => { const item = items.find(entry => entry.key === value); if (item && !item.current) onChoose(item); }}>
      {items.map(item => {
        const elsewhere = item.provider !== (provider?.currentValue ?? '');
        const providerName = provider?.options.find(choice => choice.value === item.provider)?.name ?? item.provider;
        return <MenuRadioItem key={item.key} value={item.key} disabled={disabled} closeOnClick className="handwork-model-item handwork-shortcut-item" aria-label={elsewhere ? `${modelDisplayName(item.name)}, switches to ${providerName}` : modelDisplayName(item.name)}>
          <span className="handwork-model-choice">
            <span className="handwork-option-name">{modelDisplayName(item.name)}</span>
            {elsewhere && <span className="handwork-option-description handwork-model-provider" title={`Switches to ${providerName}`}><ProviderLogo provider={item.provider} size={12} />{providerName}</span>}
          </span>
        </MenuRadioItem>;
      })}
    </MenuRadioGroup>
  </MenuGroup>;
}

/**
 * An ordered scale as a slider: drag along the track, click a stop, or use the
 * arrow keys. A drag previews as it moves and applies once, on release, so the
 * model is reconfigured for the level chosen rather than every level passed.
 */
function LevelSlider({ option, disabled, syncing, onChange }: { option: ConfigOption; disabled: boolean; syncing: boolean; onChange: (value: string) => void }) {
  // Changes queue behind one another, so the slider stays usable while one applies;
  // the level chosen is held on screen until the engine confirms it.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => { if (!syncing) setPending(null); }, [syncing]);
  useEffect(() => { setPending(value => value === option.currentValue ? null : value); }, [option.currentValue]);
  const current = option.options.findIndex(choice => choice.value === (pending ?? option.currentValue));
  const [preview, setPreview] = useState<number | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // The click that ends a drag would choose the same level again; it is ignored.
  const committed = useRef<string | null>(null);
  const shown = preview ?? current;
  const count = option.options.length;
  const indexAt = (x: number) => {
    const bounds = track.current!.getBoundingClientRect();
    return Math.min(count - 1, Math.max(0, Math.floor((x - bounds.left) / (bounds.width / count))));
  };
  const commit = (index: number) => {
    const value = option.options[index].value;
    committed.current = value;
    setTimeout(() => { committed.current = null; }, 0);
    if (value !== option.options[current]?.value) { setPending(value); onChange(value); }
  };
  const step = (delta: number) => {
    const index = Math.min(count - 1, Math.max(0, current + delta));
    if (index !== current) { setPending(option.options[index].value); onChange(option.options[index].value); }
  };
  return <MenuGroup aria-label={optionName(option)} className="handwork-effort">
    <span className="handwork-effort-label" aria-hidden><span>{optionName(option)}</span><span className="handwork-effort-value">{shown >= 0 ? displayChoice(option.id, option.options[shown].name) : choiceLabel(option)}</span></span>
    <div ref={track} className="handwork-effort-track" data-dragging={preview !== null || undefined} data-disabled={disabled || undefined}
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPreview(indexAt(event.clientX));
      }}
      onPointerMove={event => { if (dragging.current) setPreview(indexAt(event.clientX)); }}
      onPointerUp={event => {
        if (!dragging.current) return;
        dragging.current = false;
        setPreview(null);
        commit(indexAt(event.clientX));
      }}
      onPointerCancel={() => { dragging.current = false; setPreview(null); }}
      onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        step(event.key === 'ArrowRight' ? 1 : -1);
      }}>
      <MenuRadioGroup className="handwork-effort-options" value={option.currentValue} onValueChange={value => { if (committed.current === value) return; setPending(String(value)); onChange(String(value)); }}>
        {option.options.map((choice, index) => <MenuRadioItem key={choice.value} value={choice.value} disabled={disabled} closeOnClick={false} className="handwork-effort-option" data-filled={index <= shown || undefined} data-current={index === shown || undefined} data-first={index === 0 || undefined} aria-label={displayChoice(option.id, choice.name)}><span className="handwork-effort-stop" /></MenuRadioItem>)}
      </MenuRadioGroup>
    </div>
  </MenuGroup>;
}

export function ComposerOptions({ options, disabled, browsingOnly = false, syncing = false, onChange, shortcuts, onChooseModel, onFavorite }: {
  options: ConfigOption[]; disabled: boolean; browsingOnly?: boolean; syncing?: boolean; onChange: (id: string, value: string) => void;
  shortcuts?: { favorites: ModelShortcut[]; frequent: ModelShortcut[]; favorite: boolean };
  onChooseModel?: (model: ModelShortcut) => void; onFavorite?: (favorite: boolean) => void;
}) {
  const model = options.find(option => option.id === 'model');
  const mode = options.find(option => option.id === 'mode');
  const provider = options.find(option => option.id === 'provider');
  const modelLabel = model ? choiceLabel(model) : provider ? choiceLabel(provider) : 'Model';
  const currentKey = modelKey(provider?.currentValue ?? '', model?.currentValue ?? '');
  const hasShortcuts = !!model && !!onChooseModel && !!shortcuts && shortcuts.favorites.length + shortcuts.frequent.length > 0;
  // Favorites and frequent models on this provider are already in the list below, starred;
  // only those on other providers need a shortcut of their own.
  const currentProvider = provider?.currentValue ?? '';
  const elsewhere = hasShortcuts ? [...shortcuts.favorites, ...shortcuts.frequent].filter((item, index, all) => item.provider !== currentProvider && all.findIndex(other => other.key === item.key) === index).slice(0, 3) : [];
  const starred = new Set((shortcuts?.favorites ?? []).filter(item => item.provider === currentProvider).map(item => item.model));
  const settings = options.filter(option => !['mode', 'model', 'provider'].includes(option.id))
    .sort((a, b) => Number(a.id === 'fast_mode') - Number(b.id === 'fast_mode'));
  return <>
    {(model || provider || settings.length > 0) && <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled && !browsingOnly} aria-label="Model options" className="handwork-model-trigger" />}>
        {provider && <ProviderLogo provider={provider.currentValue} size={14} />}<span>{modelLabel}</span><ChevronDown aria-hidden width={14} height={14} />
      </MenuTrigger>
      <MenuPopup side="top" align="end" sideOffset={10} className="handwork-model-options" aria-label="Model options">
        {provider && <><OptionSubmenu option={provider} disabled={disabled} browsingOnly={browsingOnly} onChange={value => onChange(provider.id, value)} /><MenuSeparator /></>}
        <div className="handwork-model-scroll">
          {elsewhere.length > 0 && onChooseModel && <>
            <ModelShortcuts label="Other providers" items={elsewhere} provider={provider} currentKey={currentKey} disabled={disabled || syncing} onChoose={onChooseModel} />
            <MenuSeparator />
          </>}
          {model && <MenuGroup aria-label="Models">
            <MenuRadioGroup className="handwork-model-list" value={model.currentValue} onValueChange={value => onChange(model.id, String(value))}>
              {model.options.map(choice => {
                const profile = modelProfile(provider?.currentValue || '', choice.value);
                const presentation = profile ? modelProfiles[profile] : undefined;
                return <HoverTooltip key={choice.value} content={presentation?.detail || choice.description}><MenuRadioItem  value={choice.value} aria-label={modelDisplayName(choice.name)} aria-description={presentation ? `${presentation.label}: ${presentation.detail}` : choice.description} disabled={disabled || syncing} closeOnClick className="handwork-model-item" >
                  <span className="handwork-model-choice">
                    <span className="handwork-option-name">{modelDisplayName(choice.name)}</span>
                    {starred.has(choice.value) && <Star className="handwork-model-star" aria-label="Favorite" />}
                    {(presentation || choice.description) && <span className="handwork-option-description">{presentation?.label || choice.description}</span>}
                  </span>
                </MenuRadioItem></HoverTooltip>;
              })}
            </MenuRadioGroup>
          </MenuGroup>}
        </div>
        {(settings.length > 0 || (model && onFavorite)) && <div className="handwork-model-footer">
          {settings.filter(option => !isSwitch(option) && !isLevels(option)).map(option => <OptionSubmenu key={option.id} option={option} disabled={disabled || syncing} onChange={value => onChange(option.id, value)} />)}
          {settings.filter(isLevels).map(option => <LevelSlider key={option.id} option={option} disabled={disabled} syncing={syncing} onChange={value => onChange(option.id, value)} />)}
          <div className="handwork-model-toggles">
            {settings.filter(isSwitch).map(option => <MenuCheckboxItem key={option.id} disabled={disabled || syncing} checked={option.currentValue === 'on'} onCheckedChange={checked => onChange(option.id, checked ? 'on' : 'off')} closeOnClick={false} className="handwork-model-toggle" aria-label={optionName(option)}>
              <Zap aria-hidden className="handwork-toggle-icon" /><span>{optionName(option)}</span><span className="handwork-menu-switch" data-on={option.currentValue === 'on' || undefined} aria-hidden />
            </MenuCheckboxItem>)}
            {model && onFavorite && <MenuCheckboxItem disabled={disabled || syncing} checked={!!shortcuts?.favorite} onCheckedChange={checked => onFavorite(checked)} closeOnClick={false} className="handwork-model-toggle handwork-favorite-chip" aria-label={`Favorite ${modelLabel}`}>
              <Star aria-hidden className="handwork-favorite-toggle" data-on={shortcuts?.favorite || undefined} /><span>{shortcuts?.favorite ? 'Favorited' : 'Favorite'}</span>
            </MenuCheckboxItem>}
          </div>
        </div>}
      </MenuPopup>
    </Menu>}
    {mode && <ConfigChoice option={mode} compact disabled={disabled || syncing} onChange={value => onChange(mode.id, value)} />}
  </>;
}

export async function chooseTheme(next: 'system' | 'light' | 'dark') {
  if (window.handwork?.updateSettings) {
    try { const result = await window.handwork.updateSettings('app', { theme: next }); applyAppearance(result.app); }
    catch (error) { window.dispatchEvent(new CustomEvent('handwork:settings-error', { detail: String(error) })); }
  } else applyAppearance({ ...savedAppearance(), theme: next });
}

export function HandworkTheme({ compact = true }: { compact?: boolean }) {
  const readTheme = () => typeof document !== 'undefined' ? savedAppearance().theme : 'system';
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const sync = () => setTheme(readTheme());
    window.addEventListener('handwork:theme', sync);
    return () => window.removeEventListener('handwork:theme', sync);
  }, []);
  const choose = chooseTheme;
  return <div className="handwork-theme-switcher" role="group" aria-label="Color theme">
    {[{ id: 'system' as const, label: 'System theme', Icon: Monitor }, { id: 'light' as const, label: 'Light theme', Icon: Sun }, { id: 'dark' as const, label: 'Dark theme', Icon: Moon }].map(({ id, label, Icon }) =>
      <Button key={id} type="button" variant={theme === id ? 'secondary' : 'ghost'} size={compact ? 'icon-sm' : 'sm'} aria-label={label} title={label} aria-pressed={theme === id} onClick={() => choose(id)}>
        <Icon aria-hidden width={16} height={16} />{!compact && <span>{id === 'light' ? 'Light' : id === 'dark' ? 'Dark' : 'System'}</span>}
      </Button>)}
  </div>;
}
