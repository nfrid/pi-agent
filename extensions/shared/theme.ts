import type { ThinkingLevel } from '@earendil-works/pi-ai';
import type { ThemeColor } from '@earendil-works/pi-coding-agent';

export function thinkingToThemeColor(
  thinking: 'off' | ThinkingLevel,
): ThemeColor {
  return `thinking${thinking.charAt(0).toUpperCase()}${thinking.slice(1)}` as ThemeColor;
}
