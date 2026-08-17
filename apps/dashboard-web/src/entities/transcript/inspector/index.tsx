import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';
import { boundedInspectorText, toolInspectorRows } from './bounded-text';
import { StructuredPayloadView } from './structured-payload';
import {
  BoundedPayloadPreview,
  normalizeToolResultText,
  PayloadSection,
  SpecializedToolInspector,
  sourceTruncated,
  toolPresentationKind,
  toolPreviewLanguage,
} from './tool-preview';

function ToolInspector({
  tool,
}: {
  tool: Record<string, unknown> | TranscriptRenderToolItem;
}) {
  const record = tool as Record<string, unknown>;
  const selectedKind = toolPresentationKind(record);
  const specializedKind =
    selectedKind === 'command' &&
    record.result !== undefined &&
    normalizeToolResultText(record.result) === undefined
      ? undefined
      : selectedKind;
  const status = record.status ?? (record.isError ? 'error' : 'pending');
  const argumentsValue = record.arguments ?? record.args;
  return (
    <div className="tool-inspector">
      <dl className="tool-inspector-status">
        <div>
          <dt>Status</dt>
          <dd>{String(status)}</dd>
        </div>
      </dl>
      {specializedKind ? (
        <SpecializedToolInspector kind={specializedKind} tool={record} />
      ) : null}
      {specializedKind && argumentsValue !== undefined ? (
        <details className="tool-inspector-raw">
          <summary>Raw Arguments</summary>
          <BoundedPayloadPreview value={argumentsValue} label="arguments" />
        </details>
      ) : null}
      {specializedKind && record.result !== undefined ? (
        <details className="tool-inspector-raw">
          <summary>Raw Result</summary>
          <BoundedPayloadPreview value={record.result} label="result" />
        </details>
      ) : null}
      {!specializedKind && argumentsValue !== undefined && (
        <PayloadSection
          title="Arguments"
          value={argumentsValue}
          sourceTruncated={sourceTruncated(record, 'arguments')}
        />
      )}
      {!specializedKind && record.result !== undefined && (
        <PayloadSection
          title="Result"
          value={record.result}
          sourceTruncated={sourceTruncated(record, 'result')}
        />
      )}
      <details className="tool-inspector-raw">
        <summary>Raw tool record</summary>
        <BoundedPayloadPreview value={record} label="raw tool record" />
      </details>
    </div>
  );
}

function toolInspectorRecord(
  tool: TranscriptRenderToolItem,
): Record<string, unknown> {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    status: tool.status,
    ...(tool.data === undefined ? {} : { data: tool.data }),
  };
}

export {
  BoundedPayloadPreview,
  boundedInspectorText,
  normalizeToolResultText,
  StructuredPayloadView,
  ToolInspector,
  toolInspectorRecord,
  toolInspectorRows,
  toolPresentationKind,
  toolPreviewLanguage,
};
