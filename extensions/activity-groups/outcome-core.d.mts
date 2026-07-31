export type OutcomeTool = {
  type: 'tool';
  name: string;
  args: unknown;
  status: 'pending' | 'running' | 'complete';
  isError: boolean;
};

export function hasUnresolvedToolFailure(
  items: readonly OutcomeTool[],
): boolean;
export function validationKindsOf(name: string, args: unknown): string[];
