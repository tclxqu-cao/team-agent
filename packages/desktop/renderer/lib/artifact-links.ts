import { WEBAPP_ARTIFACT_OPEN_TYPE } from "../../../core/src/domain/web-console/WebArtifactBridge";

export type ArtifactBridgeWindow = Pick<Window, "location"> & {
  parent: Pick<Window, "postMessage">;
};

let requestSequence = 0;

export function postWebArtifactOpen(
  path: string,
  context: ArtifactBridgeWindow = window,
): boolean {
  if ((context.parent as unknown) === context) return false;
  requestSequence += 1;
  context.parent.postMessage({
    type: WEBAPP_ARTIFACT_OPEN_TYPE,
    requestId: requestSequence,
    path,
  }, context.location.origin);
  return true;
}
