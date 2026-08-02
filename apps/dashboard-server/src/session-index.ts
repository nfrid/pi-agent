import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import type {
  SessionIndexEntry,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';

interface IndexedFile extends SessionIndexEntry {
  header: Record<string, unknown>;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function workspaceFor(
  cwd: string,
  workspaces: readonly WorkspaceTarget[],
): string | undefined {
  const normalized = path.resolve(cwd);
  const exact = workspaces.find(
    (workspace) => workspace.canonicalPath === normalized,
  );
  if (exact) return exact.id;
  return workspaces.find((workspace) =>
    normalized.startsWith(`${workspace.canonicalPath}${path.sep}`),
  )?.id;
}

export class SessionIndex {
  private readonly files = new Map<string, IndexedFile>();
  private watcher?: ReturnType<typeof import('node:fs').watch>;
  constructor(
    private readonly sessionDir: string,
    private readonly metadata?: MetadataStore,
  ) {}

  async rebuild(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.files.clear();
    const paths = await this.findJsonl(this.sessionDir);
    for (const file of paths)
      await this.indexFile(file, workspaces).catch(() => undefined);
  }

  async start(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    await this.rebuild(workspaces);
    try {
      this.watcher = (await import('node:fs')).watch(
        this.sessionDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) return;
          const file = path.resolve(this.sessionDir, String(filename));
          void this.indexFile(file, workspaces).catch(() =>
            this.files.delete(this.idForPath(file)),
          );
        },
      );
      this.watcher.on('error', () => undefined);
    } catch {
      // Some platforms do not support recursive fs.watch; requests remain valid.
    }
  }

  async refresh(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    await this.rebuild(workspaces);
  }

  list(workspaceId?: string): SessionIndexEntry[] {
    return [...this.files.values()]
      .filter((file) => !workspaceId || file.workspaceId === workspaceId)
      .map(({ header: _header, ...entry }) => entry)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionIndexEntry | undefined {
    const entry = this.files.get(id);
    if (!entry) return undefined;
    const { header: _header, ...publicEntry } = entry;
    return publicEntry;
  }

  async readEntries(
    id: string,
  ): Promise<{ metadata: SessionIndexEntry; entries: unknown[] }> {
    const indexed = this.files.get(id);
    if (!indexed || !within(path.resolve(this.sessionDir), indexed.file))
      throw new Error('Unknown session.');
    const text = await fs.readFile(indexed.file, 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024)
      throw new Error('Session is too large to open remotely.');
    const entries: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as unknown);
      } catch {
        /* tolerate a partial final line */
      }
    }
    return { metadata: this.get(id) as SessionIndexEntry, entries };
  }

  close(): void {
    this.watcher?.close();
  }

  private async findJsonl(directory: string): Promise<string[]> {
    const result: string[] = [];
    let children: import('node:fs').Dirent[] = [];
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return result;
    }
    for (const child of children) {
      const file = path.join(directory, child.name);
      if (child.isDirectory()) result.push(...(await this.findJsonl(file)));
      else if (child.isFile() && child.name.endsWith('.jsonl'))
        result.push(file);
    }
    return result;
  }

  private idForPath(file: string): string {
    return path.basename(file, '.jsonl');
  }

  private async indexFile(
    file: string,
    workspaces: readonly WorkspaceTarget[],
  ): Promise<void> {
    const root = path.resolve(this.sessionDir);
    const resolved = path.resolve(file);
    if (!within(root, resolved) || !resolved.endsWith('.jsonl')) return;
    const text = await fs.readFile(resolved, 'utf8');
    const first = text.split('\n').find((line) => line.trim());
    if (!first) return;
    const header = JSON.parse(first) as Record<string, unknown>;
    if (header.type !== 'session' || typeof header.cwd !== 'string') return;
    const stat = statSync(resolved);
    const id =
      typeof header.id === 'string' ? header.id : this.idForPath(resolved);
    const entry: IndexedFile = {
      id,
      file: resolved,
      cwd: header.cwd,
      workspaceId: workspaceFor(header.cwd, workspaces),
      name: typeof header.name === 'string' ? header.name : undefined,
      updatedAt: stat.mtimeMs,
      entryCount: text.split('\n').filter((line) => line.trim()).length,
      header,
    };
    this.files.set(id, entry);
    this.metadata?.saveSession(entry);
  }
}
