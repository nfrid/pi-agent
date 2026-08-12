import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  TranscriptModelItem,
  TranscriptStructuredResult,
} from '../../transcript';
import { StructuredDelegateResults, TranscriptEntry } from './entries';

describe('expanded transcript tool rows', () => {
  it('renders delegate structured output as labeled fields with raw JSON secondary', () => {
    const structuredResults: TranscriptStructuredResult[] = [
      {
        label: 'Audit',
        status: 'valid',
        value: {
          outcome: 'done',
          findings: [{ filePath: 'src/App.tsx', lineCount: 42 }],
        },
      },
    ];
    const item: TranscriptModelItem = {
      key: 'delegate-result',
      raw: {},
      entry: { kind: 'other', continuesGroup: true },
      event: {
        kind: 'delegate-result',
        label: 'Delegate finished · Audit',
        status: 'success',
        content: 'The audit completed successfully.',
        structuredResults,
      },
    };

    const markup = renderToStaticMarkup(
      <>
        <TranscriptEntry item={item} />
        <StructuredDelegateResults results={structuredResults} />
      </>,
    );

    expect(markup).toContain('aria-label="Structured delegate results"');
    expect(markup).toContain('<dt>Outcome</dt>');
    expect(markup).toContain('<dt>Findings</dt>');
    expect(markup).toContain('src/App.tsx');
    expect(markup).toContain('Raw JSON');
    expect(markup).toContain('&quot;outcome&quot;: &quot;done&quot;');
    expect(markup).not.toContain('StructuredPayloadView');
  });

  it('renders invalid and omitted delegate structured states explicitly', () => {
    const structuredResults: TranscriptStructuredResult[] = [
      {
        label: 'Invalid audit · Run 1',
        status: 'invalid',
        errors: ['/: expected result', '/: expected result'],
      },
      {
        label: 'Omitted audit · Run 1',
        status: 'valid',
        valueOmitted: true,
      },
    ];
    const markup = renderToStaticMarkup(
      <StructuredDelegateResults results={structuredResults} />,
    );

    expect(markup).toContain('/: expected result');
    expect(markup.match(/\/: expected result/g)).toHaveLength(2);
    expect(markup).toContain(
      'Structured result value unavailable in this bounded snapshot.',
    );
    expect(markup).not.toContain('Raw JSON');
  });

  it('shows an error marker for failed tool calls', () => {
    const item: TranscriptModelItem = {
      key: 'tool:error-call',
      raw: {},
      entry: {
        kind: 'tool',
        name: 'bash',
        args: { command: 'false' },
        status: 'error',
        isError: true,
      },
      tool: {
        kind: 'tool',
        key: 'tool:error-call',
        toolCallId: 'error-call',
        name: 'bash',
        arguments: { command: 'false' },
        result: 'Command failed',
        status: 'error',
        isError: true,
      },
    };

    const markup = renderToStaticMarkup(<TranscriptEntry item={item} />);

    expect(markup).toContain('tool-detail role-command step-failed');
    expect(markup).toContain(
      '<span class="activity-step-dot" aria-hidden="true">!</span>',
    );
  });
});
