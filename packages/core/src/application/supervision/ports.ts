import type { CollaborationGroup } from "../../domain/collaboration/types.js";
import type { InterventionReceipt, MonitoredSession, SessionObservation, SupervisionDecision, SupervisionIncident, SupervisionState } from "../../domain/supervision/types.js";

export interface SupervisionRepository {
  get(groupId: string): SupervisionState | null;
  initialize(state: SupervisionState): SupervisionState;
  save(state: SupervisionState, expectedGeneration?: number): boolean;
  claim(groupId: string, owner: string, now: number, ttl: number): boolean;
  claimTarget(sessionId: string, owner: string, now: number, ttl: number): boolean;
}
export interface SupervisionRuntime {
  observe(target: MonitoredSession): Promise<SessionObservation>;
  evaluate(state: SupervisionState, observation: SessionObservation, signal: AbortSignal): Promise<SupervisionDecision>;
  continue(target: MonitoredSession, text: string, actionId: string): Promise<InterventionReceipt>;
  handoff(state: SupervisionState, source: MonitoredSession, target: MonitoredSession, text: string, actionId: string, signal: AbortSignal): Promise<InterventionReceipt>;
  answer(target: MonitoredSession, questionId: string, answer: string, indices?: number[]): Promise<boolean>;
  notify(group: CollaborationGroup, incident: SupervisionIncident): Promise<void>;
}
