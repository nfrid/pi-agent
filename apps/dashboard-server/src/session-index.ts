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
  private readonly fileIds = new Map<string, string>();
  private watcher?: ReturnType<typeof import('node:fs').watch>;
  private watcherRetry?: NodeJS.Timeout;
  private workspaces: readonly WorkspaceTarget[] = [];
  constructor(
    private readonly sessionDir: string,
    private readonly metadata?: MetadataStore,
  ) {}

  async rebuild(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    this.files.clear();
    this.fileIds.clear();
    const paths = await this.findJsonl(this.sessionDir);
    for (const file of paths)
      await this.indexFile(file, this.workspaces).catch(() => undefined);
  }

  async start(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
    await this.ensureWatcher();
  }

  async refresh(workspaces: readonly WorkspaceTarget[] = []): Promise<void> {
    this.workspaces = workspaces;
    await this.rebuild(this.workspaces);
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
    const { header: _header, ...metadata } = indexed;
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
    return { metadata, entries };
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.watcherRetry) clearTimeout(this.watcherRetry);
    this.watcherRetry = undefined;
  }

  private async ensureWatcher(): Promise<void> {
    if (this.watcher) return;
    try {
      const fsModule = await import('node:fs');
      this.watcher = fsModule.watch(
        this.sessionDir,
        { recursive: true },
        (_event, filename) => {
          if (!filename) {
            void this.rebuild(this.workspaces);
            return;
          }
          const file = path.resolve(this.sessionDir, String(filename));
          if (file.endsWith('.jsonl'))
            void this.indexFile(file, this.workspaces).catch(() =>
              this.removeFile(file),
            );
          else void this.rebuild(this.workspaces);
        },
      );
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.scheduleWatcherRetry();
      });
    } catch {
      // The session directory may not exist yet, or the platform may not
      // support recursive fs.watch. Retry so a later-created directory works.
      this.scheduleWatcherRetry();
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry) return;
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = undefined;
      void this.ensureWatcher();
    }, 1_000);
    this.watcherRetry.unref?.();
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
    try {
      const text = await fs.readFile(resolved, 'utf8');
      const first = text.split('\n').find((line) => line.trim());
      if (!first) return this.removeFile(resolved);
      const header = JSON.parse(first) as Record<string, unknown>;
      if (header.type !== 'session' || typeof header.cwd !== 'string')
        return this.removeFile(resolved);
      const stat = statSync(resolved);
      const id =
        typeof header.id === 'string' ? header.id : this.idForPath(resolved);
      const previous = this.files.get(id);
      if (previous && previous.file !== resolved)
        this.fileIds.delete(previous.file);
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
      this.fileIds.set(resolved, id);
      this.metadata?.saveSession(entry);
    } catch (error) {
      this.removeFile(resolved);
      throw error;
    }
  }

  private removeFile(file: string): void {
    const resolved = path.resolve(file);
    const id = this.fileIds.get(resolved);
    this.fileIds.delete(resolved);
    if (id && this.files.get(id)?.file === resolved) this.files.delete(id);
  }
}
