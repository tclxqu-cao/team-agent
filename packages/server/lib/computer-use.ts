import { AgentBuilder, sharedDesktopControl, type DesktopRun } from "@agent/core";
import {
  COMPUTER_USE_SKILL,
  COMPUTER_RELAY_PROTOCOL_VERSION,
  ComputerRelayClient,
  ComputerOperationError,
  ComputerTool,
  isMutatingComputerAction,
  type ComputerRuntimePort,
  type ComputerRuntimeStatus,
} from "@agent/computer-use";

export interface CustomerComputerRegistration {
  registered: boolean;
  status: ComputerRuntimeStatus;
}

export function isCompatibleComputerRuntime(status: ComputerRuntimeStatus): boolean {
  return status.available === true
    && status.platform === "darwin"
    && status.protocolVersion === COMPUTER_RELAY_PROTOCOL_VERSION;
}

/** Registers the built-in Skill independently from desktop relay availability. */
export function registerCustomerComputerSkill(builder: AgentBuilder): void {
  builder.getSkillRegistry().register(COMPUTER_USE_SKILL);
}

/** Adds the extension to a built Customer Agent loop only when Electron owns a compatible relay. */
export async function registerCustomerComputerTool(
  builder: AgentBuilder,
  options: { probe?: ComputerRuntimePort; runtime?: ComputerRuntimePort; run?: DesktopRun } = {},
): Promise<CustomerComputerRegistration> {
  const probe = options.probe ?? new ComputerRelayClient({ timeoutMs: 1_000 });
  let status: ComputerRuntimeStatus;
  try {
    status = await probe.status();
  } catch {
    status = { available: false };
  }
  if (!isCompatibleComputerRuntime(status)) return { registered: false, status };
  const run = options.run;
  const runtime = options.runtime ?? new ComputerRelayClient({ timeoutMs: run ? null : undefined });
  let observationLease = 0;
  let accessibilityRevision: string | null = null;
  let hasScreenshot = false;
  builder.withTool(new ComputerTool(run ? {
    status: (signal) => runtime.status(signal),
    async execute(action, signal) {
      try {
        return await sharedDesktopControl().execute(run, isMutatingComputerAction(action), async (leaseId) => {
          if (observationLease !== leaseId) {
            observationLease = leaseId;
            accessibilityRevision = null;
            hasScreenshot = false;
          }
          if ("revision" in action && action.revision !== accessibilityRevision) {
            throw new ComputerOperationError("stale_observation", "Accessibility observation belongs to an earlier desktop operation", "Call computer with action=observe and use its latest revision and node IDs.");
          }
          if (("x" in action || action.action === "drag") && !hasScreenshot) {
            throw new ComputerOperationError("stale_observation", "This desktop lease has no screenshot", "Call computer with action=screenshot before using pixel coordinates.");
          }
          const observation = await runtime.execute(action);
          if (observation.source === "accessibility") accessibilityRevision = observation.revision;
          else hasScreenshot = true;
          return observation;
        }, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "DesktopObservationRequired") {
          throw new ComputerOperationError("stale_observation", error.message, "Call computer with action=observe or screenshot before sending input.");
        }
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new ComputerOperationError("aborted", "Computer action was cancelled");
        }
        throw error;
      }
    },
  } : runtime));
  return { registered: true, status };
}
