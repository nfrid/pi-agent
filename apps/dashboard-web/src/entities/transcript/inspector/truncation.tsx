import { SPECIALIZED_PREVIEW_MAX_TEXT } from './types';

export function PreviewTruncation({
  label,
  sourceTruncated: isSourceTruncated,
  textTruncated,
}: {
  label: string;
  sourceTruncated: boolean;
  textTruncated: boolean;
}) {
  return (
    <>
      {textTruncated ? (
        <p className="payload-truncation-label">
          {label} preview is truncated after{' '}
          {SPECIALIZED_PREVIEW_MAX_TEXT.toLocaleString()} characters; remaining
          characters are not displayed.
        </p>
      ) : null}
      {isSourceTruncated ? (
        <small className="payload-truncation-label">
          Source truncated this {label.toLowerCase()} before it reached the
          dashboard.
        </small>
      ) : null}
    </>
  );
}

export function sourceTruncated(
  tool: Record<string, unknown>,
  field: string,
): boolean {
  const data = tool.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[`${field}Truncated`] === true
  );
}
