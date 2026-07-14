import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { normalizeKey } from './coerce';
import { CODEX_PROVIDER_ID } from './constants';
import type { PiModel } from './types';

export function isCodexModel(
  model: ExtensionContext['model'],
): model is PiModel {
  return model?.provider === CODEX_PROVIDER_ID;
}

export function modelKeys(model: PiModel): Set<string> {
  const keys = new Set<string>();
  for (const raw of [model.id, model.name]) {
    const key = normalizeKey(raw);
    if (!key) continue;
    keys.add(key);
    const codexIndex = key.indexOf('codex');
    if (codexIndex >= 0) keys.add(key.slice(codexIndex));
  }
  return keys;
}
