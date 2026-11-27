import { z } from "zod";
/** TUI and other embedded loops must opt into an explicit service descriptor;
 * their working directory never selects the user's Todo database. */
export declare function provisionedTodoTools(descriptorPath?: string, registry?: string): Promise<{
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
    };
    schema: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    networkAccess: "write";
    execute(input: Record<string, unknown>): Promise<{
        toolCallId: string;
        content: string;
        isError?: undefined;
    } | {
        toolCallId: string;
        content: string;
        isError: boolean;
    }>;
}[]>;
//# sourceMappingURL=provisioned-todo-tools.d.ts.map