import { useEffect, useState } from 'react';
import { useDashboardSurfaces } from './dashboard-surface-context';

type Shortcut = {
  action: () => void;
  enabled: boolean;
};

const shortcuts = new Map<string, Shortcut>();
const listeners = new Set<() => void>();
let metaHeld = false;
let listening = false;

function notify() {
  for (const listener of listeners) listener();
}

function onKeyDown(event: globalThis.KeyboardEvent) {
  if (event.key === 'Meta') {
    if (!event.repeat && !metaHeld) {
      metaHeld = true;
      notify();
    }
    return;
  }
  if (
    !metaHeld ||
    !event.metaKey ||
    !event.altKey ||
    event.ctrlKey ||
    event.shiftKey
  )
    return;
  const shortcut = shortcuts.get(event.key.toLocaleLowerCase());
  if (!shortcut?.enabled) return;
  event.preventDefault();
  event.stopPropagation();
  shortcut.action();
}

function clearMeta() {
  if (!metaHeld) return;
  metaHeld = false;
  notify();
}

function startListening() {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Meta') clearMeta();
    },
    true,
  );
  window.addEventListener('blur', clearMeta);
  document.addEventListener('visibilitychange', clearMeta);
}

export function useModifierShortcut(
  key: string,
  action: () => void,
  enabled: boolean,
): boolean {
  const surfaces = useDashboardSurfaces();
  const [held, setHeld] = useState(metaHeld);
  const blocked = Boolean(surfaces?.stack.length);
  useEffect(() => {
    const listener = () => setHeld(metaHeld);
    listeners.add(listener);
    startListening();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    const normalized = key.toLocaleLowerCase();
    shortcuts.set(normalized, { action, enabled: enabled && !blocked });
    return () => {
      if (shortcuts.get(normalized)?.action === action)
        shortcuts.delete(normalized);
    };
  }, [action, blocked, enabled, key]);
  return held && enabled && !blocked;
}
