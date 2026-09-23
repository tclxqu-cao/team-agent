import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_TEXT = "AgentRoam computer smoke";
const LIMITATION_ERRORS = new Set(["accessibility_denied", "screen_recording_denied", "desktop_offline", "desktop_locked"]);

function latestToolMessage(messages) {
  return [...messages].reverse().find((message) => message.role === "tool");
}

function latestObservation(messages) {
  const message = [...messages].reverse().find((candidate) => candidate.name === "__tool_observation__");
  if (!message) return null;
  const marker = message.content.lastIndexOf("---\n");
  if (marker < 0) return null;
  return JSON.parse(message.content.slice(marker + 4));
}

function toolError(messages) {
  const message = latestToolMessage(messages);
  if (!message?.isError) return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return { error: "protocol_error", message: message.content };
  }
}

function findNode(observation, identifier) {
  return observation?.nodes?.find((node) => node.identifier === identifier);
}

function coordinateFromScreenshot(bounds, image) {
  const logicalX = bounds.x + bounds.width / 2;
  const logicalY = bounds.y + bounds.height / 2;
  return {
    x: Math.round(((logicalX - image.originX) / image.logicalWidth) * image.width),
    y: Math.round(((logicalY - image.originY) / image.logicalHeight) * image.height),
  };
}

export function createComputerSmokeModel() {
  const state = {
    phase: 0,
    outcome: null,
    limitation: null,
    failure: null,
    calls: [],
    toolPolicyVerified: false,
    firstRevision: null,
    staleButtonId: null,
    canvasBounds: null,
    screenshotDelivered: false,
  };
  let callSequence = 0;

  const call = (action) => {
    state.calls.push(action);
    callSequence += 1;
    return { type: "tool_call", toolCall: { id: `computer-smoke-${callSequence}`, name: "computer", arguments: action } };
  };
  const finish = (outcome, message, limitation = null) => {
    state.outcome = outcome;
    state.limitation = limitation;
    return { type: "text_chunk", text: message };
  };
  const fail = (message) => {
    state.failure = message;
    state.outcome = "failed";
    return { type: "error", message };
  };

  const provider = {
    providerId: "computer-smoke",
    modelId: "deterministic-computer-smoke",
    countTokens: async () => 1,
    countRequestTokens: async () => 128,
    getContextWindow: async () => 32_768,
    supportsModel: () => true,
    async *streamChat(messages, options) {
      const computer = options?.tools?.find((tool) => tool.name === "computer");
      if (!computer) {
        yield fail("computer tool was not available to the model");
        return;
      }
      const unexpectedTools = options.tools.filter((tool) => !["computer", "skill_load", "skill_discover"].includes(tool.name));
      if (unexpectedTools.length > 0) {
        yield fail(`unexpected enabled tools: ${unexpectedTools.map((tool) => tool.name).join(",")}`);
        return;
      }
      state.toolPolicyVerified = computer.description.includes("only when the user explicitly asks")
        && computer.description.includes("task cannot continue without")
        && computer.description.includes("being available is not permission or a reason to call it")
        && computer.description.includes("do not call this tool");
      if (!state.toolPolicyVerified) {
        yield fail("computer tool invocation policy is incomplete");
        return;
      }

      const error = toolError(messages);
      if (error) {
        if (state.phase === 3 && error.error === "stale_observation") {
          state.phase = 4;
          yield call({ action: "observe" });
          yield { type: "text_done" };
          return;
        }
        if (LIMITATION_ERRORS.has(error.error)) {
          yield finish("limited", `Computer smoke limited by ${error.error}.`, error);
          yield { type: "text_done" };
          return;
        }
        yield fail(`unexpected computer error at phase ${state.phase}: ${error.error ?? error.message}`);
        return;
      }

      if (state.phase === 0) {
        state.phase = 1;
        yield call({ action: "observe" });
        yield { type: "text_done" };
        return;
      }

      const observation = latestObservation(messages);
      if (!observation) {
        yield fail(`phase ${state.phase} did not receive a model-only observation`);
        return;
      }
      if (observation.source !== "accessibility") {
        yield finish("limited", "Computer smoke needs Accessibility for node actions.", {
          error: "accessibility_denied",
          message: `observe returned ${observation.source}`,
        });
        yield { type: "text_done" };
        return;
      }

      if (state.phase === 1) {
        const field = findNode(observation, "computer-fixture.text");
        const button = findNode(observation, "computer-fixture.press");
        if (!field || !button) {
          yield fail("fixture text field or button was absent from the Accessibility tree");
          return;
        }
        state.firstRevision = observation.revision;
        state.staleButtonId = button.id;
        state.phase = 2;
        yield call({ action: "type", revision: observation.revision, nodeId: field.id, text: FIXTURE_TEXT, replace: true });
      } else if (state.phase === 2) {
        state.phase = 3;
        yield call({ action: "press", revision: state.firstRevision, nodeId: state.staleButtonId });
      } else if (state.phase === 4) {
        const button = findNode(observation, "computer-fixture.press");
        if (!button) {
          yield fail("fixture button was absent after refreshing the Accessibility tree");
          return;
        }
        state.phase = 5;
        yield call({ action: "press", revision: observation.revision, nodeId: button.id });
      } else if (state.phase === 5) {
        const canvas = findNode(observation, "computer-fixture.canvas");
        if (!canvas?.bounds) {
          yield fail("fixture canvas bounds were absent from the Accessibility tree");
          return;
        }
        state.canvasBounds = canvas.bounds;
        state.phase = 6;
        yield call({ action: "screenshot" });
      } else if (state.phase === 6) {
        yield fail("screenshot response was reported as Accessibility instead of screenshot data");
        return;
      } else if (state.phase === 7) {
        state.phase = 8;
        yield finish("passed", "Computer smoke completed.");
        yield { type: "text_done" };
        return;
      } else {
        yield fail(`unexpected computer smoke phase ${state.phase}`);
        return;
      }
      yield { type: "text_done" };
    },
  };

  const originalStream = provider.streamChat.bind(provider);
  provider.streamChat = async function* (messages, options) {
    if (state.phase === 6 && !toolError(messages)) {
      const screenshot = latestObservation(messages);
      if (screenshot?.source === "screenshot" && state.canvasBounds) {
        state.screenshotDelivered = Boolean(messages.at(-1)?.images?.[0]?.startsWith("data:image/"));
        if (!state.screenshotDelivered) {
          yield fail("screenshot bytes did not reach the next model request");
          return;
        }
        state.phase = 7;
        yield call({ action: "click", ...coordinateFromScreenshot(state.canvasBounds, screenshot.image) });
        yield { type: "text_done" };
        return;
      }
    }
    yield* originalStream(messages, options);
  };

  return { provider, state };
}

