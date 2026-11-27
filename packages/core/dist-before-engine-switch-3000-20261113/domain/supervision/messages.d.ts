import type { CollaborationGroup } from "../collaboration/types.js";
import type { SupervisionIncident, SupervisionMessage } from "./types.js";
/** The same saved incident projection is used for live updates and legacy history. */
export declare function incidentMessage(group: CollaborationGroup, incident: SupervisionIncident, historical?: boolean): SupervisionMessage;
//# sourceMappingURL=messages.d.ts.map