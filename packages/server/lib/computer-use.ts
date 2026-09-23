import { AgentBuilder } from "@agent/core";
import {
  COMPUTER_USE_SKILL,
  COMPUTER_RELAY_PROTOCOL_VERSION,
  ComputerRelayClient,
  ComputerTool,
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
  options: { probe?: ComputerRuntimePort; runtime?: ComputerRuntimePort } = {},
): Promise<CustomerComputerRegistration> {
  const probe = options.probe ?? new ComputerRelayClient({ timeoutMs: 1_000 });
  let status: ComputerRuntimeStatus;
  try {
    status = await probe.status();
  } catch {
    status = { available: false };
  }
  if (!isCompatibleComputerRuntime(status)) return { registered: false, status };
  builder.withTool(new ComputerTool(options.runtime ?? new ComputerRelayClient()));
  return { registered: true, status };
}
