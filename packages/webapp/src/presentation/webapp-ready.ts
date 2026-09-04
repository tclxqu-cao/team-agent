export const WEBAPP_READY_MESSAGE_TYPE = "agent-webapp:ready:v1";

export function announceWebappReady(): void {
  if (window.parent === window) return;
  window.parent.postMessage(
    { type: WEBAPP_READY_MESSAGE_TYPE },
    window.location.origin,
  );
}
