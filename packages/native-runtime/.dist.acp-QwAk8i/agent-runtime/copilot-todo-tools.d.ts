import { provisionedTodoTools } from "../todo-mcp/provisioned-todo-tools.js";
import type { CopilotAhpConnection } from "./copilot-ahp-connection.js";
import type { NativeTodoMcpConfiguration } from "./runtime-tool-injection.js";
/** AHP client tools stay on their native session and execute only for the
 * explicitly admitted chat/turn. Other clients' contributions are preserved. */
export declare class CopilotTodoTools {
    private readonly provision;
    private readonly sessions;
    constructor(provision?: typeof provisionedTodoTools);
    attach(host: CopilotAhpConnection, session: string, chat: string, turnId: string, config: NativeTodoMcpConfiguration, onFailure?: (error: Error) => void): Promise<() => Promise<void>>;
}
//# sourceMappingURL=copilot-todo-tools.d.ts.map