import { useEffect, useState } from 'react';
import { useDashboardSurfaces } from './dashboard-surface-context';

type ShortcutRegistration = {
  id: number;
  code: string;
  action: () => void;
  enabled: boolean;
};

const registrations = new Map<number, ShortcutRegistration>();
const listeners = new Set<() => void>();
let nextRegistrationId = 1;
let metaHeld = false;
let listening = false;

function notify() {
  for (const listener of listeners) listener();
}

function hasOpenDialog(): boolean {
  if (typeof document === 'undefined') return false;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
    (element) => {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true')
        return false;
      return element.getClientRects().length > 0;
    },
  );
}

function shortcutCode(key: string): string {
  const normalized = key.toLocaleLowerCase();
  return normalized.length === 1 && normalized >= 'a' && normalized <= 'z'
    ? `Key${normalized.toUpperCase()}`
    : normalized;
}

function onKeyDown(event: globalThis.KeyboardEvent) {
  if (
    event.key === 'Meta' ||
    event.code === 'MetaLeft' ||
    event.code === 'MetaRight'
  ) {
    if (!event.repeat && !metaHeld) {
      metaHeld = true;
      notify();
    }
    return;
  }
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    !event.metaKey ||
    !event.altKey ||
    event.ctrlKey ||
    event.shiftKey ||
    hasOpenDialog()
  )
    return;
  const available = [...registrations.values()]
    .filter(
      (registration) =>
        registration.enabled && registration.code === event.code,
    )
    .sort((left, right) => right.id - left.id);
  const shortcut = available[0];
  if (!shortcut) return;
  event.preventDefault();
  event.stopPropagation();
  shortcut.action();
}

function clearMeta() {
  if (!metaHeld) return;
  metaHeld = false;
  notify();
}

function stopListening() {
  if (!listening) return;
  listening = false;
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', clearMeta);
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', clearMeta);
    document.removeEventListener('compositionstart', clearMeta);
  }
  clearMeta();
}

function onKeyUp(event: globalThis.KeyboardEvent) {
  if (
    event.key === 'Meta' ||
    event.code === 'MetaLeft' ||
    event.code === 'MetaRight'
  )
    clearMeta();
}

function startListening() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', clearMeta);
  document.addEventListener('visibilitychange', clearMeta);
  document.addEventListener('compositionstart', clearMeta);
}

export function useModifierShortcut(
  key: string,
  action: () => void,
  enabled: boolean,
): boolean {
  const surfaces = useDashboardSurfaces();
  const [held, setHeld] = useState(metaHeld);
  const blocked = Boolean(surfaces?.stack.length) || hasOpenDialog();
  useEffect(() => {
    const listener = () => setHeld(metaHeld);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    const id = nextRegistrationId++;
    registrations.set(id, {
      id,
      code: shortcutCode(key),
      action,
      enabled: enabled && !blocked,
    });
    startListening();
    return () => {
      registrations.delete(id);
      if (registrations.size === 0) stopListening();
    };
  }, [action, blocked, enabled, key]);
  return held && enabled && !blocked;
}

export { hasOpenDialog, shortcutCode };
