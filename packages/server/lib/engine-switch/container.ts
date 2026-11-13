import {
  EngineSwitchLedger,
  SwitchEngineUseCase,
} from "@agent/core";
import { getEngineSwitchRepository } from "./state";
import { createNativeRuntimeEngineSwitchGateway } from "./native-runtime-gateway";

/**
 * Composition root for the engine-switch feature.
 *
 * Wires domain ports to infrastructure adapters:
 *   - SQLiteEngineSwitchRepository (core infrastructure) over the shared agent.db
 *   - native-runtime gateway (server infrastructure) over the native runtime
 * The use case and ledger contain no I/O of their own.
 */
export interface EngineSwitchContainer {
  useCase: SwitchEngineUseCase;
  ledger: EngineSwitchLedger;
}

export function getEngineSwitchContainer(): EngineSwitchContainer {
  const globalRef = globalThis as Record<string, unknown>;
  if (!globalRef.__engineSwitchContainer) {
    const repository = getEngineSwitchRepository();
    const runtime = createNativeRuntimeEngineSwitchGateway();
    globalRef.__engineSwitchContainer = {
      useCase: new SwitchEngineUseCase({ runtime, repository }),
      ledger: new EngineSwitchLedger(repository),
    } satisfies EngineSwitchContainer;
  }
  return globalRef.__engineSwitchContainer as EngineSwitchContainer;
}
