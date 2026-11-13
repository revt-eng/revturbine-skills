#!/usr/bin/env node
// Fails when a workflow file breaks the shared workflow policy, scripts/workflow-policy.mjs: a generated copy of the
// devkit's master (edit it there; `pnpm sync:copies` refreshes this one). No workflow runs LLM inference (QA runs as
// HELM agents); no workflow that a pull request or the merge queue triggers reads a production credential, and any
// other reads one only inside a job that declares `environment:`. Comment lines are ignored.
// EP-1747 decision 3 (2026-11-12) replaced the ST-1376 ban on database, browser and Docker suites:
// CI runs those on our CodeBuild runners through the shared check-level workflow (ci-level.yml).
// Usage: node scripts/ci-guards.mjs [workflow directory]   (default .github/workflows). Tests: tests/ci-guards.test.mjs.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkflowPolicy } from "./workflow-policy.mjs";

/** Problems across every .yml/.yaml file in `dir`, one string each. */
export function checkWorkflows(dir = ".github/workflows") {
  const problems = [];
  for (const file of readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort())
    for (const f of checkWorkflowPolicy(readFileSync(path.join(dir, file), "utf8")))
      problems.push(`${path.join(dir, file).split(path.sep).join("/")}:${f.line} [${f.id}] ${f.why}: ${f.text}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkWorkflows(process.argv[2]);
  if (problems.length) {
    console.error(`ci-guards: a workflow breaks the workflow policy (scripts/workflow-policy.mjs, EP-1747).\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("ci-guards: ok");
}