export async function runComputerAgentLoop(options = {}) {
  const [{ AgentBuilder, ToolPermissionGate }, { registerCustomerComputerTool }] = await Promise.all([
    import("../packages/core/src/index.ts"),
    import("../packages/server/lib/computer-use.ts"),
  ]);
  const { provider, state } = createComputerSmokeModel();
  const approvals = [];
  const builder = new AgentBuilder()
    .withWorkingDirectory(options.workingDirectory ?? tmpdir())
    .withModelProvider(provider)
    .withExactEnabledTools(["computer"])
    .withExactEnabledSkills([])
    .withSemanticSkillMatching(false)
    .withSkillDiscovery(false)
    .withMaxIterations(12)
    .withToolPermissionGate(new ToolPermissionGate({
      resolveMode: () => "request-approval",
      requestApproval: async (request) => {
        approvals.push(request);
        return "deny";
      },
    }));
  const registration = await registerCustomerComputerTool(builder, options.registrationOptions);
  if (!registration.registered) {
    return {
      outcome: "limited",
      status: registration.status,
      limitation: { error: "desktop_offline", message: "compatible macOS desktop relay is unavailable" },
      approvals,
      events: [],
      state,
    };
  }

  const agent = await builder.build();
  const events = [];
  for await (const event of agent.run(
    "Explicitly use the computer tool to verify the AgentRoam macOS fixture.",
    `computer-smoke-${Date.now()}`,
  )) events.push(event);

  const publicPayload = JSON.stringify(events);
  const publicPayloadLeaked = publicPayload.includes("data:image/")
    || publicPayload.includes("computer-fixture.text")
    || publicPayload.includes("computer-fixture.canvas");
  return {
    outcome: state.outcome ?? "failed",
    status: registration.status,
    limitation: state.limitation,
    failure: state.failure,
    approvals,
    publicPayloadLeaked,
    events,
    state,
  };
}

