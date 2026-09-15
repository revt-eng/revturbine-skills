// @revturbine-graph gref:2e674bf3a3a4b1d49ae0
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runner = process.env.AGENT_EVAL_COMMAND;
if (!runner) {
  console.error('AGENT_EVAL_COMMAND is required; outcome evals need a protected, budgeted agent runner.');
  process.exit(2);
}
const contracts = JSON.parse(readFileSync(join(root, 'evals', 'outcome-contracts.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'revturbine-skill-evals-'));
try {
  for (const contract of contracts) {
    const output = execFileSync(runner, ['--contract', JSON.stringify(contract), '--workspace', scratch], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(output);
    const missing = contract.assertions.filter((assertion) => result.assertions?.[assertion] !== true);
    if (missing.length) throw new Error(`${contract.skill}: failed assertions: ${missing.join(', ')}`);
  }
  console.log(`outcome-evals: ${contracts.length} outcome-bearing skills passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
