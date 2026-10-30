#!/usr/bin/env node
// Fails when a workflow file reintroduces a pattern banned from GitHub Actions (ST-1376):
// PGlite, browsers (Playwright), Tinybird Local, docker services, staging DB, LLM/QA actions.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = ".github/workflows";
const banned = [
  /@electric-sql\/pglite/i, /pglite/i, /playwright/i, /test-storybook/i, /tinybird-local/i, /tinybirdco\//i,
  /^\s*services:/m, /test:staging-db/i, /anthropics?\//i, /claude-code/i, /\be2e[-_]tenant/i, /test:e2e/i,
];
const problems = [];
for (const file of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
  const text = readFileSync(path.join(dir, file), "utf8");
  for (const pattern of banned) if (pattern.test(text)) problems.push(`${dir}/${file} matches banned pattern ${pattern}`);
}
if (problems.length) {
  console.error(`ci-guards: GitHub Actions is for mocked unit tests and static checks only (ST-1376).\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("ci-guards: ok");
