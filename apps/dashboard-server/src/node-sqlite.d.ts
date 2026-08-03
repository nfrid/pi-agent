declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(
      location: string,
      options?: {
        readOnly?: boolean;
        timeout?: number;
        enableForeignKeyConstraints?: boolean;
      },
    );
    exec(sql: string): void;
    prepare(sql: string): {
      run(...parameters: unknown[]): {
        changes: number;
        lastInsertRowid: number | bigint;
      };
      get(...parameters: unknown[]): Record<string, unknown> | undefined;
      all(...parameters: unknown[]): Record<string, unknown>[];
    };
    close(): void;
  }
}
