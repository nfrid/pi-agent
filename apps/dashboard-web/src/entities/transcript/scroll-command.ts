/** A controller-owned, cancellable request. Renderers only supply positioning. */
export type TranscriptScrollCommand = {
  kind: 'latest' | 'anchor';
  scrollTop: number;
  rowKey?: string;
  rowOffset?: number;
  signal: AbortSignal;
  complete: () => void;
};
