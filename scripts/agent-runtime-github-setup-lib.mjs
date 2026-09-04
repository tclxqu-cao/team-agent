import { spawn } from "node:child_process";

export const AGENT_RUNTIME_ENVIRONMENTS = [
  "agent-runtime-smoke-codex",
  "agent-runtime-smoke-claude",
  "agent-runtime-smoke-opencode",
  "agent-runtime-repair",
  "agent-runtime-publish-npm",
  "agent-runtime-publish-gitee",
];

export const AGENT_RUNTIME_LABELS = [
  ["automation", "1D76DB", "Created and maintained by repository automation"],
  ["agent-runtime-upgrade", "0E8A16", "Tracks a stable Agent runtime upgrade"],
  ["agent-runtime-active", "FBCA04", "The only active Agent runtime candidate"],
  ["agent-runtime-candidate", "5319E7", "Automated Agent runtime candidate pull request"],
  ["agent-runtime-gitee-pending", "D93F0B", "npm preview is waiting for Gitee synchronization"],
  ["agent-runtime-soak", "006B75", "Candidate is in the 24-hour cross-platform soak"],
  ["agent-runtime-codex", "1D76DB", "Codex runtime upgrade"],
  ["agent-runtime-claude", "D4C5F9", "Claude Agent SDK runtime upgrade"],
  ["agent-runtime-opencode", "BFDADC", "OpenCode runtime upgrade"],
  ["agent-runtime-repair", "C2E0C6", "Bounded Codex compatibility repair"],
  ["needs-human", "B60205", "Automation stopped and requires maintainer action"],
  ["promotion-hold", "E99695", "Blocks latest promotion without stopping validation"],
].map(([name, color, description]) => ({ name, color, description }));

export const AGENT_RUNTIME_VARIABLES = {
  GITEE_OWNER: "caoqu",
  GITEE_REPOSITORY: "team-agent",
  GITEE_USERNAME: "oauth2",
};

export const AGENT_RUNTIME_REQUIRED_SECRETS = {
  "agent-runtime-smoke-codex": ["PROVIDER_API_KEY"],
  "agent-runtime-smoke-claude": ["PROVIDER_API_KEY"],
  "agent-runtime-smoke-opencode": ["PROVIDER_API_KEY", "OPENCODE_CONFIG_JSON"],
  "agent-runtime-repair": ["OPENAI_API_KEY"],
  "agent-runtime-publish-npm": ["NPM_TOKEN"],
  "agent-runtime-publish-gitee": ["GITEE_TOKEN"],
};

export function buildGithubSetupPlan(options) {
  const repository = parseRepository(options.repository);
  const branch = options.branch ?? "master";
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`invalid default branch ${branch}`);
  const variables = {
    ...AGENT_RUNTIME_VARIABLES,
    ...(options.variables ?? {}),
  };
  return {
    schemaVersion: 1,
    repository,
    branch,
    environments: [...AGENT_RUNTIME_ENVIRONMENTS],
    labels: AGENT_RUNTIME_LABELS.map((label) => ({ ...label })),
    variables,
    requiredStatusChecks: ["agent-runtime-candidate-check"],
    requiredSecrets: structuredClone(AGENT_RUNTIME_REQUIRED_SECRETS),
  };
}

export async function applyGithubSetup(plan, options = {}) {
  const run = options.run ?? runGh;
  const endpoint = `repos/${plan.repository}`;
  const applied = [];
  for (const environment of plan.environments) {
    await run(["api", "--method", "PUT", `${endpoint}/environments/${environment}`, "--input", "-"], { input: "{}" });
    applied.push(`environment:${environment}`);
  }
  for (const label of plan.labels) {
    await run(["label", "create", label.name, "--repo", plan.repository, "--color", label.color, "--description", label.description, "--force"]);
    applied.push(`label:${label.name}`);
  }
  for (const [name, value] of Object.entries(plan.variables)) {
    await run(["variable", "set", name, "--repo", plan.repository, "--body", value]);
    applied.push(`variable:${name}`);
  }
  await run(["api", "--method", "PUT", `${endpoint}/actions/permissions`, "--input", "-"], {
    input: JSON.stringify({ enabled: true, allowed_actions: "all" }),
  });
  applied.push("actions:enabled");
  await run(["api", "--method", "PUT", `${endpoint}/actions/permissions/workflow`, "--input", "-"], {
    input: JSON.stringify({ default_workflow_permissions: "write", can_approve_pull_request_reviews: true }),
  });
  applied.push("actions:workflow-write");
  await run(["api", "--method", "PUT", `${endpoint}/branches/${encodeURIComponent(plan.branch)}/protection`, "--input", "-"], {
    input: JSON.stringify({
      required_status_checks: { strict: true, contexts: plan.requiredStatusChecks },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      required_conversation_resolution: true,
    }),
  });
  applied.push(`branch-protection:${plan.branch}`);
  return { repository: plan.repository, applied };
}

