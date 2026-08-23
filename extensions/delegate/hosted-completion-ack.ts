import {
  type BackgroundJobSnapshot,
  BackgroundJobsClient,
} from '@pi-agent/background-jobs';
import type {
  DelegateWorkflowAttemptSnapshot,
  DelegateWorkflowCoordinator,
} from './workflow-coordinator';

const MAX_ENTERED_SOURCES = 256;

export interface HostedCompletionAckClient {
  inspect(id: string): Promise<BackgroundJobSnapshot | undefined>;
  markDelivered(id: string): Promise<void>;
}

export interface HostedCompletionAckerOptions {
  ownerSessionId: string;
  getWorkflow: () => DelegateWorkflowCoordinator | undefined;
  client?: HostedCompletionAckClient;
}

function terminal(attempt: DelegateWorkflowAttemptSnapshot): boolean {
  return (
    attempt.state === 'success' ||
    attempt.state === 'error' ||
    attempt.state === 'timed-out' ||
    attempt.state === 'aborted' ||
    attempt.state === 'cancelled' ||
    attempt.state === 'blocked'
  );
}

function hostTerminal(job: BackgroundJobSnapshot): boolean {
  return job.status !== 'running';
}

/**
 * Acknowledges durable hosted completions only after their exact workflow
 * source has entered parent model context through a validated wake message.
 */
export class HostedCompletionAcker {
  private readonly client: HostedCompletionAckClient;
  private readonly delivered = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: HostedCompletionAckerOptions) {
    this.client =
      options.client ??
      new BackgroundJobsClient(undefined, options.ownerSessionId);
  }

  async entered(sources: readonly string[]): Promise<void> {
    const workflow = this.options.getWorkflow();
    if (!workflow) return;
    const processJobIds = new Set<string>();
    for (const identity of sources.slice(0, MAX_ENTERED_SOURCES)) {
      const attempt = workflow.get(identity);
      if (!attempt || !terminal(attempt) || !attempt.processJobId) continue;
      processJobIds.add(attempt.processJobId);
    }
    await Promise.all(
      [...processJobIds].map((processJobId) => this.ack(processJobId)),
    );
  }

  private ack(processJobId: string): Promise<void> {
    if (this.delivered.has(processJobId)) return Promise.resolve();
    const existing = this.inFlight.get(processJobId);
    if (existing) return existing;
    const pending = this.inspectAndAck(processJobId).finally(() => {
      this.inFlight.delete(processJobId);
    });
    this.inFlight.set(processJobId, pending);
    return pending;
  }

  private async inspectAndAck(processJobId: string): Promise<void> {
    const job = await this.client.inspect(processJobId);
    if (!job || !hostTerminal(job)) return;
    if (job.completionDelivered !== true)
      await this.client.markDelivered(processJobId);
    this.delivered.add(processJobId);
  }
}
