import { inspectCodexDesktop } from "./codex-desktop-status.js";

// Invoked only by the packaged launcher, after daemon preflight and immediately
// before graceful quit. Runtime installation may have taken minutes since setup.
try {
  const snapshot = await inspectCodexDesktop(process.env);
  if (snapshot.status !== "running" || String(snapshot.pid) !== process.env.AGENTROAM_CODEX_DESKTOP_EXPECTED_PID
    || snapshot.activity.state !== "idle") {
    console.error("Desktop is no longer confirmed idle; no automatic restart attempted. Run agentroam codex-desktop --setup to choose again.");
    process.exitCode = 1;
  }
} catch {
  console.error("Desktop idle check failed; no automatic restart attempted.");
  process.exitCode = 1;
}
