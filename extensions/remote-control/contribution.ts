import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

/**
 * Semantic actions backed directly by the 0.82.1 ExtensionContext APIs.
 *
 * This manifest intentionally does not advertise new/resume/fork/tree/reload:
 * those operations are command-context-only in the installed Pi runtime. The
 * remote socket callback retains only ExtensionContext, so claiming them here
 * would turn an unavailable lifecycle operation into a misleading dashboard
 * control. Remove this limitation note when Pi supplies a headless callback
 * API with an epoch-safe result contract.
 */
export const REMOTE_CONTROL_CAPABILITY_ID = 'remote-control.semantic-actions';
export const SESSION_COMPACT_ACTION_ID = 'session.compact';
export const RUNTIME_ABORT_ACTION_ID = 'runtime.abort';
export const RUNTIME_SHUTDOWN_ACTION_ID = 'runtime.shutdown';

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });
const CompactInputSchema = Type.Object(
  {
    customInstructions: Type.Optional(Type.String({ maxLength: 20_000 })),
  },
  { additionalProperties: false },
);

export const remoteControlManifest: ExtensionManifest = {
  id: 'remote-control',
  version: '1',
  title: 'Remote control',
  actions: [
    {
      id: SESSION_COMPACT_ACTION_ID,
      title: 'Compact session',
      description: 'Compact the current Pi session with optional guidance.',
      inputSchema: CompactInputSchema,
      availability: {
        requires: [REMOTE_CONTROL_CAPABILITY_ID],
        liveStates: ['idle', 'working', 'waiting'],
      },
      idempotent: false,
    },
    {
      id: RUNTIME_ABORT_ACTION_ID,
      title: 'Abort run',
      description: 'Stop the current model turn without shutting down Pi.',
      inputSchema: EmptyInputSchema,
      availability: {
        requires: [REMOTE_CONTROL_CAPABILITY_ID],
        liveStates: ['working', 'waiting', 'aborting'],
      },
      idempotent: false,
    },
    {
      id: RUNTIME_SHUTDOWN_ACTION_ID,
      title: 'Shut down runtime',
      description: 'Request a graceful Pi runtime shutdown.',
      inputSchema: EmptyInputSchema,
      availability: {
        requires: [REMOTE_CONTROL_CAPABILITY_ID],
        liveStates: ['idle', 'working', 'waiting', 'aborting'],
      },
      idempotent: false,
    },
  ],
  renderers: [],
};

export const remoteControlCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [remoteControlManifest],
  [
    {
      id: REMOTE_CONTROL_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Bounded semantic actions backed by ExtensionContext APIs.',
    },
  ],
);
