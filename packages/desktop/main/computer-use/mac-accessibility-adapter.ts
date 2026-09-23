import {
  ComputerOperationError,
  isComputerErrorCode,
  type AccessibilitySnapshotResult,
} from "@agent/computer-use";

export interface MacAccessibilityGateway {
  start(): Promise<void>;
  checkAccessibility(): Promise<boolean>;
  snapshotAccessibility(): Promise<AccessibilitySnapshotResult>;
  performAccessibilityAction(revision: string, nodeId: string, action: "press" | "focus"): Promise<void>;
  setAccessibilityText(revision: string, nodeId: string, text: string, replace: boolean): Promise<void>;
}

function operationError(error: unknown, fallback: "observation_timeout" | "action_timeout"): ComputerOperationError {
  if (error instanceof ComputerOperationError) return error;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (isComputerErrorCode(code)) return new ComputerOperationError(code, message);
  if (/timed out/i.test(message)) return new ComputerOperationError(fallback, message);
  return new ComputerOperationError("action_not_supported", message);
}

export class MacAccessibilityAdapter {
  constructor(private readonly gateway: MacAccessibilityGateway) {}

  async isTrusted(): Promise<boolean> {
    try {
      await this.gateway.start();
      return await this.gateway.checkAccessibility();
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<AccessibilitySnapshotResult> {
    try {
      await this.gateway.start();
      return await this.gateway.snapshotAccessibility();
    } catch (error) {
      const failure = operationError(error, "observation_timeout");
      if (failure.code === "observation_timeout") {
        return { status: "timeout", message: failure.message };
      }
      return { status: "unavailable", message: failure.message };
    }
  }

  async ensureTrusted(): Promise<void> {
    await this.gateway.start().catch((error) => {
      throw new ComputerOperationError("desktop_offline", error instanceof Error ? error.message : String(error));
    });
    if (!await this.gateway.checkAccessibility()) {
      throw new ComputerOperationError(
        "accessibility_denied",
        "macOS Accessibility permission is required",
        "Enable AgentRoam in System Settings > Privacy & Security > Accessibility, then try again.",
      );
    }
  }

  async perform(revision: string, nodeId: string, action: "press" | "focus"): Promise<void> {
    await this.ensureTrusted();
    try {
      await this.gateway.performAccessibilityAction(revision, nodeId, action);
    } catch (error) {
      throw operationError(error, "action_timeout");
    }
  }

  async setText(revision: string, nodeId: string, text: string, replace: boolean): Promise<void> {
    await this.ensureTrusted();
    try {
      await this.gateway.setAccessibilityText(revision, nodeId, text, replace);
    } catch (error) {
      throw operationError(error, "action_timeout");
    }
  }
}