export async function runOwnershipProbe(options = {}) {
  const [{ DesktopComputerRuntime }, { ComputerRelayServer }, { ComputerRelayClient }] = await Promise.all([
    import("../packages/desktop/main/computer-use/desktop-computer-runtime.ts"),
    import("../packages/desktop/main/computer-use/computer-relay-server.ts"),
    import("../packages/computer-use/src/index.ts"),
  ]);
  const observation = {
    source: "accessibility",
    revision: "ownership_1",
    coverage: "complete",
    app: { name: "Ownership Fixture", bundleId: "dev.agentroam.ownership", pid: process.pid },
    nodes: [{
      id: "ownership_1:1",
      role: "AXButton",
      name: "Read-only ownership probe",
      actions: ["AXPress"],
    }],
  };
  let inputCalls = 0;
  const runtime = new DesktopComputerRuntime({
    accessibility: {
      isTrusted: async () => true,
      ensureTrusted: async () => undefined,
      snapshot: async () => ({ status: "ok", observation }),
      perform: async () => undefined,
    },
    screenCapture: {
      isAuthorized: () => true,
      capture: async () => { throw new Error("capture should not run"); },
      latestFrame: () => null,
    },
    input: {
      keypress: async () => { inputCalls += 1; },
      type: async () => { inputCalls += 1; },
      click: async () => { inputCalls += 1; },
      move: async () => { inputCalls += 1; },
      drag: async () => { inputCalls += 1; },
      scroll: async () => { inputCalls += 1; },
    },
    ownership: () => "user-controlled",
    settleMs: 0,
  });
  const directory = options.workingDirectory ?? await mkdtemp(join(tmpdir(), "agentroam-ownership-"));
  const socketPath = join(directory, "ownership-relay.sock");
  const server = new ComputerRelayServer({ runtime, socketPath });
  await server.start();
  try {
    const client = new ComputerRelayClient({ socketPath, timeoutMs: 2_000 });
    const observed = await client.execute({ action: "observe" });
    let mutationError = null;
    try {
      await client.execute({ action: "keypress", keys: ["Enter"] });
    } catch (error) {
      mutationError = error;
    }
    return {
      passed: observed.source === "accessibility"
        && mutationError?.code === "desktop_controlled_by_user"
        && inputCalls === 0,
      observationSource: observed.source,
      mutationError: mutationError?.code ?? null,
      inputCalls,
    };
  } finally {
    await server.close();
    if (!options.workingDirectory) await rm(directory, { recursive: true, force: true });
  }
}

async function compileFixture(directory) {
  const source = join(root, "packages/desktop/scripts/computer-use-fixture.swift");
  const binary = join(directory, "computer-use-fixture");
  await execFileAsync("swiftc", ["-swift-version", "5", "-O", "-framework", "AppKit", source, "-o", binary], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return binary;
}

function launchFixture(binary, statusPath) {
  const child = spawn(binary, [statusPath], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`fixture readiness timed out: ${stderr}`)), 10_000);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.ready === true) {
            clearTimeout(timer);
            resolveReady(child);
            return;
          }
        } catch { /* wait for a readiness object */ }
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited before readiness (${code}): ${stderr}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopFixture(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.stdin?.end();
  child.kill("SIGTERM");
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

async function waitForRelayFixture(client, fixturePid, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastObservation = null;
  while (Date.now() < deadline) {
    try {
      lastObservation = await client.execute({ action: "observe" });
      if (lastObservation.source === "accessibility" && lastObservation.app?.pid === fixturePid) return;
    } catch {
      // The actual AgentLoop reports stable permission/protocol failures below.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `relay did not observe fixture ${fixturePid} through Accessibility (last source: ${lastObservation?.source ?? "none"})`,
  );
}

export async function runNativeFixtureProbe(binary, statusPath, options = {}) {
  const ownsFixture = !options.fixture;
  let fixture = options.fixture ?? null;
  const helperPath = join(root, "packages/desktop/assets/bin/desktop-input");
  const helper = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map();
  helper.stderr.on("data", (chunk) => { stderr += chunk; });
  helper.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      pending.delete(response.id);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    }
  });
  const rejectPending = (message) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    pending.clear();
  };
  helper.once("error", (error) => rejectPending(error.message));
  helper.once("exit", (code) => rejectPending(`desktop-input exited (${code}): ${stderr}`));
  const request = (command) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`desktop-input request timed out: ${command.op}`));
    }, 5_000);
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
    helper.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });

  try {
    fixture ??= await launchFixture(binary, statusPath);
    const trust = await request({ op: "check" });
    if (trust.trusted !== true) {
      return { passed: false, limitation: { error: "accessibility_denied", message: "direct helper is not Accessibility trusted" } };
    }
    const first = await request({ op: "ax_snapshot" });
    const observation = first.observation;
    if (first.ok !== true || first.status !== "ok" || observation?.app?.pid !== fixture.pid) {
      return {
        passed: false,
        limitation: {
          error: "fixture_not_frontmost",
          message: `frontmost app is ${observation?.app?.name ?? "unknown"}`,
        },
      };
    }
    const field = findNode(observation, "computer-fixture.text");
    const button = findNode(observation, "computer-fixture.press");
    const canvas = findNode(observation, "computer-fixture.canvas");
    if (!field || !button || !canvas?.bounds) throw new Error("fixture Accessibility identifiers are incomplete");

    const focus = await request({ op: "ax_action", revision: observation.revision, nodeId: field.id, action: "focus" });
    const typed = await request({
      op: "ax_text",
      revision: observation.revision,
      nodeId: field.id,
      text: "AgentRoam direct helper proof",
      replace: true,
    });
    const pressed = await request({ op: "ax_action", revision: observation.revision, nodeId: button.id, action: "press" });
    if (focus.ok !== true || typed.ok !== true || pressed.ok !== true) throw new Error("fixture AX action failed");

    const second = await request({ op: "ax_snapshot" });
    const stale = await request({ op: "ax_action", revision: observation.revision, nodeId: button.id, action: "press" });
    const refreshedCanvas = findNode(second.observation, "computer-fixture.canvas");
    if (!refreshedCanvas?.bounds) throw new Error("fixture canvas disappeared after refresh");
    const x = Math.round(refreshedCanvas.bounds.x + refreshedCanvas.bounds.width / 2);
    const y = Math.round(refreshedCanvas.bounds.y + refreshedCanvas.bounds.height / 2);
    const down = await request({ op: "down", x, y, button: "left", click: 1 });
    const up = await request({ op: "up", x, y, button: "left", click: 1 });
    if (down.ok !== true || up.ok !== true) throw new Error("fixture coordinate click failed");
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const state = JSON.parse(await readFile(statusPath, "utf8"));
    const effectsVerified = state.text === "AgentRoam direct helper proof"
      && state.pressCount === 1
      && state.canvasClickCount === 1;
    return {
      passed: effectsVerified && stale.ok === false && stale.code === "stale_observation",
      trusted: true,
      app: observation.app,
      coverage: observation.coverage,
      nodeCount: observation.nodes.length,
      identifiers: [field.identifier, button.identifier, canvas.identifier],
      staleError: stale.code ?? null,
      canvasPoint: { x, y },
      state,
      effectsVerified,
    };
  } finally {
    await stopChild(helper);
    if (ownsFixture) await stopFixture(fixture);
  }
}

