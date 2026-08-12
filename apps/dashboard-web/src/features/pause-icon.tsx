export function PauseIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      focusable="false"
    >
      <rect x="3" y="2" width="3" height="12" rx="1" />
      <rect x="10" y="2" width="3" height="12" rx="1" />
    </svg>
  );
}

export function PlayIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      focusable="false"
    >
      <path d="M4 2.75v10.5a1 1 0 0 0 1.52.85l7.5-5.25a1 1 0 0 0 0-1.7L5.52 1.9A1 1 0 0 0 4 2.75Z" />
    </svg>
  );
}