export async function collectGithubSetupState(plan, options = {}) {
  const run = options.run ?? runGh;
  const endpoint = `repos/${plan.repository}`;
  const repository = await runJson(["repo", "view", plan.repository, "--json", "nameWithOwner,defaultBranchRef,visibility"], run);
  const actions = await runJson(["api", `${endpoint}/actions/permissions`], run);
  const workflow = await runJson(["api", `${endpoint}/actions/permissions/workflow`], run);
  const environmentResponse = await runJson(["api", `${endpoint}/environments`, "--paginate"], run);
  const labels = await runJson(["label", "list", "--repo", plan.repository, "--limit", "100", "--json", "name,color,description"], run);
  const variables = await runJson(["variable", "list", "--repo", plan.repository, "--json", "name,value"], run);
  const protection = await runJson(["api", `${endpoint}/branches/${encodeURIComponent(plan.branch)}/protection`], run);
  const secrets = {};
  for (const environment of plan.environments) {
    secrets[environment] = await runJson(["secret", "list", "--repo", plan.repository, "--env", environment, "--json", "name"], run);
  }
  return { repository, actions, workflow, environments: environmentResponse.environments ?? [], labels, variables, protection, secrets };
}

export function evaluateGithubSetup(plan, state) {
  const missing = [];
  if (state.repository?.nameWithOwner !== plan.repository) missing.push(`repository:${plan.repository}`);
  if (state.repository?.defaultBranchRef?.name !== plan.branch) missing.push(`default-branch:${plan.branch}`);
  if (state.actions?.enabled !== true || state.actions?.allowed_actions !== "all") missing.push("actions:enabled-all");
  if (state.workflow?.default_workflow_permissions !== "write" || state.workflow?.can_approve_pull_request_reviews !== true) {
    missing.push("actions:workflow-write-and-pr");
  }
  const environmentNames = new Set((state.environments ?? []).map((item) => item.name));
  for (const name of plan.environments) if (!environmentNames.has(name)) missing.push(`environment:${name}`);
  const labelNames = new Set((state.labels ?? []).map((item) => item.name));
  for (const label of plan.labels) if (!labelNames.has(label.name)) missing.push(`label:${label.name}`);
  const variables = new Map((state.variables ?? []).map((item) => [item.name, item.value]));
  for (const [name, value] of Object.entries(plan.variables)) if (variables.get(name) !== value) missing.push(`variable:${name}`);
  const contexts = new Set(state.protection?.required_status_checks?.contexts ?? []);
  if (state.protection?.required_status_checks?.strict !== true) missing.push("branch-protection:strict");
  for (const context of plan.requiredStatusChecks) if (!contexts.has(context)) missing.push(`status-check:${context}`);
  if (state.protection?.required_conversation_resolution?.enabled !== true) missing.push("branch-protection:conversation-resolution");
  for (const [environment, required] of Object.entries(plan.requiredSecrets)) {
    const names = new Set((state.secrets?.[environment] ?? []).map((item) => item.name));
    for (const name of required) if (!names.has(name)) missing.push(`secret:${environment}/${name}`);
  }
  return { ready: missing.length === 0, missing };
}

export function parseRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`repository must be OWNER/REPO: ${String(value)}`);
  }
  return value;
}

async function runJson(args, run) {
  const result = await run(args);
  return JSON.parse(result.stdout || "null");
}

async function runGh(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(options.input ?? "");
  });
}