export async function runLiveComputerSmoke() {
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), "agentroam-computer-smoke-"));
  const statusPath = join(directory, "fixture-state.json");
  let fixture = null;
  try {
    if (process.platform !== "darwin") {
      return { schemaVersion: 1, startedAt, outcome: "limited", limitation: { error: "unsupported_platform", message: process.platform } };
    }
    const binary = await compileFixture(directory);
    const { ComputerRelayClient } = await import("../packages/computer-use/src/index.ts");
    const client = new ComputerRelayClient({ timeoutMs: 2_000 });
    const initialStatus = await client.status();
    let nativeFixture;
    if (initialStatus.desktopLocked) {
      nativeFixture = { passed: false, limitation: { error: "desktop_locked", message: "native fixture probe skipped while locked" } };
    } else {
      fixture = await launchFixture(binary, statusPath);
      nativeFixture = await runNativeFixtureProbe(binary, statusPath, { fixture }).catch((error) => ({
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
      }));
      if (initialStatus.accessibility) await waitForRelayFixture(client, fixture.pid);
    }
    const fixtureBaseline = fixture ? JSON.parse(await readFile(statusPath, "utf8")) : null;
    const loop = await runComputerAgentLoop({ workingDirectory: directory });
    const ownership = await runOwnershipProbe({ workingDirectory: directory });
    let fixtureState = null;
    if (fixture) {
      fixtureState = JSON.parse(await readFile(statusPath, "utf8"));
    }
    const effectsVerified = loop.outcome === "passed"
      ? fixtureState?.text === FIXTURE_TEXT
        && fixtureState?.pressCount === (fixtureBaseline?.pressCount ?? 0) + 1
        && fixtureState?.canvasClickCount === (fixtureBaseline?.canvasClickCount ?? 0) + 1
      : null;
    const outcome = loop.outcome === "passed" && effectsVerified === true && ownership.passed
      && loop.approvals.length === 0 && !loop.publicPayloadLeaked
      ? "passed"
      : loop.outcome === "limited" ? "limited" : "failed";
    return {
      schemaVersion: 1,
      startedAt,
      outcome,
      relayStatus: loop.status ?? initialStatus,
      invocationPolicyVerified: loop.state.toolPolicyVerified,
      directAuthorizationVerified: loop.approvals.length === 0,
      transientObservationVerified: !loop.publicPayloadLeaked,
      actionSequence: loop.state.calls,
      screenshotDelivered: loop.state.screenshotDelivered,
      nativeFixture,
      fixtureState,
      effectsVerified,
      ownership,
      limitation: loop.limitation,
      failure: loop.failure,
    };
  } finally {
    await stopFixture(fixture);
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const requireFull = process.argv.includes("--require-full");
  try {
    const result = await runLiveComputerSmoke();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.outcome === "failed" || (requireFull && result.outcome !== "passed")) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      startedAt: new Date().toISOString(),
      outcome: "failed",
      failure: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
