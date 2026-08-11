import { isNarration } from '../../transcript';

function activityTitleLine(text: string): string {
  return (
    text
      .split('\n')[0]
      ?.trim()
      .replace(/[.…:]+$/, '') ?? text
  );
}

export function shouldShowActivityLead(text: string, title: string): boolean {
  return !isNarration(text) && activityTitleLine(text) !== title;
}

export { activityTitleLine };
