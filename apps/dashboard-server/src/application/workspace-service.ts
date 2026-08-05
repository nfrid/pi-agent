import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import type { MetadataStore } from '../metadata.js';
import type { RuntimeManager } from '../runtime-manager.js';
import type { SeshAdapter } from '../sesh.js';
import type { SessionIndex } from '../session-index.js';

/** Workspace discovery is isolated from runtime command and HTTP concerns. */
export class WorkspaceService {
  private workspaces: WorkspaceTarget[] = [];

  constructor(
    private readonly sesh: SeshAdapter,
    private readonly manager: RuntimeManager,
    private readonly sessions: SessionIndex,
    private readonly metadata: MetadataStore,
    private readonly onChange?: () => void,
  ) {}

  list(): WorkspaceTarget[] {
    return this.workspaces;
  }

  async refresh(): Promise<WorkspaceTarget[]> {
    try {
      this.workspaces = await this.sesh.list();
      this.manager.setWorkspaces(this.workspaces);
      for (const workspace of this.workspaces)
        this.metadata.saveWorkspace(workspace);
      await this.sessions.refresh(this.workspaces);
      this.onChange?.();
    } catch {
      // Catalogue failures must not interrupt already connected runtimes.
    }
    return this.workspaces;
  }

  set(workspaces: readonly WorkspaceTarget[]): void {
    this.workspaces = [...workspaces];
    this.manager.setWorkspaces(this.workspaces);
  }
}
