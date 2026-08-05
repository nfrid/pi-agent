export type OutcomeTool = {
  name: string;
  args: unknown;
  status?: 'pending' | 'running' | 'complete' | 'success' | 'error';
  isError?: boolean;
};

export function hasUnresolvedToolFailure(
  items: readonly OutcomeTool[],
): boolean;
export function validationKindsOf(name: string, args: unknown): string[];
