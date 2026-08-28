export function SessionHistoryControl({
  loading,
  error,
  onLoad,
}: {
  loading: boolean;
  error: string | undefined;
  onLoad: () => void;
}) {
  return (
    <div className="session-history-control" aria-live="polite">
      <button
        type="button"
        className="secondary-button"
        onClick={onLoad}
        disabled={loading}
      >
        {loading
          ? 'Loading earlier history…'
          : error
            ? 'Retry earlier history'
            : 'Load earlier history'}
      </button>
      {error && (
        <span role="alert" className="session-history-error">
          {error}
        </span>
      )}
    </div>
  );
}
