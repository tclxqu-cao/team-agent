import { parseViewerRemoteVideoSignal } from '../remote-control/remote-video-signal.mjs';

/** Authorization must succeed before a viewer can change its JPEG delivery. */
export function relayViewerVideoSignal(registry, peer, sessionId, value, frameFlow) {
  const data = parseViewerRemoteVideoSignal(value);
  const result = registry.webrtcFromViewer(peer, sessionId, data);
  if (data.kind === 'start' || data.kind === 'stop'
    || data.kind === 'viewer-trace' && data.event === 'jpeg-fallback') frameFlow.setPaused(false);
  else if (data.kind === 'viewer-trace' && data.event === 'playback-ready') frameFlow.setPaused(true);
  return result;
}
