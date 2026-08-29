declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message?: unknown, ...args: unknown[]) => void;
    nativeBinding?: string;
  }

  class BetterSqlite3 {
    constructor(filename: string, options?: Options);
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(sql: string, options?: { simple?: boolean }): unknown;
    transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
    close(): void;
  }

  export = BetterSqlite3;
}
