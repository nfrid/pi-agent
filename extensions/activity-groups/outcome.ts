import {
  endedWithToolFailure as sharedEndedWithToolFailure,
  validationKindsOf,
} from '@pi-dashboard/activity-model';
import type { SequenceItem } from './types';

export { validationKindsOf };

/** Keep the TUI's final-attempt warning aligned with the shared projection. */
export function endedWithToolFailure(items: readonly SequenceItem[]): boolean {
  return sharedEndedWithToolFailure(
    items.filter(
      (item): item is Extract<SequenceItem, { type: 'tool' }> =>
        item.type === 'tool',
    ),
  );
}
