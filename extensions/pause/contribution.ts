import {
  CONTINUE_ACTION_ID,
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  pauseStatusRenderer,
} from '@pi-dashboard/extension-contributions';
import { Type } from 'typebox';

export type { PauseStatusViewModel } from '@pi-dashboard/extension-contributions';
export {
  CONTINUE_ACTION_ID,
  PAUSE_RENDERER_ID,
  PAUSE_SURFACE_ID,
  PauseStatusViewModelSchema,
  pauseStatusRenderer,
} from '@pi-dashboard/extension-contributions';

export const PAUSE_CAPABILITY_ID = 'runtime.pause-control';
export const PAUSE_ACTION_ID = 'runtime.pause';

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });

export const pauseManifest: ExtensionManifest = {
  id: 'pause',
  version: '1',
  title: 'Pause control',
  actions: [
    {
      id: PAUSE_ACTION_ID,
      title: 'Pause runtime',
      description:
        'Pause the main agent and active delegates at safe boundaries.',
      inputSchema: EmptyInputSchema,
      availability: {
        requires: [PAUSE_CAPABILITY_ID],
        liveStates: ['idle', 'working', 'waiting'],
      },
      idempotent: true,
    },
    {
      id: CONTINUE_ACTION_ID,
      title: 'Continue runtime',
      description: 'Resume a paused main agent and its delegates.',
      inputSchema: EmptyInputSchema,
      availability: {
        requires: [PAUSE_CAPABILITY_ID],
        liveStates: ['idle', 'working', 'waiting'],
      },
      idempotent: true,
    },
  ],
  renderers: [pauseStatusRenderer],
};

export const pauseCapabilitySnapshot = createRuntimeCapabilitySnapshot(
  [pauseManifest],
  [
    {
      id: PAUSE_CAPABILITY_ID,
      version: '1',
      available: true,
      summary: 'Safe-boundary pause and resume control.',
    },
  ],
);
