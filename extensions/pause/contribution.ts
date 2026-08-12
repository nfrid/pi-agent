import {
  createRuntimeCapabilitySnapshot,
  type ExtensionManifest,
  type RendererDescriptor,
} from '@pi-dashboard/extension-contributions';
import { type Static, Type } from 'typebox';

export const PAUSE_CAPABILITY_ID = 'runtime.pause-control';
export const PAUSE_ACTION_ID = 'runtime.pause';
export const CONTINUE_ACTION_ID = 'runtime.continue';
export const PAUSE_RENDERER_ID = 'runtime.pause-status';
export const PAUSE_SURFACE_ID = 'runtime.pause-status';

const EmptyInputSchema = Type.Object({}, { additionalProperties: false });
export const PauseStatusViewModelSchema = Type.Object(
  {
    version: Type.Literal(1),
    phase: Type.Union([Type.Literal('pausing'), Type.Literal('paused')]),
    delegateCount: Type.Integer({ minimum: 0, maximum: 20 }),
    pausedAt: Type.Optional(Type.Number({ minimum: 0 })),
    label: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);
export type PauseStatusViewModel = Static<typeof PauseStatusViewModelSchema>;

export const pauseStatusRenderer: RendererDescriptor = {
  id: PAUSE_RENDERER_ID,
  mode: 'generic',
  inputSchema: PauseStatusViewModelSchema,
  title: 'Pause status',
  summary: 'Whether this runtime is pausing or paused.',
};

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
