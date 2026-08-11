import {
  type ExtensionSurface,
  parseExtensionSurface,
} from '@pi-dashboard/extension-contributions';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
  clearLiveExtensionSurfaces,
  publishLiveExtensionSurfaces,
} from './live-surfaces';
import type { SessionScopeId } from './scoped-services';

export interface LiveSurfacePublisherOptions<TInput> {
  readonly extensionId: string;
  readonly surfaceId: string;
  readonly rendererId: string;
  readonly placement?: ExtensionSurface['placement'];
  readonly viewModelSchema: TSchema;
  readonly buildViewModel: (input: TInput) => unknown;
  readonly invalidMessage: string;
}

export interface LiveSurfacePublisher<TInput> {
  surface(input: TInput): ExtensionSurface;
  publish(input: TInput, scopeId?: SessionScopeId): void;
  clear(scopeId?: SessionScopeId): void;
}

/**
 * Shared publish/clear/validate dance for extension live surfaces.
 *
 * Callers supply view-model construction and the contribution IDs; the factory
 * owns schema checking, surface parsing, and hub publish/clear.
 */
export function createLiveSurfacePublisher<TInput>(
  options: LiveSurfacePublisherOptions<TInput>,
): LiveSurfacePublisher<TInput> {
  const surface = (input: TInput): ExtensionSurface => {
    const viewModel = options.buildViewModel(input);
    if (!Value.Check(options.viewModelSchema, viewModel))
      throw new Error(options.invalidMessage);
    return parseExtensionSurface({
      id: options.surfaceId,
      rendererId: options.rendererId,
      ...(options.placement === undefined
        ? {}
        : { placement: options.placement }),
      viewModel,
    });
  };
  return {
    surface,
    publish(input, scopeId) {
      publishLiveExtensionSurfaces(
        options.extensionId,
        [surface(input)],
        scopeId,
      );
    },
    clear(scopeId) {
      clearLiveExtensionSurfaces(options.extensionId, scopeId);
    },
  };
}
