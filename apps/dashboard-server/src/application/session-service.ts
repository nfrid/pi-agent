import type { SessionIndexEntry } from '@pi-dashboard/protocol';
import type { SessionIndex } from '../session-index.js';

/** Session catalogue and transcript access; it never receives an HTTP request. */
export class SessionService {
  constructor(private readonly index: SessionIndex) {}

  list(workspaceId?: string): SessionIndexEntry[] {
    return this.index.list(workspaceId);
  }

  async read(id: string) {
    return this.index.readEntries(id);
  }

  async rename(id: string, name: string) {
    return this.index.rename(id, name);
  }

  get(id: string): SessionIndexEntry | undefined {
    return this.index.get(id);
  }
}
