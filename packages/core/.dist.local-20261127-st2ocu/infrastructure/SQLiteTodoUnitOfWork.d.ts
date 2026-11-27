import type Database from "better-sqlite3";
import type { ITodoUnitOfWork, TodoTransaction } from "../domain/todo/ports";
export declare function migrateTodoTables(db: Database.Database): void;
/** Each command and occurrence, including its receipt and notifications, commits
 * on one database handle. No session foreign keys: Todos outlive conversations. */
export declare class SQLiteTodoUnitOfWork implements ITodoUnitOfWork {
    private readonly db;
    private readonly repositories;
    constructor(db: Database.Database);
    run<T>(work: (tx: TodoTransaction) => T): T;
}
//# sourceMappingURL=SQLiteTodoUnitOfWork.d.ts.map