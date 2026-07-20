import { Container, Text } from '@earendil-works/pi-tui';
import {
  type DelegateCallArgs,
  fieldLine,
  modeDescription,
  type RenderContextLike,
  type ThemeLike,
  taskText,
} from './render-utils';

export function renderDelegateCall(
  args: DelegateCallArgs,
  theme: ThemeLike,
  context?: RenderContextLike,
) {
  if (context?.executionStarted) return new Container();

  const fg = theme.fg.bind(theme);
  const expanded = context?.expanded === true;
  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const visibleTasks = expanded ? args.tasks : args.tasks.slice(0, 3);
    let text = `${fg('toolTitle', theme.bold('Delegate'))} ${fg('muted', `· ${args.tasks.length} subagents`)}`;
    for (const [index, task] of visibleTasks.entries()) {
      text += `\n${fieldLine(
        `${index + 1} Task`,
        taskText(task.task, expanded),
        fg,
        'text',
      )}`;
      text += `\n${fieldLine(
        'Mode',
        modeDescription(
          {
            context: task.context ?? args.context,
            continuation: task.continuation,
            allowWrites: task.allowWrites ?? args.allowWrites,
            cwd: task.cwd ?? args.cwd ?? context?.cwd,
            route: task.route ?? args.route,
            requestedMode: true,
          },
          fg,
        ),
        fg,
        null,
      )}`;
    }
    if (!expanded && args.tasks.length > visibleTasks.length)
      text += `\n${fg('muted', `… ${args.tasks.length - visibleTasks.length} more subagents`)}`;
    return new Text(text, 0, 0);
  }

  const text = [
    fg('toolTitle', theme.bold('Delegate')),
    fieldLine('Task', taskText(args.task, expanded), fg, 'text'),
    fieldLine(
      'Mode',
      modeDescription(
        {
          context: args.context,
          continuation: args.continuation,
          allowWrites: args.allowWrites,
          cwd: args.cwd ?? context?.cwd,
          route: args.route,
          requestedMode: true,
        },
        fg,
      ),
      fg,
      null,
    ),
  ].join('\n');
  return new Text(text, 0, 0);
}
