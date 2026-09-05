import { useEffect, useRef, useState } from 'react';
import { useDashboardSurfaces } from './dashboard-surface-context';

export type ModifierShortcut = {
  code: string;
  alt?: boolean;
};

type ShortcutRegistration = {
  id: number;
  code: string;
  alt: boolean;
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
  if (/^Key[a-z]$/u.test(key)) return `Key${key.slice(3).toUpperCase()}`;
  if (key.length === 1 && key >= 'a' && key <= 'z')
    return `Key${key.toUpperCase()}`;
  if (key.toLocaleLowerCase() === 'period') return 'Period';
  return key;
}

function shortcutBinding(shortcut: ModifierShortcut): {
  code: string;
  alt: boolean;
} {
  return {
    code: shortcutCode(shortcut.code),
    alt: shortcut.alt ?? false,
  };
}

export function shortcutLabel(shortcut: ModifierShortcut): string {
  const code = shortcutCode(shortcut.code);
  const key = code.startsWith('Key')
    ? code.slice(3)
    : code === 'Period'
      ? '.'
      : code;
  return `${shortcut.alt ? '⌥' : ''}${key}`;
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
    event.ctrlKey ||
    event.shiftKey ||
    hasOpenDialog()
  )
    return;
  const available = [...registrations.values()]
    .filter(
      (registration) =>
        registration.enabled &&
        registration.code === event.code &&
        registration.alt === event.altKey,
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
  shortcut: ModifierShortcut,
  action: () => void,
  enabled: boolean,
): boolean {
  const surfaces = useDashboardSurfaces();
  const [held, setHeld] = useState(metaHeld);
  const [hintVisible, setHintVisible] = useState(metaHeld);
  const registrationRef = useRef<ShortcutRegistration | undefined>(undefined);
  const actionRef = useRef(action);
  const enabledRef = useRef(enabled);
  // DOM-backed work dialogs are checked at dispatch time: reading them during
  // render would retain the closing dialog's pre-commit state.
  const blocked = Boolean(surfaces?.stack.length);
  const blockedRef = useRef(blocked);
  const binding = shortcutBinding(shortcut);
  actionRef.current = action;
  enabledRef.current = enabled;
  blockedRef.current = blocked;
  if (registrationRef.current) {
    registrationRef.current.action = action;
    registrationRef.current.enabled = enabled && !blocked;
    registrationRef.current.code = binding.code;
    registrationRef.current.alt = binding.alt;
  }
  useEffect(() => {
    const listener = () => setHeld(metaHeld);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    const id = nextRegistrationId++;
    const registration: ShortcutRegistration = {
      id,
      code: binding.code,
      alt: binding.alt,
      action: actionRef.current,
      enabled: enabledRef.current && !blockedRef.current,
    };
    registrationRef.current = registration;
    registrations.set(id, registration);
    startListening();
    return () => {
      registrations.delete(id);
      registrationRef.current = undefined;
      if (registrations.size === 0) stopListening();
    };
  }, [binding.alt, binding.code]);
  useEffect(() => {
    if (!held || !enabled || blocked) {
      setHintVisible(false);
      return;
    }
    const timer = globalThis.setTimeout(() => setHintVisible(true), 80);
    return () => globalThis.clearTimeout(timer);
  }, [blocked, enabled, held]);
  return hintVisible && enabled && !blocked;
}

export { hasOpenDialog, shortcutCode };
