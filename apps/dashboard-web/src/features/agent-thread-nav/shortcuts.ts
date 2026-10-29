import { useEffect, useRef, useState } from 'react';
import { hasOpenDialog } from '../modifier-shortcuts';

type ThreadShortcuts = {
  getTargets: () => readonly string[];
  select: (id: string) => void;
  blocked: boolean;
};

function isMeta(event: KeyboardEvent): boolean {
  return (
    event.key === 'Meta' ||
    event.code === 'MetaLeft' ||
    event.code === 'MetaRight'
  );
}

/** A Meta gesture keeps its target snapshot until release or cancellation. */
export function useThreadShortcuts(options: ThreadShortcuts) {
  const current = useRef(options);
  current.current = options;
  const targets = useRef<readonly string[]>([]);
  const clearGesture = useRef<() => void>(() => undefined);
  const [shortcutTargetIds, setShortcutTargetIds] = useState<readonly string[]>(
    [],
  );
  const [shortcutHintsVisible, setShortcutHintsVisible] = useState(false);

  useEffect(() => {
    let revealTimer: number | undefined;
    let exitTimer: number | undefined;
    const cancelTimers = () => {
      if (revealTimer !== undefined) window.clearTimeout(revealTimer);
      if (exitTimer !== undefined) window.clearTimeout(exitTimer);
      revealTimer = undefined;
      exitTimer = undefined;
    };
    const clear = () => {
      targets.current = [];
      cancelTimers();
      setShortcutHintsVisible(false);
      exitTimer = window.setTimeout(() => setShortcutTargetIds([]), 140);
    };
    clearGesture.current = clear;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isMeta(event) && !event.repeat) {
        if (current.current.blocked || hasOpenDialog()) {
          clear();
          return;
        }
        const ids = current.current.getTargets();
        targets.current = ids;
        setShortcutTargetIds(ids);
        setShortcutHintsVisible(false);
        cancelTimers();
        if (ids.length)
          revealTimer = window.setTimeout(
            () => setShortcutHintsVisible(true),
            80,
          );
        return;
      }
      if (
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        current.current.blocked ||
        hasOpenDialog()
      )
        return;
      const key = Number(event.key);
      const target =
        Number.isInteger(key) && key >= 1 && key <= 9
          ? targets.current[key - 1]
          : undefined;
      if (!target) return;
      event.preventDefault();
      current.current.select(target);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isMeta(event)) clear();
    };
    const onBlur = () => clear();
    const onVisibilityChange = () => clear();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      targets.current = [];
      cancelTimers();
      clearGesture.current = () => undefined;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);
  useEffect(() => {
    if (options.blocked) clearGesture.current();
  }, [options.blocked]);
  return { shortcutTargetIds, shortcutHintsVisible };
}
