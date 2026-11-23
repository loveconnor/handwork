"use client";
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuCheckboxItem, MenuSub, MenuSubTrigger, MenuSubPopup } from '@/components/ui/menu';
import { ChevronDown, Sun, Moon, Monitor } from 'honestui/icons';
import { ProviderLogo } from '@/components/site/ProviderLogo';
import { modelProfile, modelProfiles, modelDisplayName, settingDisplayName } from '@/lib/model-presentation';
import { applyAppearance, savedAppearance } from '@/lib/appearance';
import type { ConfigOption } from '@/lib/desktop-state';
import type { ModelShortcut } from '@/lib/model-shortcuts';

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

/** Opening the menu brings the current model into view, centered when the list scrolls. */
function revealCurrent(list: HTMLDivElement | null) {
  if (!list) return;
  window.requestAnimationFrame(() => {
    const current = list.querySelector<HTMLElement>('[aria-checked="true"]');
    if (current) list.scrollTop = Math.max(0, current.offsetTop - list.offsetTop - (list.clientHeight - current.offsetHeight) / 2);
  });
}

export function ComposerOptions({ options, disabled, browsingOnly = false, syncing = false, onChange }: {
  options: ConfigOption[]; disabled: boolean; browsingOnly?: boolean; syncing?: boolean; onChange: (id: string, value: string) => void;
  /** Accepted for callers that still pass them; the menu no longer shows shortcuts or a favorite toggle. */
  shortcuts?: { favorites: ModelShortcut[]; frequent: ModelShortcut[]; favorite: boolean };
  onChooseModel?: (model: ModelShortcut) => void; onFavorite?: (favorite: boolean) => void;
}) {
  const model = options.find(option => option.id === 'model');
  const mode = options.find(option => option.id === 'mode');
  const provider = options.find(option => option.id === 'provider');
  const modelLabel = model ? choiceLabel(model) : provider ? choiceLabel(provider) : 'Model';
  const settings = options.filter(option => !['mode', 'model', 'provider'].includes(option.id))
    .sort((a, b) => Number(a.id === 'fast_mode') - Number(b.id === 'fast_mode'));
  return <>
    {(model || provider || settings.length > 0) && <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled && !browsingOnly} aria-label="Model options" className="handwork-model-trigger" />}>
        {provider && <ProviderLogo provider={provider.currentValue} size={14} />}<span>{modelLabel}</span><ChevronDown aria-hidden width={14} height={14} />
      </MenuTrigger>
      <MenuPopup side="top" align="end" sideOffset={10} className="handwork-model-options" aria-label="Model options">
        {provider && <OptionSubmenu option={provider} disabled={disabled} browsingOnly={browsingOnly} onChange={value => onChange(provider.id, value)} />}
        {model && <div className="handwork-model-scroll" ref={revealCurrent}>
          <MenuGroup aria-label="Models">
            <MenuRadioGroup className="handwork-model-list" value={model.currentValue} onValueChange={value => onChange(model.id, String(value))}>
              {model.options.map(choice => {
                const profile = modelProfile(provider?.currentValue || '', choice.value);
                const presentation = profile ? modelProfiles[profile] : undefined;
                return <MenuRadioItem key={choice.value} value={choice.value} aria-label={modelDisplayName(choice.name)} aria-description={presentation ? `${presentation.label}: ${presentation.detail}` : choice.description} disabled={disabled || syncing} closeOnClick className="handwork-model-item">
                  <span className="handwork-model-choice"><span className="handwork-option-name">{modelDisplayName(choice.name)}</span></span>
                </MenuRadioItem>;
              })}
            </MenuRadioGroup>
          </MenuGroup>
        </div>}
        {settings.length > 0 && <div className="handwork-model-footer">
          {settings.filter(option => !isSwitch(option)).map(option => <OptionSubmenu key={option.id} option={option} disabled={disabled || syncing} onChange={value => onChange(option.id, value)} />)}
          {settings.filter(isSwitch).map(option => <MenuCheckboxItem key={option.id} disabled={disabled || syncing} checked={option.currentValue === 'on'} onCheckedChange={checked => onChange(option.id, checked ? 'on' : 'off')} closeOnClick={false} className="handwork-option-row handwork-model-switch-row" aria-label={optionName(option)}>
            <span>{optionName(option)}</span><span className="handwork-menu-switch" data-on={option.currentValue === 'on' || undefined} aria-hidden />
          </MenuCheckboxItem>)}
        </div>}
      </MenuPopup>
    </Menu>}
    {mode && <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled || syncing} aria-label={`Permissions: ${choiceLabel(mode)}`} />}>
        <span>{choiceLabel(mode)}</span><ChevronDown aria-hidden width={14} height={14} />
      </MenuTrigger>
      <MenuPopup side="top" align="end" sideOffset={10} aria-label="Permissions" className="handwork-permission-options">
        <MenuGroup aria-label="Permissions for this session">
          <span className="handwork-effort-label">Permissions · this session</span>
          <MenuRadioGroup value={mode.currentValue} onValueChange={value => onChange(mode.id, String(value))}>
            {mode.options.map(choice => <MenuRadioItem key={choice.value} value={choice.value} disabled={disabled || syncing} closeOnClick aria-label={choice.name} aria-description={choice.description}>
              <span className="handwork-permission-choice"><span>{choice.name}</span>{choice.description && <span className="handwork-option-description">{choice.description}</span>}</span>
            </MenuRadioItem>)}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>}
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
