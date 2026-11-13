/**
 * EP-1747 (ST-1749): the workflow guard enforces the shared workflow policy,
 * scripts/workflow-policy.mjs, a generated copy of the devkit's master. No LLM
 * inference in any workflow; no production credential in a workflow a pull
 * request triggers, and elsewhere only inside a job that declares `environment:`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkflows } from '../scripts/ci-guards.mjs';

const script = fileURLToPath(new URL('../scripts/ci-guards.mjs', import.meta.url));
const workflows = fileURLToPath(new URL('../.github/workflows', import.meta.url));

function withWorkflows(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-guards-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pr = (line) => `on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: x\n        env:\n${line}\n`;
const dispatch = (environment) => `on:\n  workflow_dispatch:\njobs:\n  a:\n${environment}    steps:\n      - run: x\n        env:\n          DATABASE_URL: \${{ secrets.DATABASE_URL }}\n`;

test('LLM inference is banned in every workflow', () => {
  for (const line of [
    '      - uses: anthropics/claude-code-action@v1',
    '          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
    '          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY_CI }}',
  ]) {
    const text = `on: workflow_dispatch\njobs:\n  a:\n    environment: production\n    steps:\n${line}\n`;
    assert.match(withWorkflows({ 'a.yml': text }, checkWorkflows).join('\n'), /\[inference\]/, line);
  }
});

test('production credentials are banned in a pull-request workflow', () => {
  for (const line of [
    '          DATABASE_URL: ${{ secrets.PROD_DATABASE_URL }}',
    '          STRIPE: ${{ secrets.STRIPE_SECRET_KEY }}',
    '          NEON_API_KEY: ${{ secrets.NEON_API_KEY }}',
    "          DATABASE_URL: ${{ secrets['POSTGRES_URL'] }}",
  ]) assert.match(withWorkflows({ 'a.yml': pr(line) }, checkWorkflows).join('\n'), /a\.yml:8 \[production-credential\]/, line);
  assert.deepEqual(withWorkflows({ 'a.yml': pr('          TOKEN: ${{ secrets.REVTURBINE_GIT_TOKEN }}') }, checkWorkflows), []);
});

test('outside a pull-request workflow a production credential is allowed only in a job that declares an environment', () => {
  assert.deepEqual(withWorkflows({ 'a.yml': dispatch('    environment: production\n') }, checkWorkflows), []);
  const problems = withWorkflows({ 'a.yml': dispatch('') }, checkWorkflows);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\/a\.yml:8 \[production-credential\] DATABASE_URL is read outside a job that declares an environment: DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}$/);
});

test('comment lines are ignored, so a workflow can say why a step is absent', () => {
  assert.deepEqual(withWorkflows({ 'a.yml': 'on: pull_request\n# no claude-code here, and no secrets.PROD_DATABASE_URL\njobs: {}\n' }, checkWorkflows), []);
});

test("this repository's workflows pass, and the policy is the devkit's generated copy", () => {
  assert.deepEqual(checkWorkflows(workflows), []);
  assert.match(readFileSync(new URL('../scripts/workflow-policy.mjs', import.meta.url), 'utf8'),
    /^\/\/ GENERATED from revt-eng\/revturbine-devkit scripts\/workflow-policy\.mjs \(v\d+\.\d+\.\d+\)\. Do not edit here:/);
});

test('the command fails on a breaking workflow and passes a clean one', () => {
  withWorkflows({ 'clean.yml': 'on: pull_request\njobs:\n  a:\n    steps:\n      - run: npm test\n' }, (dir) => {
    const clean = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /ci-guards: ok/);
    writeFileSync(path.join(dir, 'inference.yaml'), 'on: push\njobs:\n  a:\n    steps:\n      - uses: anthropics/claude-code-action@v1\n');
    const failed = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /inference\.yaml:5 \[inference\]/);
    assert.doesNotMatch(failed.stderr, /clean\.yml/);
  });
});
