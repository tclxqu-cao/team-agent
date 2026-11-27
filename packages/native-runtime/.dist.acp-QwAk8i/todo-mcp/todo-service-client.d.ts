export interface TodoClientOptions {
    serviceId: string;
    descriptorPath: string;
    registry?: string;
}
interface CredentialFile {
    serviceId: string;
    token: string;
    scope: "manage" | "execution" | "relay";
    discoveryDirectory?: string;
}
export declare class TodoServiceClient {
    private readonly options;
    private readonly request;
    constructor(options: TodoClientOptions, request?: typeof fetch);
    credential(): Promise<CredentialFile>;
    call(operation: string, args?: unknown): Promise<any>;
}
export {};
//# sourceMappingURL=todo-service-client.d.ts.map