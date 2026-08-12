export type OutcomeTool = {
  name: string;
  args: unknown;
  status?: 'pending' | 'running' | 'complete' | 'success' | 'error';
  isError?: boolean;
};

export function endedWithToolFailure(items: readonly OutcomeTool[]): boolean;
/** Legacy retry-aware outcome retained for session metrics only. */
export function hasUnresolvedToolFailure(
  items: readonly OutcomeTool[],
): boolean;
export function validationKindsOf(name: string, args: unknown): string[];
