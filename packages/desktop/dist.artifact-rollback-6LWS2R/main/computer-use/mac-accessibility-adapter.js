import { ComputerOperationError, isComputerErrorCode, } from "@agent/computer-use";
function operationError(error, fallback) {
    if (error instanceof ComputerOperationError)
        return error;
    const code = error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (isComputerErrorCode(code))
        return new ComputerOperationError(code, message);
    if (/timed out/i.test(message))
        return new ComputerOperationError(fallback, message);
    return new ComputerOperationError("action_not_supported", message);
}
export class MacAccessibilityAdapter {
    constructor(gateway) {
        this.gateway = gateway;
    }
    async isTrusted() {
        try {
            await this.gateway.start();
            return await this.gateway.checkAccessibility();
        }
        catch {
            return false;
        }
    }
    async snapshot() {
        try {
            await this.gateway.start();
            return await this.gateway.snapshotAccessibility();
        }
        catch (error) {
            const failure = operationError(error, "observation_timeout");
            if (failure.code === "observation_timeout") {
                return { status: "timeout", message: failure.message };
            }
            return { status: "unavailable", message: failure.message };
        }
    }
    async ensureTrusted() {
        await this.gateway.start().catch((error) => {
            throw new ComputerOperationError("desktop_offline", error instanceof Error ? error.message : String(error));
        });
        if (!await this.gateway.checkAccessibility()) {
            throw new ComputerOperationError("accessibility_denied", "macOS Accessibility permission is required", "Enable AgentRoam in System Settings > Privacy & Security > Accessibility, then try again.");
        }
    }
    async perform(revision, nodeId, action) {
        await this.ensureTrusted();
        try {
            await this.gateway.performAccessibilityAction(revision, nodeId, action);
        }
        catch (error) {
            throw operationError(error, "action_timeout");
        }
    }
    async setText(revision, nodeId, text, replace) {
        await this.ensureTrusted();
        try {
            await this.gateway.setAccessibilityText(revision, nodeId, text, replace);
        }
        catch (error) {
            throw operationError(error, "action_timeout");
        }
    }
}
//# sourceMappingURL=mac-accessibility-adapter.js.map