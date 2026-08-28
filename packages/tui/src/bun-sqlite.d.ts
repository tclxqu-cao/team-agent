declare module "bun:sqlite" {
  interface Statement {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  }

  export class Database {
    constructor(filename: string, options?: { readonly?: boolean; create?: boolean });
    query(sql: string): Statement;
    close(): void;
  }
}
