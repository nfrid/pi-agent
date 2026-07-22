import { Container, Text } from '@earendil-works/pi-tui';
import {
  type DelegateCallArgs,
  fieldLine,
  modeDescription,
  type RenderContextLike,
  type ThemeLike,
  taskBlock,
} from './render-utils';

export function renderDelegateCall(
  args: DelegateCallArgs,
  theme: ThemeLike,
  context?: RenderContextLike,
) {
  if (context?.executionStarted) return new Container();

  const fg = theme.fg.bind(theme);
  const expanded = context?.expanded === true;
  const container = new Container();

  if (Array.isArray(args.tasks) && args.tasks.length > 0) {
    const visibleTasks = expanded ? args.tasks : args.tasks.slice(0, 3);
    container.addChild(
      new Text(
        `${fg('toolTitle', theme.bold('Delegate'))} ${fg('muted', `· ${args.tasks.length} subagents`)}`,
        0,
        0,
      ),
    );
    for (const [index, task] of visibleTasks.entries()) {
      container.addChild(
        taskBlock(`${index + 1} Task`, task.task, expanded, fg),
      );
      container.addChild(
        new Text(
          fieldLine(
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
          ),
          0,
          0,
        ),
      );
    }
    if (!expanded && args.tasks.length > visibleTasks.length)
      container.addChild(
        new Text(
          fg(
            'muted',
            `… ${args.tasks.length - visibleTasks.length} more subagents`,
          ),
          0,
          0,
        ),
      );
    return container;
  }

  container.addChild(new Text(fg('toolTitle', theme.bold('Delegate')), 0, 0));
  container.addChild(taskBlock('Task', args.task, expanded, fg));
  container.addChild(
    new Text(
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
      0,
      0,
    ),
  );
  return container;
}
