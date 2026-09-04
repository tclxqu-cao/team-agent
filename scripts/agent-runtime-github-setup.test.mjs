import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNTIME_ENVIRONMENTS,
  AGENT_RUNTIME_LABELS,
  applyGithubSetup,
  buildGithubSetupPlan,
  evaluateGithubSetup,
  parseRepository,
} from "./agent-runtime-github-setup-lib.mjs";

test("builds the complete GitHub control-plane plan", () => {
  const plan = buildGithubSetupPlan({ repository: "caoqu/team-agent" });
  assert.equal(plan.branch, "master");
  assert.deepEqual(plan.environments, AGENT_RUNTIME_ENVIRONMENTS);
  assert.deepEqual(plan.labels, AGENT_RUNTIME_LABELS);
  assert.deepEqual(plan.requiredStatusChecks, ["agent-runtime-candidate-check"]);
  assert.deepEqual(plan.requiredSecrets["agent-runtime-smoke-opencode"], ["PROVIDER_API_KEY", "OPENCODE_CONFIG_JSON"]);
});

test("rejects malformed repository coordinates", () => {
  assert.throws(() => parseRepository("team-agent"), /OWNER\/REPO/);
  assert.throws(() => parseRepository("caoqu/team-agent/extra"), /OWNER\/REPO/);
});

test("applies every resource idempotently through fixed gh commands", async () => {
  const plan = buildGithubSetupPlan({ repository: "caoqu/team-agent" });
  const calls = [];
  const result = await applyGithubSetup(plan, { run: async (args, options) => {
    calls.push({ args, input: options?.input });
    return { stdout: "", stderr: "" };
  } });
  assert.equal(result.applied.length, 24);
  assert.equal(calls.filter(({ args }) => args[0] === "label").length, 12);
  assert.equal(calls.filter(({ args }) => args.some((value) => value.endsWith("/environments/agent-runtime-repair"))).length, 1);
  assert.equal(calls.filter(({ args }) => args[0] === "variable").length, 3);
  const protection = calls.find(({ args }) => args.some((value) => value.endsWith("/branches/master/protection")));
  assert.deepEqual(JSON.parse(protection.input).required_status_checks, { strict: true, contexts: ["agent-runtime-candidate-check"] });
});

test("audit reports only missing repository contracts and secrets", () => {
  const plan = buildGithubSetupPlan({ repository: "caoqu/team-agent" });
  const state = completeState(plan);
  assert.deepEqual(evaluateGithubSetup(plan, state), { ready: true, missing: [] });
  state.environments = state.environments.filter(({ name }) => name !== "agent-runtime-repair");
  state.secrets["agent-runtime-smoke-opencode"] = [{ name: "PROVIDER_API_KEY" }];
  state.protection.required_status_checks.contexts = [];
  assert.deepEqual(evaluateGithubSetup(plan, state), {
    ready: false,
    missing: [
      "environment:agent-runtime-repair",
      "status-check:agent-runtime-candidate-check",
      "secret:agent-runtime-smoke-opencode/OPENCODE_CONFIG_JSON",
    ],
  });
});

function completeState(plan) {
  return {
    repository: { nameWithOwner: plan.repository, defaultBranchRef: { name: plan.branch } },
    actions: { enabled: true, allowed_actions: "all" },
    workflow: { default_workflow_permissions: "write", can_approve_pull_request_reviews: true },
    environments: plan.environments.map((name) => ({ name })),
    labels: plan.labels.map(({ name }) => ({ name })),
    variables: Object.entries(plan.variables).map(([name, value]) => ({ name, value })),
    protection: {
      required_status_checks: { strict: true, contexts: [...plan.requiredStatusChecks] },
      required_conversation_resolution: { enabled: true },
    },
    secrets: Object.fromEntries(Object.entries(plan.requiredSecrets).map(([environment, names]) => [
      environment,
      names.map((name) => ({ name })),
    ])),
  };
}
