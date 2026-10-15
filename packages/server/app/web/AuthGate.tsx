"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useWebAuth } from "./useWebAuth";
import WorkspaceBoot from "./WorkspaceBoot";
export { connectionElapsedSeconds } from "./WorkspaceBoot";
export type WebAuthController = ReturnType<typeof useWebAuth>;

interface AuthGateProps {
  children: (auth: WebAuthController, onWorkspaceReady: () => void) => ReactNode;
}

/** Keep one boot surface mounted across gateway auth and WebApp hydration. */
export default function AuthGate({ children }: AuthGateProps) {
  const auth = useWebAuth();
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const authenticated = auth.status === "authenticated";
  const markWorkspaceReady = useCallback(() => setWorkspaceReady(true), []);
  useEffect(() => { if (!authenticated) setWorkspaceReady(false); }, [authenticated]);
  return <>
    {authenticated ? children(auth, markWorkspaceReady) : null}
    <WorkspaceBoot ready={authenticated && workspaceReady} error={auth.error} onRetry={() => void auth.refresh()} />
  </>;
}
