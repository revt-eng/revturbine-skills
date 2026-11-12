#!/usr/bin/env node
// Fails when a workflow file runs LLM inference or reads a production credential.
// EP-1747 decision 3 (2026-11-12) replaced the ST-1376 ban on database, browser and Docker suites:
// CI runs those on our CodeBuild runners through the shared check-level workflow (ci-level.yml).
// QA runs as HELM agents, and checks never touch production data. Comment lines are ignored.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = ".github/workflows";
const banned = [
  /uses:\s*anthropics?\//i, /claude-code/i, /secrets\.(?:ANTHROPIC|OPENAI)_API_KEY/i,
  /secrets\.(?:PROD_DATABASE_URL|STRIPE_SECRET_KEY\w*)\b/,
];
const problems = [];
for (const file of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
  const lines = readFileSync(path.join(dir, file), "utf8").split(/\r?\n/).filter(line => !/^\s*#/.test(line));
  for (const pattern of banned) if (lines.some(line => pattern.test(line))) problems.push(`${dir}/${file} matches banned pattern ${pattern}`);
}
if (problems.length) {
  console.error(`ci-guards: workflows may not run LLM inference or read production credentials (EP-1747).\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("ci-guards: ok");
