"use client";
import { useEffect } from 'react';
import { applyAppearance, savedAppearance } from '@/lib/appearance';
export function ThemeSync() {
  useEffect(() => {
    const update = () => applyAppearance(savedAppearance());
    update(); const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return null;
}
