#!/usr/bin/env node
// Lists or runs the suites that no longer run in GitHub Actions (ST-1376).
// Usage: node scripts/local-suites.mjs [name...]   (no args lists the registry)
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(path.join(root, "local-suites.json"), "utf8"));
const names = process.argv.slice(2);

if (!names.length) {
  for (const s of registry.suites) console.log(`${s.name}\t[${s.category}]\t${s.command}\n    requires: ${s.requires.join(", ")}\n    covers: ${s.covers}`);
  process.exit(0);
}

let sha = "nogit";
try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch {}
const logDir = path.join(root, ".cache", "local-suites", sha);
mkdirSync(logDir, { recursive: true });

let failed = 0;
for (const name of names) {
  const suite = registry.suites.find(s => s.name === name);
  if (!suite) { console.error(`unknown suite: ${name}`); failed++; continue; }
  const log = path.join(logDir, `${name}.log`);
  const fd = openSync(log, "w");
  const started = Date.now();
  const result = spawnSync(suite.command, { cwd: root, shell: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const code = result.status ?? 1;
  if (code !== 0) failed++;
  console.log(`${name}\texit ${code}\t${((Date.now() - started) / 1000).toFixed(1)}s\t${log}`);
}
process.exit(failed ? 1 : 0);
