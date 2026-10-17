"use client";
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Menu, MenuTrigger, MenuPopup, MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem, MenuCheckboxItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuSubPopup } from '@/components/ui/menu';
import { ChevronDown, Sun, Moon, Monitor } from 'honestui/icons';
import { ProviderLogo } from '@/components/site/ProviderLogo';
import { modelProfile, modelProfiles, modelDisplayName, settingDisplayName } from '@/lib/model-presentation';
import { applyAppearance, savedAppearance } from '@/lib/appearance';
import type { ConfigOption } from '@/lib/desktop-state';

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

function OptionSubmenu({ option, disabled, onChange }: { option: ConfigOption; disabled: boolean; onChange: (value: string) => void }) {
  return <MenuSub>
    <MenuSubTrigger disabled={disabled} className="handwork-option-row" aria-label={option.name || option.id}>
      {option.id === 'provider' && <ProviderLogo provider={option.currentValue} />}<span>{option.name || option.id}</span><span className="handwork-option-value">{choiceLabel(option)}</span>
    </MenuSubTrigger>
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

export function ComposerOptions({ options, disabled, syncing = false, onChange }: { options: ConfigOption[]; disabled: boolean; syncing?: boolean; onChange: (id: string, value: string) => void }) {
  const model = options.find(option => option.id === 'model');
  const mode = options.find(option => option.id === 'mode');
  const provider = options.find(option => option.id === 'provider');
  const modelLabel = model ? choiceLabel(model) : provider ? choiceLabel(provider) : 'Model';
  const settings = options.filter(option => !['mode', 'model', 'provider'].includes(option.id))
    .sort((a, b) => Number(a.id === 'fast_mode') - Number(b.id === 'fast_mode'));
  return <>
    {(model || provider || settings.length > 0) && <Menu>
      <MenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label="Model options" className="handwork-model-trigger" />}>
        {provider && <ProviderLogo provider={provider.currentValue} size={14} />}<span>{modelLabel}</span><ChevronDown aria-hidden width={14} height={14} />
      </MenuTrigger>
      <MenuPopup side="top" align="end" sideOffset={10} className="handwork-model-options" aria-label="Model options">
        {provider && <><OptionSubmenu option={provider} disabled={disabled} onChange={value => onChange(provider.id, value)} /><MenuSeparator /></>}
        {model && <MenuGroup>
          <MenuGroupLabel>Model</MenuGroupLabel>
          <MenuRadioGroup className="handwork-model-list" value={model.currentValue} onValueChange={value => onChange(model.id, String(value))}>
            {model.options.map(choice => {
              const profile = modelProfile(provider?.currentValue || '', choice.value);
              const presentation = profile ? modelProfiles[profile] : undefined;
              return <MenuRadioItem key={choice.value} value={choice.value} aria-label={modelDisplayName(choice.name)} aria-description={presentation ? `${presentation.label}: ${presentation.detail}` : choice.description} disabled={disabled || syncing} closeOnClick className="handwork-model-item" title={presentation?.detail}>
                <span className="handwork-model-choice">
                  <span className="handwork-option-name">{modelDisplayName(choice.name)}</span>
                    {(presentation || choice.description) && <span className="handwork-option-description">{presentation?.label || choice.description}</span>}
                </span>
              </MenuRadioItem>;
            })}
          </MenuRadioGroup>
        </MenuGroup>}
        {model && settings.length > 0 && <MenuSeparator />}
        {settings.map(option => option.id === 'fast_mode' && option.options.length === 2 && option.options.some(choice => choice.value === 'on') && option.options.some(choice => choice.value === 'off')
          ? <MenuCheckboxItem key={option.id} disabled={disabled || syncing} checked={option.currentValue === 'on'} onCheckedChange={checked => onChange(option.id, checked ? 'on' : 'off')} closeOnClick={false} className="handwork-fast-option" aria-label={option.name}>
              <span>{option.name}</span><span className="handwork-option-value">{choiceLabel(option)}</span>
            </MenuCheckboxItem>
          : <OptionSubmenu key={option.id} option={option} disabled={disabled || syncing} onChange={value => onChange(option.id, value)} />)}
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
