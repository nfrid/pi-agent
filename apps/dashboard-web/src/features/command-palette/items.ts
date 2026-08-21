import {
  isActionAvailable,
  type RuntimeCapabilitySnapshot,
} from '@pi-dashboard/extension-contributions';
import type { BrowserSnapshot, RuntimeSnapshot } from '@pi-dashboard/protocol';
import { sessionDisplayTitle } from '../../app-helpers';
import { newChatPath } from '../../routes/navigation';

export function actionNeedsInput(action: { inputSchema?: unknown }): boolean {
  const schema = action.inputSchema;
  // Older manifests omitted inputSchema for actions that accept {}. Treat an
  // absent schema, and an explicitly empty object schema, as inputless.
  if (schema === undefined || schema === null) return false;
  if (typeof schema !== 'object' || Array.isArray(schema)) return true;
  const value = schema as { required?: unknown; minProperties?: unknown };
  return (
    (Array.isArray(value.required) && value.required.length > 0) ||
    (typeof value.minProperties === 'number' && value.minProperties > 0)
  );
}

type PaletteItem =
  | {
      kind: 'navigate';
      id: string;
      title: string;
      description: string;
      path: string;
    }
  | {
      kind: 'action';
      id: string;
      title: string;
      description: string;
      runtime: RuntimeSnapshot;
      action: ReturnType<typeof snapshotActions>[number]['action'];
      target: string;
      needsInput: boolean;
    };

// Keep the palette useful on large installations without creating a second
// unbounded session browser inside the dialog.
const MAX_PALETTE_WORKSPACES = 24;
const MAX_PALETTE_SESSIONS = 24;

function snapshotActions(snapshot: BrowserSnapshot) {
  return snapshot.runtimes.flatMap((runtime) =>
    runtime.online === false
      ? []
      : (runtime.capabilities?.manifests ?? []).flatMap((manifest) =>
          manifest.actions
            .filter((action) =>
              isActionAvailable(
                action,
                runtime.capabilities as RuntimeCapabilitySnapshot | undefined,
                {
                  online: runtime.online !== false,
                  liveState: runtime.liveState,
                },
              ),
            )
            .map((action) => ({ runtime, action })),
        ),
  );
}

export function paletteItems(
  snapshot: BrowserSnapshot,
  workspaceId?: string,
): PaletteItem[] {
  const primary: PaletteItem[] = [
    {
      kind: 'navigate',
      id: 'dashboard',
      title: 'Dashboard',
      description: 'Go to the operational overview',
      path: '/',
    },
    {
      kind: 'navigate',
      id: 'new-chat',
      title: 'New chat',
      description: 'Start a chat in a workspace',
      path: newChatPath(snapshot, workspaceId),
    },
    {
      kind: 'navigate',
      id: 'workspaces',
      title: 'Workspaces',
      description: 'Browse workspaces',
      path: '/workspaces',
    },
    {
      kind: 'navigate',
      id: 'sessions',
      title: 'Sessions',
      description: 'Browse session history',
      path: '/sessions',
    },
    {
      kind: 'navigate',
      id: 'inbox',
      title: 'Inbox',
      description: 'Open notifications and usage',
      path: '/inbox',
    },
  ];
  const actions = snapshotActions(snapshot).map(
    ({ runtime, action }): PaletteItem => ({
      kind: 'action',
      id: `action:${runtime.runtimeId}:${action.id}`,
      title: action.title ?? action.id,
      description: action.description ?? action.id,
      runtime,
      action,
      target: sessionDisplayTitle(runtime.session, runtime.session.entries),
      needsInput: actionNeedsInput(action),
    }),
  );
  const sessions = snapshot.sessions.slice(0, MAX_PALETTE_SESSIONS).map(
    (session): PaletteItem => ({
      kind: 'navigate',
      id: `session:${session.id}`,
      title: `Session: ${sessionDisplayTitle(session)}`,
      description: session.cwd,
      path: `/sessions/${encodeURIComponent(session.id)}`,
    }),
  );
  const workspaces = snapshot.workspaces.slice(0, MAX_PALETTE_WORKSPACES).map(
    (workspace): PaletteItem => ({
      kind: 'navigate',
      id: `workspace:${workspace.id}`,
      title: `Workspace: ${workspace.name}`,
      description: workspace.canonicalPath,
      path: `/workspaces/${encodeURIComponent(workspace.id)}`,
    }),
  );
  return [...primary, ...actions, ...sessions, ...workspaces];
}
