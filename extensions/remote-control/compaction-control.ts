let activeCompactionController: AbortController | undefined;

export type CancellableCompaction = {
  signal: AbortSignal;
  wasCancelled: () => boolean;
  finish: () => void;
};

export function beginCancellableCompaction(
  parentSignal: AbortSignal,
): CancellableCompaction {
  const controller = new AbortController();
  activeCompactionController = controller;
  return {
    signal: AbortSignal.any([parentSignal, controller.signal]),
    wasCancelled: () => controller.signal.aborted,
    finish: () => {
      if (activeCompactionController === controller)
        activeCompactionController = undefined;
    },
  };
}

export function cancelActiveCompaction(): void {
  const controller = activeCompactionController;
  if (!controller || controller.signal.aborted)
    throw new Error('There is no active context compaction to cancel.');
  controller.abort(new Error('Compaction cancelled from the dashboard.'));
  activeCompactionController = undefined;
}
