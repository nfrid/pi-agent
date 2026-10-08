import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '@pi-dashboard/protocol/pi-runtime-protocol';

export type DashboardFileAttachment = {
  path: string;
  name: string;
  originalName: string;
  size: number;
};

function safeFilename(filename: string): string {
  const basename = path.basename(filename.replaceAll('\\', '/'));
  const extension = path
    .extname(basename)
    .replace(/[^.a-zA-Z0-9_-]/g, '')
    .slice(0, 24);
  const stem =
    path
      .basename(basename, path.extname(basename))
      .normalize('NFKC')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^[_-]+|[_-]+$/g, '')
      .slice(0, 80) || 'file';
  return `${stem}${extension}`;
}

/** Persists user files separately from temporary native image uploads. */
export class FileAttachmentService {
  private readonly directory: string;

  constructor(stateDir: string) {
    this.directory = path.join(stateDir, 'file-attachments');
  }

  async start(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700);
  }

  async save(
    files: readonly { name: string; data: Buffer }[],
  ): Promise<DashboardFileAttachment[]> {
    if (files.length > MAX_ATTACHMENT_COUNT)
      throw new Error('Attach no more than four files.');
    let total = 0;
    const created: DashboardFileAttachment[] = [];
    try {
      for (const file of files) {
        if (file.data.length > MAX_ATTACHMENT_BYTES)
          throw new Error('Each attachment must be no larger than 5 MiB.');
        total += file.data.length;
        if (total > MAX_ATTACHMENT_TOTAL_BYTES)
          throw new Error('Attachments exceed the 12 MiB total limit.');
        const basename =
          path.basename(file.name.replaceAll('\\', '/')) || 'file';
        const name = `${randomBytes(12).toString('hex')}-${safeFilename(basename)}`;
        const filePath = path.join(this.directory, name);
        await fs.writeFile(filePath, file.data, { mode: 0o600, flag: 'wx' });
        created.push({
          path: filePath,
          name,
          originalName: basename,
          size: file.data.length,
        });
      }
      return created;
    } catch (error) {
      await this.cleanup(created);
      throw error;
    }
  }

  async cleanup(files: readonly DashboardFileAttachment[]): Promise<void> {
    await Promise.all(
      files.map(({ path: file }) => fs.rm(file, { force: true })),
    );
  }
}

export function attachmentManifest(
  files: readonly DashboardFileAttachment[],
): string {
  if (files.length === 0) return '';
  return `\n\nDashboard file attachments (use these server-generated paths when needed):\n${files
    .map(
      (file) =>
        `- ${JSON.stringify(file.originalName)} (${file.size} bytes), saved as ${JSON.stringify(file.name)} at ${JSON.stringify(file.path)}`,
    )
    .join('\n')}`;
}
