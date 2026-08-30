export function TranscriptDisclosureIcon({ expanded }: { expanded: boolean }) {
  return (
    <span className="transcript-disclosure-icon" aria-hidden="true">
      <svg aria-hidden="true" viewBox="0 0 16 16">
        <path d={expanded ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4'} />
      </svg>
    </span>
  );
}
