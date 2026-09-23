import type { ComputerAction } from "../domain/computer-action.js";
import type { ComputerObservation } from "../domain/computer-observation.js";

export interface ComputerRuntimeStatus {
  available: boolean;
  protocolVersion?: number;
  platform?: string;
  desktopLocked?: boolean;
  accessibility?: boolean;
  screenRecording?: boolean;
  vision?: boolean;
}

export interface ComputerRuntimePort {
  status(signal?: AbortSignal): Promise<ComputerRuntimeStatus>;
  execute(action: ComputerAction, signal?: AbortSignal): Promise<ComputerObservation>;
}
