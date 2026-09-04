#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyGithubSetup,
  buildGithubSetupPlan,
  collectGithubSetupState,
  evaluateGithubSetup,
} from "./agent-runtime-github-setup-lib.mjs";

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const command = args[0];
  const repository = option(args, "--repo");
  if (!repository) throw new Error("--repo OWNER/REPO is required");
  const plan = buildGithubSetupPlan({
    repository,
    branch: option(args, "--branch") ?? "master",
    variables: {
      GITEE_OWNER: option(args, "--gitee-owner") ?? "caoqu",
      GITEE_REPOSITORY: option(args, "--gitee-repo") ?? "team-agent",
      GITEE_USERNAME: option(args, "--gitee-username") ?? "oauth2",
    },
  });
  if (command === "plan") return print(plan);
  if (command === "apply") return print(await applyGithubSetup(plan, dependencies));
  if (command === "audit") {
    const state = await collectGithubSetupState(plan, dependencies);
    const result = evaluateGithubSetup(plan, state);
    print({ repository: plan.repository, ...result });
    if (!result.ready) process.exitCode = 1;
    return result;
  }
  throw new Error("usage: configure-agent-runtime-github.mjs plan|apply|audit --repo OWNER/REPO [--branch master]");
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return value;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
