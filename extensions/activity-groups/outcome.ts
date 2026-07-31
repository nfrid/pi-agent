import {
  hasUnresolvedToolFailure as sharedHasUnresolvedToolFailure,
  validationKindsOf,
} from './outcome-core.mjs';
import type { SequenceItem } from './types';

export { validationKindsOf };

/**
 * Keep the renderer's retry-aware aggregate outcome on the same implementation
 * as offline session metrics. The shared core is deliberately generic so it
 * does not depend on the host SDK's AssistantMessage types.
 */
export function hasUnresolvedToolFailure(
  items: readonly SequenceItem[],
): boolean {
  return sharedHasUnresolvedToolFailure(
    items.filter(
      (item): item is Extract<SequenceItem, { type: 'tool' }> =>
        item.type === 'tool',
    ),
  );
}
